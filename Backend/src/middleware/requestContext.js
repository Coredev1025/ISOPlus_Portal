import { v4 as uuidv4 } from 'uuid';
import { debug, info, warn, error } from '../utils/logger.js';

function getHeader(headers, key) {
  if (!headers) return undefined;
  return headers[key] ?? headers[key.toLowerCase()];
}

export function requestContextMiddleware(req, res, next) {
  const incomingRequestId = getHeader(req.headers, 'x-request-id');
  const requestId = (incomingRequestId && String(incomingRequestId).trim()) || uuidv4();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const startHrTime = process.hrtime.bigint();
  const startedAt = new Date();

  // Skip noisy endpoints (configurable)
  const url = req.originalUrl || req.url || '';
  const skip =
    url.startsWith('/api/healthcheck') ||
    url.startsWith('/api/log') ||
    url.startsWith('/api/queues');

  const httpLevel = (process.env.HTTP_LOG_LEVEL || 'info').toLowerCase();
  const httpLog = httpLevel === 'debug' ? debug : info;
  const httpRequestLogsEnabled = String(process.env.HTTP_REQUEST_LOGS_ENABLED || '').toLowerCase() === 'true';

  function extractFailureReason(body) {
    try {
      if (body === null || body === undefined) return undefined;
      if (typeof body === 'string') return body.slice(0, 500);
      if (typeof body !== 'object') return String(body).slice(0, 500);

      const message = body.message || body.error || body.reason;
      if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);

      if (Array.isArray(body.errors) && body.errors.length) {
        const first = body.errors[0];
        if (typeof first === 'string') return first.slice(0, 500);
        if (first && typeof first === 'object') {
          const m = first.msg || first.message || first.error;
          if (m) return String(m).slice(0, 500);
        }
      }

      return JSON.stringify(body).slice(0, 500);
    } catch {
      return undefined;
    }
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && res.locals) {
      res.locals.__failureReason = extractFailureReason(body);
      if (body?.error_type) res.locals.__failureType = String(body.error_type);
    }
    return originalJson(body);
  };

  const originalSend = res.send.bind(res);
  res.send = (body) => {
    if (res.statusCode >= 400 && res.locals) {
      res.locals.__failureReason = extractFailureReason(body);
    }
    return originalSend(body);
  };

  if (!skip && httpRequestLogsEnabled) {
    httpLog(
      'HTTP',
      'Request start',
      {
        startedAt: startedAt.toISOString(),
      },
      req ?? null
    );
  }

  res.on('finish', () => {
    if (skip) return;
    const endHrTime = process.hrtime.bigint();
    const durationMs = Number(endHrTime - startHrTime) / 1_000_000;

    if (httpRequestLogsEnabled) {
      httpLog(
        'HTTP',
        'Request end',
        {
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          contentLength: res.getHeader('content-length'),
        },
        req ?? null
      );
    }

    if (res.statusCode >= 400 && !res.locals?.__unhandledExceptionLogged) {
      const logFn = res.statusCode >= 500 ? error : warn;
      logFn(
        'API',
        'Request failed',
        {
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          reason: res.locals?.__failureReason,
          error_type: res.locals?.__failureType,
          contentLength: res.getHeader('content-length'),
        },
        req ?? null
      );
    }
  });

  next();
}

