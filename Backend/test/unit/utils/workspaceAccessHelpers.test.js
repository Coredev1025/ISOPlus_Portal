import { describe, it, expect, vi } from 'vitest';

import {
  classifyMembership,
  requireWorkspaceMember,
} from '../../../src/utils/workspaceAccessHelpers.js';

/**
 * The distinction this function exists to make: ISO+ saying "not a member" and
 * ISO+ failing to answer are different outcomes, and collapsing them into 403
 * tells a client they lack permission when the truth is an outage.
 */
describe('classifyMembership', () => {
  it('allows any role ISO+ returns', () => {
    expect(classifyMembership({ role: 'member', status: 200 })).toEqual({ allowed: true });
    expect(classifyMembership({ role: 'admin', status: 200 })).toEqual({ allowed: true });
  });

  it('refuses a completed lookup that found no membership', () => {
    expect(classifyMembership({ role: null, status: 200 })).toMatchObject({ allowed: false, status: 403 });
  });

  it.each([401, 403, 404])('treats %i as ISO+ saying no, not as an outage', (status) => {
    expect(classifyMembership({ role: null, status })).toMatchObject({ allowed: false, status: 403 });
  });

  it.each([500, 502, 504])('treats %i as an upstream failure rather than a refusal', (status) => {
    expect(classifyMembership({ role: null, status })).toMatchObject({ allowed: false, status: 502 });
  });

  // getMemberRole answers 400 without asking anyone when the caller has no
  // email to match on. Failing closed is right; sending an operator to look at
  // ISO+ over it is not.
  it('fails closed on a 400 rather than reporting an outage', () => {
    expect(classifyMembership({ role: null, status: 400 })).toMatchObject({ allowed: false, status: 403 });
  });

  it('refuses when handed nothing at all', () => {
    expect(classifyMembership()).toMatchObject({ allowed: false, status: 403 });
  });
});

describe('requireWorkspaceMember', () => {
  function fakeRes() {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
  }

  const online = () => false;

  it('does not ask ISO+ about portal staff', async () => {
    const getMemberRole = vi.fn();
    const res = fakeRes();

    for (const role of ['owner', 'support_admin']) {
      expect(await requireWorkspaceMember(
        { user: { role }, session: {} }, res, 'ws-1', { getMemberRole, isOfflineMode: online },
      )).toBe(true);
    }
    expect(getMemberRole).not.toHaveBeenCalled();
  });

  it('asks ISO+ with the caller\'s own session token, not the personal access token', async () => {
    const getMemberRole = vi.fn(async () => ({ role: 'member', status: 200 }));
    const req = {
      user: { role: 'isoplus_user', email: 'a@b.test' },
      session: { Authorization: 'Bearer caller-token' },
    };

    expect(await requireWorkspaceMember(req, fakeRes(), 'ws-1', { getMemberRole, isOfflineMode: online }))
      .toBe(true);
    expect(getMemberRole).toHaveBeenCalledWith('Bearer caller-token', 'ws-1', 'a@b.test', { limit: 100 });
  });

  it('answers the request itself when the caller is not a member', async () => {
    const getMemberRole = vi.fn(async () => ({ role: null, status: 200 }));
    const res = fakeRes();

    const allowed = await requireWorkspaceMember(
      { user: { role: 'isoplus_user', email: 'a@b.test' }, session: { Authorization: 'x' } },
      res, 'ws-other', { getMemberRole, isOfflineMode: online },
    );

    expect(allowed).toBe(false);
    expect(res.statusCode).toBe(403);
    // The refusal says nothing about the workspace it refused.
    expect(JSON.stringify(res.body)).not.toContain('ws-other');
  });

  // Offline runs one local user against a fixture database with no ISO+ to ask,
  // and getMemberRoleOffline answers null for everybody. Asking there would lock
  // local development out of its own workspaces. It is only a bypass in
  // development: isOfflineMode() is false in production whatever ISOPLUS_OFFLINE
  // is set to.
  it('does not ask ISO+ offline', async () => {
    const getMemberRole = vi.fn();

    expect(await requireWorkspaceMember(
      { user: { role: 'isoplus_user', email: 'a@b.test' }, session: {} },
      fakeRes(), 'ws-1', { getMemberRole, isOfflineMode: () => true },
    )).toBe(true);
    expect(getMemberRole).not.toHaveBeenCalled();
  });
});
