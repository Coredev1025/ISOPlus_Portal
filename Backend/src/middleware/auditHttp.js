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
    try {
      return '[Truncated]';
    } catch {
      return '[Truncated]';
    }
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

export function auditHttpMiddleware(req, res, next) {
  const startHrTime = process.hrtime.bigint();

  res.on('finish', async () => {
    try {
      const url = req.originalUrl || req.url || '';

      // Skip noisy / internal endpoints
      if (
        url.startsWith('/api/healthcheck') ||
        url.startsWith('/api/log') ||
        url.startsWith('/api/queues')
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

      const method = req.method || ctx.method || '';

      const action = `HTTP ${method} ${url}`;

      const detail = {
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
        category: 'HTTP',
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

