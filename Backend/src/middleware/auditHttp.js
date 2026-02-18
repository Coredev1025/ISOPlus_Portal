import { logAuditTrail } from '../utils/auditLogger.js';
import { extractContextFromReq } from '../utils/logger.js';

const REDACT_KEYS = new Set([
  'password',
  'newPassword',
  'oldPassword',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'auth',
  'secret',
  'clientSecret',
  'apiKey'
]);

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length > 2000 ? `${value.slice(0, 1997)}...` : value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (depth >= 3) {
    return '[Truncated]';
  }

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }

  const result = {};
  for (const [key, v] of Object.entries(value)) {
    if (REDACT_KEYS.has(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redact(v, depth + 1);
    }
  }
  return result;
}

function headerValue(headers, key) {
  if (!headers) return undefined;
  return headers[key] ?? headers[key.toLowerCase()];
}

function getRoutePattern(req) {
  const baseUrl = req.baseUrl || '';
  const routePath = req.route?.path || '';
  if (baseUrl && routePath) return `${baseUrl}${routePath}`;
  return undefined;
}

function deriveUserAction({ method, routePattern, urlPath }) {
  if (!method) return undefined;
  const m = method.toUpperCase();

  // Prefer stable route patterns (no IDs) when available
  const rp = routePattern || '';

  if (m === 'POST' && rp === '/api/pdf/:workspaceId/:boardId/monthly-statement') {
    return 'Generate Monthly Statement';
  }

  if (m === 'GET' && rp === '/api/export/:workspaceId/:boardId/monthly-statement-csv') {
    return 'View Monthly Statement Data (CSV)';
  }

  return undefined;
}

export function auditHttpMiddleware(req, res, next) {
  const startHrTime = process.hrtime.bigint();

  res.on('finish', async () => {
    try {
      const url = req.originalUrl || req.url || '';
      const urlPath = url.split('?')[0];
      const method = req.method || '';
      const methodUpper = method.toUpperCase();

      // Skip noisy / internal endpoints
      if (
        urlPath.startsWith('/api/healthcheck') ||
        urlPath.startsWith('/api/log') ||
        urlPath.startsWith('/api/queues') ||
        urlPath.startsWith('/api/audit') || // Avoid self-referential audit logging
        urlPath.startsWith('/api/sync/workspaces/status/') || // Polling endpoint (very noisy)
        methodUpper === 'OPTIONS' // Never audit CORS preflights
      ) {
        return;
      }

      const ctx = extractContextFromReq(req);

      // Only log when we can associate with a workspace; this matches the user request
      const workspaceId =
        ctx.workspaceId ||
        req.params?.workspaceId ||
        req.query?.workspaceId ||
        req.body?.workspaceId;

      if (!workspaceId) {
        return;
      }

      const endHrTime = process.hrtime.bigint();
      const durationMs = Number(endHrTime - startHrTime) / 1_000_000;

      const statusCode = res.statusCode;
      const success = statusCode < 400;

      const boardId =
        ctx.boardId ||
        req.params?.boardId ||
        req.query?.boardId ||
        req.body?.boardId;

      const routePattern = getRoutePattern(req);
      const httpAction = `HTTP ${method} ${urlPath}`;

      const explicitUserAction =
        ctx.userAction ||
        headerValue(req.headers, 'x-user-action') ||
        headerValue(req.headers, 'x-app-action') ||
        headerValue(req.headers, 'x-audit-action') ||
        req.body?.userAction ||
        req.body?.action;

      const derivedUserAction = deriveUserAction({ method, routePattern, urlPath });

      const userAction = (explicitUserAction && String(explicitUserAction).trim()) || derivedUserAction;
      const action = userAction || httpAction;

      // For read-only requests, only audit when we have a meaningful user action.
      if (['GET', 'HEAD'].includes(methodUpper) && !userAction) {
        return;
      }

      const detail = {
        userAction: userAction || undefined,
        httpAction,
        routePattern,
        statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        requestId: ctx.requestId,
        userId: ctx.userId,
        userEmail: ctx.email,
        userRole: ctx.userRole,
        workspaceId,
        boardId
      };

      const metadata = {
        params: redact(req.params),
        query: redact(req.query),
        // Don't log bodies for GET/HEAD to reduce noise
        ...(method && !['GET', 'HEAD'].includes(method.toUpperCase())
          ? { body: redact(req.body) }
          : {})
      };

      await logAuditTrail({
        workspaceId: String(workspaceId),
        boardId: boardId ? String(boardId) : undefined,
        action,
        detail,
        req,
        success,
        statusCode,
        category: userAction ? 'APP' : 'HTTP',
        entityType: boardId ? 'Board' : 'Workspace',
        entityId: boardId || workspaceId,
        metadata
      });
    } catch (err) {
      // Logging failures are intentionally swallowed to avoid impacting responses
    }
  });

  next();
}

