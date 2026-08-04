import { describe, it, expect, vi, afterEach } from 'vitest';
import { errorHandler } from '../../../src/middleware/errorHandler.js';

function makeRes() {
  return {
    statusCode: 200,
    headersSent: false,
    locals: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    json: vi.fn(function (body) { this.body = body; return this; }),
  };
}

function makeReq(overrides = {}) {
  return {
    params: {}, query: {}, body: {}, headers: {},
    method: 'GET', originalUrl: '/api/test', url: '/api/test',
    requestId: 'req-test-id',
    ...overrides,
  };
}

describe('errorHandler middleware', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = originalEnv; });

  it('responds 500 with message when statusCode is not on the error', () => {
    process.env.NODE_ENV = 'test';
    const err = new Error('boom');
    const req = makeReq();
    const res = makeRes();
    errorHandler(err, req, res, vi.fn());
    expect(res.statusCode).toBe(500);
    expect(res.body.message).toBe('boom');
  });

  it('uses err.statusCode when present', () => {
    process.env.NODE_ENV = 'test';
    const err = Object.assign(new Error('bad input'), { statusCode: 400 });
    const req = makeReq();
    const res = makeRes();
    errorHandler(err, req, res, vi.fn());
    expect(res.statusCode).toBe(400);
  });

  it('redacts message in production', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('secret internals');
    const req = makeReq();
    const res = makeRes();
    errorHandler(err, req, res, vi.fn());
    expect(res.body.message).toBe('Server error');
  });

  it('delegates to next when headers already sent', () => {
    const err = new Error('late');
    const req = makeReq();
    const res = makeRes();
    res.headersSent = true;
    const next = vi.fn();
    errorHandler(err, req, res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});
