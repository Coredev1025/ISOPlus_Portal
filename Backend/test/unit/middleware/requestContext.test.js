import { describe, it, expect, vi } from 'vitest';
import { requestContextMiddleware } from '../../../src/middleware/requestContext.js';

function makeRes() {
  const res = {
    statusCode: 200,
    locals: {},
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    on(event, cb) {
      if (event === 'finish') this._finish = cb;
    },
    finish() { this._finish?.(); },
  };
  return res;
}

describe('requestContextMiddleware', () => {
  it('assigns a request id and echoes it on the response', () => {
    const req = { headers: {}, originalUrl: '/api/boards', url: '/api/boards' };
    const res = makeRes();
    const next = vi.fn();
    requestContextMiddleware(req, res, next);
    expect(req.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(req.requestId);
    expect(next).toHaveBeenCalledOnce();
  });

  it('reuses an incoming x-request-id header', () => {
    const req = {
      headers: { 'x-request-id': 'incoming-id' },
      originalUrl: '/api/boards',
      url: '/api/boards',
    };
    const res = makeRes();
    requestContextMiddleware(req, res, vi.fn());
    expect(req.requestId).toBe('incoming-id');
  });

  it('captures failure reason from json body on error status', () => {
    const req = { headers: {}, originalUrl: '/api/boards', url: '/api/boards' };
    const res = makeRes();
    requestContextMiddleware(req, res, vi.fn());
    res.statusCode = 400;
    res.json({ message: 'bad', error_type: 'validation' });
    expect(res.locals.__failureReason).toBeTruthy();
    expect(res.locals.__failureType).toBe('validation');
  });
});
