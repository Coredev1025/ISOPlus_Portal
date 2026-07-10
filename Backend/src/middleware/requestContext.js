import { v4 as uuidv4 } from 'uuid';
import { debug, info, warn, error } from '../utils/logger.js';
import { extractFailureReason } from './httpFailureReason.js';

function getHeader(headers, key) {
  if (!headers) return undefined;
  return headers[key] ?? headers[key.toLowerCase()];
}

function shouldSkipRequestLog(url) {
  return (
    url.startsWith('/api/healthcheck') ||
    url.startsWith('/api/log') ||
    url.startsWith('/api/queues')
  );
}

function wrapResponseWriter(res, originalWriter) {
  return (body) => {
    if (res.statusCode >= 400 && res.locals) {
      res.locals.__failureReason = extractFailureReason(body);
      if (body?.error_type) res.locals.__failureType = String(body.error_type);
    }
    return originalWriter(body);
  };
}

function logRequestStart(req, httpLog, startedAt, enabled) {
  if (!enabled) return;
  httpLog(
    'HTTP',
    'Request start',
    { startedAt: startedAt.toISOString() },
    req ?? null
  );
}

function logRequestEnd(req, res, httpLog, startHrTime, enabled) {
  if (!enabled) return;

  const durationMs = Number(process.hrtime.bigint() - startHrTime) / 1_000_000;
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

function logRequestFailure(req, res, startHrTime) {
  if (res.statusCode < 400 || res.locals?.__unhandledExceptionLogged) return;

  const durationMs = Number(process.hrtime.bigint() - startHrTime) / 1_000_000;
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

export function requestContextMiddleware(req, res, next) {
  const incomingRequestId = getHeader(req.headers, 'x-request-id');
  const requestId = (incomingRequestId && String(incomingRequestId).trim()) || uuidv4();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const startHrTime = process.hrtime.bigint();
  const startedAt = new Date();
  const url = req.originalUrl || req.url || '';
  const skip = shouldSkipRequestLog(url);

  const httpLevel = (process.env.HTTP_LOG_LEVEL || 'info').toLowerCase();
  const httpLog = httpLevel === 'debug' ? debug : info;
  const httpRequestLogsEnabled = String(process.env.HTTP_REQUEST_LOGS_ENABLED || '').toLowerCase() === 'true';

  res.json = wrapResponseWriter(res, res.json.bind(res));
  res.send = wrapResponseWriter(res, res.send.bind(res));

  if (!skip) {
    logRequestStart(req, httpLog, startedAt, httpRequestLogsEnabled);
  }

  res.on('finish', () => {
    if (skip) return;
    logRequestEnd(req, res, httpLog, startHrTime, httpRequestLogsEnabled);
    logRequestFailure(req, res, startHrTime);
  });

  next();
}
