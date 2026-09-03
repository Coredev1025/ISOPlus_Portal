import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getRequestScope,
  authorizeIsoplusUser,
  applyPrivilegedSessionAuth,
} from '../../../src/middleware/authHelpers.js';

describe('getRequestScope', () => {
  it('prefers body over params and query', () => {
    const scope = getRequestScope({
      body: { workspaceId: 'b', boardId: 'bb' },
      params: { workspaceId: 'p', boardId: 'pb' },
      query: { workspaceId: 'q', boardId: 'qb' },
    });
    expect(scope).toEqual({ workspaceId: 'b', boardId: 'bb' });
  });

  it('falls back to params then query', () => {
    expect(getRequestScope({ body: {}, params: { workspaceId: 'p' }, query: { boardId: 'q' } }))
      .toEqual({ workspaceId: 'p', boardId: 'q' });
  });
});

describe('authorizeIsoplusUser', () => {
  it('denies when session Authorization is missing', () => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json: vi.fn(function (body) { this.body = body; return this; }),
    };
    const allowed = authorizeIsoplusUser(
      { userId: 'u1', role: 'isoplus_user' },
      'ws',
      'board',
      { session: {} },
      res
    );
    expect(allowed).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('allows when session Authorization is present', () => {
    const res = { status() { return this; }, json: vi.fn() };
    const allowed = authorizeIsoplusUser(
      { userId: 'u1', role: 'isoplus_user' },
      'ws',
      'board',
      { session: { Authorization: 'Bearer x' } },
      res
    );
    expect(allowed).toBe(true);
  });
});

describe('applyPrivilegedSessionAuth', () => {
  const original = process.env.PERSONAL_ACCESS_TOKEN;
  beforeEach(() => { process.env.PERSONAL_ACCESS_TOKEN = 'pat'; });
  afterEach(() => { process.env.PERSONAL_ACCESS_TOKEN = original; });

  it('sets Bearer token for owner and support_admin', () => {
    for (const role of ['owner', 'support_admin']) {
      const req = { session: {} };
      expect(applyPrivilegedSessionAuth(req, { role })).toBe(true);
      expect(req.session.Authorization).toBe('Bearer pat');
    }
  });

  it('does not set Authorization for isoplus_user', () => {
    const req = { session: {} };
    expect(applyPrivilegedSessionAuth(req, { role: 'isoplus_user' })).toBe(false);
    expect(req.session.Authorization).toBeUndefined();
  });

  it('does not set Authorization when PERSONAL_ACCESS_TOKEN is blank', () => {
    process.env.PERSONAL_ACCESS_TOKEN = '   ';
    const req = { session: {} };
    expect(applyPrivilegedSessionAuth(req, { role: 'support_admin' })).toBe(false);
    expect(req.session.Authorization).toBeUndefined();
  });
});
