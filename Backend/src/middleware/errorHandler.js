import { error as logError, extractContextFromReq } from '../utils/logger.js';

function normalizeError(err) {
  if (!err) return { errorMessage: 'Unknown error' };
  if (err instanceof Error) {
    return { errorName: err.name, errorMessage: err.message, stack: err.stack };
  }
  if (typeof err === 'object') {
    return {
      errorName: err.name ? String(err.name) : undefined,
      errorMessage: err.message ? String(err.message) : String(err),
      stack: err.stack ? String(err.stack) : undefined,
      ...err
    };
  }
  return { errorMessage: String(err) };
}

const REDACT_KEYS = new Set([
  'password',
  'pass',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'cookie',
  'cookies',
  'session',
  'jwt',
  'secret',
  'apiKey',
  'api_key'
]);

function redact(value, depth = 0) {
  if (depth > 4) return '[Max depth reached]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
      continue;
    }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

export function errorHandler(err, req, res, next) {
  const statusCode = Number(err?.statusCode || err?.status || 500);
  const ctx = extractContextFromReq(req);

  logError(
    'HTTP',
    'Unhandled exception',
    {
      ...normalizeError(err),
      statusCode,
      params: req.params,
      query: req.query,
      body: redact(req.body),
    },
    ctx
  );

  // If headers were already sent, delegate to default Express handler
  if (res.headersSent) {
    return next(err);
  }

  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  res.status(statusCode).json({
    message: isProd ? 'Server error' : (err?.message || 'Server error'),
    requestId: ctx.requestId || req.requestId
  });
}

