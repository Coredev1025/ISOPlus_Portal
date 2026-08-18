import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Business from '../../../src/models/Business.js';
import AuditTrail from '../../../src/models/AuditTrail.js';
import { signOAuthState } from '../../../src/utils/helpers.js';
import { createXeroConnectTicket } from '../../../src/utils/xeroOAuthConnectTicketHelpers.js';

vi.mock('../../../src/services/xero.js', () => ({
  createXeroOAuthClient: vi.fn(async () => ({})),
  getAuthUrl: vi.fn(async (workspaceId) => `https://login.xero.com/identity/connect/authorize?workspaceId=${workspaceId}`),
  callback: vi.fn(),
}));

import { createXeroOAuthClient, getAuthUrl, callback } from '../../../src/services/xero.js';
import {
  handleXeroOAuthCallback,
  handleXeroOAuthRedirect,
} from '../../../src/utils/xeroOAuthRouteHelpers.js';

function mockRes() {
  return {
    json: vi.fn(),
    status: vi.fn(function status() {
      return this;
    }),
    redirect: vi.fn(),
    send: vi.fn(),
  };
}

function sessionFor(userId = 'user-1') {
  return {
    token: jwt.sign(
      { userId, role: 'owner', email: 'owner@example.com' },
      process.env.JWT_SECRET
    ),
  };
}

function xeroState(overrides = {}) {
  return signOAuthState({
    flow: 'xero',
    workspaceId: 'ws-oauth',
    userId: 'user-1',
    ...overrides,
  });
}

function tokenSet() {
  return {
    access_token: 'access-secret',
    refresh_token: 'refresh-secret',
    expires_at: 1_700_000_000,
  };
}

describe('xeroOAuthRouteHelpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FRONTEND_URL = 'http://localhost:3100';
  });

  afterEach(async () => {
    delete process.env.FRONTEND_URL;
    delete process.env.ALLOWED_ORIGINS;
  });

  it('refuses to mint a consent URL without an authenticated portal user', async () => {
    const res = mockRes();
    await handleXeroOAuthRedirect(
      {
        query: { workspaceId: 'ws-1' },
        get: () => undefined,
      },
      res
    );
    expect(getAuthUrl).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Authentication required' });
  });

  it('sends workspaceId, frontend origin and userId to getAuthUrl for a full-page redirect', async () => {
    const res = mockRes();
    const req = {
      user: { userId: 'user-1' },
      query: { workspaceId: 'ws-1' },
      get: (header) => (header === 'origin' ? 'http://localhost:3100' : undefined),
    };
    await handleXeroOAuthRedirect(req, res);

    expect(createXeroOAuthClient).toHaveBeenCalled();
    expect(getAuthUrl).toHaveBeenCalledWith(
      'ws-1',
      'http://localhost:3100',
      'user-1',
      expect.stringMatching(/^[a-f0-9]{64}$/i),
      expect.anything()
    );
    expect(res.json).toHaveBeenCalledWith({
      url: expect.stringContaining('https://login.xero.com/identity/connect/authorize'),
    });
  });

  it('does not return a consent URL that is not a trusted Xero host', async () => {
    getAuthUrl.mockResolvedValueOnce('https://evil.example/phish');
    const res = mockRes();
    await handleXeroOAuthRedirect(
      {
        user: { userId: 'user-1' },
        query: { workspaceId: 'ws-1' },
        get: () => undefined,
      },
      res
    );
    expect(res.json).toHaveBeenCalledWith({
      message: 'Error generating redirect URL',
      error: 'Invalid Xero redirect URL',
    });
    const trails = await AuditTrail.find({ workspaceId: 'ws-1' }).lean();
    expect(trails).toEqual([
      expect.objectContaining({
        action: 'Failed to connect Xero',
        success: false,
        detail: expect.stringMatching(/could not complete the xero authentication/i),
      }),
    ]);
  });

  it('requires workspaceId once the portal user is authenticated', async () => {
    const res = mockRes();
    await handleXeroOAuthRedirect(
      { user: { userId: 'user-1' }, query: {}, get: () => undefined },
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'workspaceId is required' });
  });

  it('returns a body error when consent URL generation throws', async () => {
    getAuthUrl.mockRejectedValueOnce(new Error('xero down'));
    const res = mockRes();
    await handleXeroOAuthRedirect(
      { user: { userId: 'user-1' }, query: { workspaceId: 'ws-1' }, get: () => undefined },
      res
    );
    expect(res.json).toHaveBeenCalledWith({
      message: 'Error generating redirect URL',
      error: 'Unable to generate a Xero consent URL',
    });
    const trails = await AuditTrail.find({ workspaceId: 'ws-1' }).lean();
    expect(trails).toHaveLength(1);
    expect(trails[0].action).toBe('Failed to connect Xero');
    expect(trails[0].success).toBe(false);
  });

  it('does not persist Xero tokens when the callback has no portal session or connect ticket', async () => {
    callback.mockResolvedValue({
      success: true,
      tokenSet: tokenSet(),
      tenants: [{ tenantId: 'tenant-1' }],
      organization: { organisationId: 'tenant-1', name: 'Acme' },
    });
    const res = mockRes();
    await handleXeroOAuthCallback(
      {
        query: { code: 'auth-code', state: xeroState() },
        url: '/api/xero/callback?code=auth-code',
      },
      res
    );

    expect(await Business.findOne({ workspaceId: 'ws-oauth' })).toBeNull();
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('xero=error')
    );
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('reason=authentication_required')
    );
    const trails = await AuditTrail.find({ workspaceId: 'ws-oauth' }).lean();
    expect(trails).toEqual([
      expect.objectContaining({
        action: 'Failed to connect Xero',
        category: 'Xero',
        success: false,
        detail: expect.stringMatching(/could not be verified/i),
      }),
    ]);
  });

  it('does not persist Xero tokens when the signed userId does not match the session', async () => {
    callback.mockResolvedValue({
      success: true,
      tokenSet: tokenSet(),
      tenants: [{ tenantId: 'tenant-1' }],
      organization: { organisationId: 'tenant-1' },
    });
    const res = mockRes();
    await handleXeroOAuthCallback(
      {
        query: { code: 'auth-code', state: xeroState({ userId: 'victim-user' }) },
        url: '/api/xero/callback?code=auth-code',
        session: sessionFor('attacker-user'),
      },
      res
    );

    expect(await Business.findOne({ workspaceId: 'ws-oauth' })).toBeNull();
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('reason=authentication_required')
    );
  });

  it('persists Xero when the callback has no portal session but a valid connect ticket', async () => {
    const connectTicket = await createXeroConnectTicket({
      userId: 'user-1',
      workspaceId: 'ws-oauth',
    });
    callback.mockResolvedValue({
      success: true,
      tokenSet: tokenSet(),
      tenants: [{ tenantId: 'tenant-1' }],
      organization: { organisationId: 'tenant-1', name: 'Acme' },
    });
    const res = mockRes();
    await handleXeroOAuthCallback(
      {
        query: { code: 'auth-code', state: xeroState({ connectTicket }) },
        url: '/api/xero/callback?code=auth-code',
      },
      res
    );

    expect(await Business.findOne({ workspaceId: 'ws-oauth' })).toBeTruthy();
    expect(res.redirect).toHaveBeenCalledWith(
      'http://localhost:3100/workspace/ws-oauth/finance-settings?tab=accounting&xero=success'
    );
  });

  it('persists Xero on the business and redirects back without posting tokens to a popup', async () => {
    callback.mockResolvedValue({
      success: true,
      tokenSet: tokenSet(),
      tenants: [{ tenantId: 'tenant-1' }],
      organization: { organisationId: 'tenant-1', name: 'Acme' },
    });

    const res = mockRes();
    await handleXeroOAuthCallback(
      {
        query: { code: 'auth-code', state: xeroState() },
        url: '/api/xero/callback?code=auth-code',
        session: sessionFor('user-1'),
      },
      res
    );

    expect(res.send).not.toHaveBeenCalled();
    expect(JSON.stringify(res.redirect.mock.calls)).not.toMatch(
      /access-secret|refresh-secret|postMessage/
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'http://localhost:3100/workspace/ws-oauth/finance-settings?tab=accounting&xero=success'
    );

    const business = await Business.findOne({ workspaceId: 'ws-oauth' }).lean();
    expect(business.xeroIntegrated).toBe(true);
    expect(business.xeroTenantId).toBe('tenant-1');
    expect(business.xeroTokens.accessToken).toBe('access-secret');

    const trails = await AuditTrail.find({ workspaceId: 'ws-oauth' }).lean();
    expect(trails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'Connected Xero',
          category: 'Xero',
          success: true,
          userId: 'user-1',
          userEmail: 'owner@example.com',
        }),
      ])
    );
  });

  it('updates tokens on an existing business instead of inserting a second row', async () => {
    await Business.create({
      workspaceId: 'ws-oauth',
      name: 'Existing',
      xeroIntegrated: false,
    });
    callback.mockResolvedValue({
      success: true,
      tokenSet: tokenSet(),
      organization: { organisationId: 'tenant-9', name: 'Renewed' },
    });
    const res = mockRes();
    await handleXeroOAuthCallback(
      {
        query: { code: 'auth-code', state: xeroState() },
        url: '/api/xero/callback?code=auth-code',
        session: sessionFor('user-1'),
      },
      res
    );
    const rows = await Business.find({ workspaceId: 'ws-oauth' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].xeroIntegrated).toBe(true);
    expect(rows[0].xeroTenantId).toBe('tenant-9');
    expect(rows[0].xeroOrganization.name).toBe('Renewed');
  });

  it('uses the Xero tenant id from updateTenants when organisationId is absent', async () => {
    await Business.create({ workspaceId: 'ws-oauth', name: 'Existing' });
    callback.mockResolvedValue({
      success: true,
      tokenSet: tokenSet(),
      tenants: [{ tenantId: 'tenant-from-list' }],
      organization: { name: 'No Id' },
    });
    const res = mockRes();
    await handleXeroOAuthCallback(
      {
        query: { code: 'auth-code', state: xeroState() },
        url: '/api/xero/callback?code=auth-code',
        session: sessionFor('user-1'),
      },
      res
    );
    const row = await Business.findOne({ workspaceId: 'ws-oauth' }).lean();
    expect(row.xeroTenantId).toBe('tenant-from-list');
  });

  it('redirects with an allow-listed reason instead of using window.opener when OAuth fails', async () => {
    callback.mockResolvedValue({ success: false, message: 'Authentication failed' });
    const res = mockRes();
    await handleXeroOAuthCallback(
      {
        query: { code: 'bad', state: xeroState({ workspaceId: 'ws-fail' }) },
        url: '/api/xero/callback?code=bad',
        session: sessionFor('user-1'),
      },
      res
    );

    expect(res.send).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      'http://localhost:3100/workspace/ws-fail/finance-settings?tab=accounting&xero=error&reason=oauth_failed'
    );
    const trails = await AuditTrail.find({ workspaceId: 'ws-fail' }).lean();
    expect(trails).toEqual([
      expect.objectContaining({
        action: 'Failed to connect Xero',
        success: false,
        detail: expect.stringMatching(/could not complete the xero authentication/i),
      }),
    ]);
  });

  it('redirects invalid_state when the signed payload has no workspaceId', async () => {
    const res = mockRes();
    await handleXeroOAuthCallback(
      {
        query: { code: 'c', state: xeroState({ workspaceId: undefined }) },
        url: '/api/xero/callback?code=c',
        session: sessionFor('user-1'),
      },
      res
    );
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('reason=invalid_state')
    );
    expect(await Business.findOne({ workspaceId: 'ws-oauth' })).toBeNull();
  });

  it('redirects missing_code and no_organisation without persisting', async () => {
    const resMissing = mockRes();
    await handleXeroOAuthCallback(
      {
        query: { state: xeroState() },
        session: sessionFor('user-1'),
      },
      resMissing
    );
    expect(resMissing.redirect).toHaveBeenCalledWith(
      expect.stringContaining('reason=missing_code')
    );

    callback.mockResolvedValue({
      success: true,
      tokenSet: tokenSet(),
      organization: {},
    });
    const resOrg = mockRes();
    await handleXeroOAuthCallback(
      {
        query: { code: 'c', state: xeroState() },
        url: '/api/xero/callback?code=c',
        session: sessionFor('user-1'),
      },
      resOrg
    );
    expect(await Business.findOne({ workspaceId: 'ws-oauth' })).toBeNull();
    expect(resOrg.redirect).toHaveBeenCalledWith(
      expect.stringContaining('reason=no_organisation')
    );
    const trails = await AuditTrail.find({ workspaceId: 'ws-oauth' }).lean();
    expect(trails.map((row) => row.detail)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/could not complete the xero authentication/i),
        expect.stringMatching(/no xero organisation was selected/i),
      ])
    );
    expect(trails.every((row) => row.action === 'Failed to connect Xero' && row.success === false)).toBe(
      true
    );
  });

  it('redirects missing_tokens and unexpected save errors without leaking tokens', async () => {
    callback.mockResolvedValueOnce({
      success: true,
      tokenSet: { access_token: 'only-access' },
      organization: { organisationId: 't1' },
    });
    const resTokens = mockRes();
    await handleXeroOAuthCallback(
      {
        query: { code: 'c', state: xeroState() },
        url: '/api/xero/callback?code=c',
        session: sessionFor('user-1'),
      },
      resTokens
    );
    expect(resTokens.redirect).toHaveBeenCalledWith(
      expect.stringContaining('reason=save_failed')
    );

    callback.mockRejectedValueOnce(new Error('boom'));
    const resCatch = mockRes();
    await handleXeroOAuthCallback(
      {
        query: { code: 'c', state: xeroState() },
        url: '/api/xero/callback?code=c',
        session: sessionFor('user-1'),
      },
      resCatch
    );
    expect(resCatch.redirect).toHaveBeenCalledWith(
      expect.stringContaining('reason=oauth_failed')
    );
  });

  it('redirects to the signed frontend origin when it is on the allow-list', async () => {
    process.env.FRONTEND_URL = 'https://app.example.com';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com,http://portal.test:3100';
    callback.mockResolvedValue({
      success: true,
      tokenSet: tokenSet(),
      tenants: [{ tenantId: 'tenant-1' }],
      organization: { organisationId: 'tenant-1' },
    });
    const res = mockRes();
    await handleXeroOAuthCallback(
      {
        query: {
          code: 'c',
          state: xeroState({
            workspaceId: 'ws-origin',
            origin: 'http://portal.test:3100',
          }),
        },
        url: '/api/xero/callback?code=c',
        session: sessionFor('user-1'),
      },
      res
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'http://portal.test:3100/workspace/ws-origin/finance-settings?tab=accounting&xero=success'
    );
  });
});
