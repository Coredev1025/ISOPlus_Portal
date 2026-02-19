import { v4 as uuidv4 } from 'uuid';
import { debug, info } from '../utils/logger.js';

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

  if (!skip) {
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
  });

  next();
}

