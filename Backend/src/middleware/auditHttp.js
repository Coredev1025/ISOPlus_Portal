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

function titleCaseWords(str) {
  return String(str)
    .split(/\s+/g)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function humanizeWriteAction({ method, routePattern, urlPath }) {
  const m = (method || '').toUpperCase();
  if (!m || ['GET', 'HEAD', 'OPTIONS'].includes(m)) return undefined;

  const input = routePattern || urlPath || '';
  if (!input) return undefined;

  // Strip query string & leading /api
  const path = String(input).split('?')[0].replace(/^\/api\//, '/');

  // Prefer last stable segment
  const segments = path
    .split('/')
    .filter(Boolean)
    .filter((s) => !s.startsWith(':')); // drop params from route patterns

  if (!segments.length) return undefined;
  const last = segments[segments.length - 1];

  const words = String(last)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!words) return undefined;

  // If the endpoint already contains an action verb (update/generate/etc), keep it.
  const verbPrefix =
    m === 'POST' ? '' : m === 'PUT' || m === 'PATCH' ? 'Update ' : m === 'DELETE' ? 'Delete ' : '';

  return titleCaseWords(`${verbPrefix}${words}`.trim());
}

function deriveUserAction({ method, routePattern, urlPath }) {
  if (!method) return undefined;
  const m = method.toUpperCase();

  // Prefer stable route patterns (no IDs) when available
  const rp = routePattern || '';

  if (m === 'POST' && rp === '/api/age-care/:workspaceId/:boardId/update-variables-participants-service') {
    return 'Update Participants Service variables';
  }

  if (m === 'POST' && rp === '/api/age-care/:workspaceId/:boardId/update-variables-masterplan') {
    return 'Update Master Plan variables';
  }

  if (m === 'POST' && rp === '/api/pdf/:workspaceId/:boardId/monthly-statement') {
    return 'Generate Monthly Statement';
  }

  if (m === 'GET' && rp === '/api/export/:workspaceId/:boardId/monthly-statement-csv') {
    return 'View Monthly Statement Data (CSV)';
  }

  return undefined;
}

function getBodyItemId(req) {
  const itemId =
    req?.body?.itemId ||
    req?.body?.id ||
    req?.body?.items?.[0]?.id ||
    req?.body?.items?.[0]?.itemId;
  return itemId ? String(itemId) : undefined;
}

function buildAuditDetailMessage({ success, statusCode, durationMs, itemId }) {
  const statusLabel = success ? 'OK' : 'FAILED';
  const parts = [statusLabel];
  if (itemId) parts.push(`item=${itemId}`);
  if (typeof statusCode === 'number') parts.push(`status=${statusCode}`);
  if (typeof durationMs === 'number') parts.push(`durationMs=${Math.round(durationMs * 100) / 100}`);
  return parts.join(' ');
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

      const explicitUserAction =
        ctx.userAction ||
        headerValue(req.headers, 'x-user-action') ||
        headerValue(req.headers, 'x-app-action') ||
        headerValue(req.headers, 'x-audit-action') ||
        req.body?.userAction ||
        req.body?.action;

      const derivedUserAction = deriveUserAction({ method, routePattern, urlPath });

      const userAction = (explicitUserAction && String(explicitUserAction).trim()) || derivedUserAction;
      const fallbackAction = !userAction ? humanizeWriteAction({ method, routePattern, urlPath }) : undefined;
      const action = userAction || fallbackAction;

      // Never store "HTTP {method} {path}" as action.
      // For read-only requests, only audit when we have an explicit/known action mapping.
      if (['GET', 'HEAD'].includes(methodUpper) && !userAction) {
        return;
      }

      if (!action) {
        return;
      }

      const itemId = getBodyItemId(req);
      const detail = buildAuditDetailMessage({
        success,
        statusCode,
        durationMs,
        itemId
      });

      const metadata = {
        http: {
          method: methodUpper,
          path: urlPath,
          routePattern
        },
        request: {
          requestId: ctx.requestId,
          userId: ctx.userId,
          userEmail: ctx.email,
          userRole: ctx.userRole
        },
        timing: {
          durationMs: Math.round(durationMs * 100) / 100
        },
        entity: {
          workspaceId,
          boardId,
          itemId
        },
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
        category: 'APP',
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

