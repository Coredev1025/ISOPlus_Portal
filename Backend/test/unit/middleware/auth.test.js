import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  validateApiKey,
  authenticateToken,
  requirePortalOwnerOrSupport,
} from '../../../src/middleware/auth.js';

function mockRes() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json: vi.fn(function (body) { this.body = body; return this; }),
  };
}

function mockReq(overrides = {}) {
  return {
    headers: {},
    session: {},
    body: {},
    params: {},
    query: {},
    ...overrides,
  };
}

describe('validateApiKey middleware', () => {
  const originalKey = process.env.Admin_API_Key;
  beforeEach(() => { process.env.Admin_API_Key = 'secret-api-key'; });
  afterEach(() => { process.env.Admin_API_Key = originalKey; });

  it('returns 401 when no authorization header', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();
    validateApiKey(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 500 when Admin_API_Key is not configured', () => {
    delete process.env.Admin_API_Key;
    const req = mockReq({ headers: { authorization: 'anything' } });
    const res = mockRes();
    const next = vi.fn();
    validateApiKey(req, res, next);
    expect(res.statusCode).toBe(500);
  });

  it('returns 401 when api key does not match', () => {
    const req = mockReq({ headers: { authorization: 'wrong-key' } });
    const res = mockRes();
    const next = vi.fn();
    validateApiKey(req, res, next);
    expect(res.statusCode).toBe(401);
  });

  it('calls next when api key matches', () => {
    const req = mockReq({ headers: { authorization: 'secret-api-key' } });
    const res = mockRes();
    const next = vi.fn();
    validateApiKey(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('authenticateToken middleware', () => {
  const originalSecret = process.env.JWT_SECRET;
  const originalPat = process.env.PERSONAL_ACCESS_TOKEN;
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'pat-token';
  });
  afterEach(() => {
    process.env.JWT_SECRET = originalSecret;
    process.env.PERSONAL_ACCESS_TOKEN = originalPat;
  });

  it('returns 401 when no token in session', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();
    authenticateToken(req, res, next);
    expect(res.statusCode).toBe(401);
  });

  it('returns 500 when JWT_SECRET is missing', () => {
    delete process.env.JWT_SECRET;
    const req = mockReq({ session: { token: 'tok' } });
    const res = mockRes();
    const next = vi.fn();
    authenticateToken(req, res, next);
    expect(res.statusCode).toBe(500);
  });

  it('returns 403 for invalid token', () => {
    const req = mockReq({ session: { token: 'garbage' } });
    const res = mockRes();
    const next = vi.fn();
    authenticateToken(req, res, next);
    expect(res.statusCode).toBe(403);
  });

  it('attaches req.user and calls next for an owner role', () => {
    const token = jwt.sign({ userId: 'u1', role: 'owner' }, 'test-secret');
    const req = mockReq({ session: { token } });
    const res = mockRes();
    const next = vi.fn();
    authenticateToken(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user.role).toBe('owner');
    expect(req.session.Authorization).toMatch(/^Bearer /);
  });

  it('denies isoplus_user without session Authorization', () => {
    const token = jwt.sign({ userId: 'u2', role: 'isoplus_user' }, 'test-secret');
    const req = mockReq({ session: { token }, params: { workspaceId: 'ws-1' } });
    const res = mockRes();
    const next = vi.fn();
    authenticateToken(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows isoplus_user when session Authorization is present', () => {
    const token = jwt.sign({ userId: 'u2', role: 'isoplus_user' }, 'test-secret');
    const req = mockReq({
      session: { token, Authorization: 'Bearer iso-token' },
      params: { workspaceId: 'ws-1' },
    });
    const res = mockRes();
    const next = vi.fn();
    authenticateToken(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user.role).toBe('isoplus_user');
  });
});

describe('requirePortalOwnerOrSupport middleware', () => {
  it('returns 403 for isoplus_user', () => {
    const req = mockReq({ user: { role: 'isoplus_user', userId: 'u1' } });
    const res = mockRes();
    const next = vi.fn();
    requirePortalOwnerOrSupport(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next for owner and support_admin', () => {
    for (const role of ['owner', 'support_admin']) {
      const req = mockReq({ user: { role, userId: 'u1' } });
      const res = mockRes();
      const next = vi.fn();
      requirePortalOwnerOrSupport(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });
});
