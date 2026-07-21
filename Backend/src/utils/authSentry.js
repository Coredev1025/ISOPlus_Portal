import * as Sentry from '@sentry/node';

const MAX_STRING = 500;
const REDACT_KEYS = new Set([
  'password',
  'pass',
  'token',
  'access_token',
  'accessToken',
  'refresh_token',
  'authorization',
  'client_secret',
  'clientSecret',
  'cookie',
  'cookies',
  'session',
  'jwt',
  'secret',
  'ticket',
  'code',
]);

function truncate(value) {
  if (typeof value !== 'string') return value;
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
}

function sanitizeValue(value, depth = 0) {
  if (value == null) return value;
  if (depth > 3) return '[Max depth]';
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: truncate(value.message), code: value.code };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeValue(v, depth + 1));
  if (typeof value !== 'object') return truncate(String(value));

  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (REDACT_KEYS.has(key) || REDACT_KEYS.has(key.toLowerCase())) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = sanitizeValue(raw, depth + 1);
  }
  return out;
}

function requestMeta(req) {
  if (!req || typeof req !== 'object') return {};
  return {
    requestId: req.requestId || req.headers?.['x-request-id'] || undefined,
    ip: req.ip || req.headers?.['x-forwarded-for'] || undefined,
    httpMethod: req.method || undefined,
    path: req.originalUrl || req.url || undefined,
  };
}

function toIssueLevel(level) {
  if (level === 'warn' || level === 'warning') return 'warning';
  if (level === 'fatal') return 'fatal';
  if (level === 'error') return 'error';
  if (level === 'info' || level === 'debug') return level;
  return 'warning';
}

function applyAuthScope(scope, { authMethod, stage, data, req, email, userId }) {
  scope.setTag('feature', 'auth');
  if (authMethod) scope.setTag('auth_method', authMethod);
  if (stage) scope.setTag('auth_stage', stage);

  const meta = requestMeta(req);
  if (meta.requestId) scope.setTag('request_id', String(meta.requestId));
  if (email || userId) {
    scope.setUser({
      id: userId ? String(userId) : undefined,
      email: email || undefined,
      ip_address: meta.ip,
    });
  }

  scope.setContext('auth', sanitizeValue({
    authMethod,
    stage,
    ...meta,
    ...data,
  }));
}

/**
 * Record a successful/neutral auth pipeline step (breadcrumb + Sentry log).
 * Call this at every stage so a later failure still has a full trail.
 */
export function authStep(req, { authMethod, stage, message, data = {}, email, userId } = {}) {
  if (!Sentry.isInitialized?.()) return;

  const body = sanitizeValue({
    feature: 'auth',
    authMethod,
    stage,
    email,
    userId,
    ...requestMeta(req),
    ...data,
  });

  Sentry.addBreadcrumb({
    category: 'auth',
    type: 'info',
    level: 'info',
    message: message || `${authMethod}:${stage}`,
    data: body,
  });

  Sentry.logger?.info?.(message || `auth step: ${authMethod} / ${stage}`, body);
}

/**
 * Record an auth failure as a Sentry Issue + log + error breadcrumb.
 */
export function authFailure(req, {
  authMethod,
  stage,
  message,
  reason,
  httpStatus,
  upstreamStatus,
  error: err,
  data = {},
  email,
  userId,
  level = 'warning',
} = {}) {
  if (!Sentry.isInitialized?.()) return;

  const payload = sanitizeValue({
    ...data,
    reason: reason || message,
    httpStatus,
    upstreamStatus,
    email,
    userId,
  });

  Sentry.addBreadcrumb({
    category: 'auth',
    type: 'error',
    level: 'error',
    message: message || `${authMethod}:${stage}`,
    data: { authMethod, stage, ...payload, ...requestMeta(req) },
  });

  const logAttrs = {
    feature: 'auth',
    authMethod,
    stage,
    ...requestMeta(req),
    ...payload,
  };
  const logLevel = level === 'error' || level === 'fatal' ? 'error' : 'warn';
  (Sentry.logger?.[logLevel] ?? Sentry.logger?.error)?.(message, logAttrs);

  Sentry.withScope((scope) => {
    applyAuthScope(scope, { authMethod, stage, data: payload, req, email, userId });
    scope.setLevel(toIssueLevel(level));
    if (httpStatus != null) scope.setTag('http_status', String(httpStatus));
    if (upstreamStatus != null) scope.setTag('upstream_status', String(upstreamStatus));

    if (err instanceof Error) {
      Sentry.captureException(err);
      return;
    }
    Sentry.captureMessage(message || `Auth failure: ${authMethod}/${stage}`, toIssueLevel(level));
  });
}

/**
 * Record successful auth completion (breadcrumb + log only — no Issue noise).
 */
export function authSuccess(req, { authMethod, message, data = {}, email, userId } = {}) {
  authStep(req, {
    authMethod,
    stage: 'success',
    message: message || `Auth success: ${authMethod}`,
    data,
    email,
    userId,
  });
}
