import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import OAuthTicket from '../../src/models/OAuthTicket.js';
import User from '../../src/models/User.js';
import { clearMembershipCache } from '../../src/utils/googleMembershipCacheHelpers.js';

const app = createApp();

const GOOGLE_ENV = {
  JWT_SECRET: 'test-jwt-secret',
  SESSION_SECRET: 'test_session_secret',
  GOOGLE_OAUTH_CLIENT_ID: 'google-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret',
  GOOGLE_OAUTH_CALLBACK_URL: 'http://localhost:4001/api/auth/google/callback',
  GOOGLE_ADMIN_EMAIL: 'admin@isoconsultingservices.com.au',
  GOOGLE_TARGET_GROUP: 'isoplus-portal-support-admin-dev@isoconsultingservices.com.au',
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: 'workspace-group-checker@iso-plus-portal-dev.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  }),
  PERSONAL_ACCESS_TOKEN: 'google-support-test-pat',
  ISOPLUS_OFFLINE: '1',
};

vi.mock('../../src/utils/googleGroupMembershipHelpers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkUserGroupMembership: vi.fn(async (email) => {
      if (email === 'member@isoconsultingservices.com.au') {
        return { status: 'member', isMember: true };
      }
      if (email === 'outage@isoconsultingservices.com.au') {
        return { status: 'verify_error', isMember: false, error: 'API disabled' };
      }
      return { status: 'not_member', isMember: false, error: 'not_a_group_member' };
    }),
  };
});

vi.mock('../../src/utils/googleOAuthHelpers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    exchangeGoogleAuthCode: vi.fn(async (code, deps) => {
      if (!deps?.codeVerifier) {
        return { ok: false, reason: 'missing_pkce_verifier' };
      }
      if (code === 'good-code') {
        return {
          ok: true,
          profile: {
            id: 'google-sub-1',
            email: 'member@isoconsultingservices.com.au',
            name: 'Support Member',
            photo_url: 'https://example.com/photo.jpg',
            email_verified: true,
          },
        };
      }
      if (code === 'outsider-code') {
        return {
          ok: true,
          profile: {
            id: 'google-sub-2',
            email: 'outsider@isoconsultingservices.com.au',
            name: 'Outsider',
            photo_url: '',
            email_verified: true,
          },
        };
      }
      if (code === 'outage-code') {
        return {
          ok: true,
          profile: {
            id: 'google-sub-3',
            email: 'outage@isoconsultingservices.com.au',
            name: 'Outage',
            photo_url: '',
            email_verified: true,
          },
        };
      }
      return { ok: false, reason: 'token_exchange' };
    }),
  };
});

describe('Google support-admin auth routes', () => {
  const saved = {};

  beforeEach(() => {
    clearMembershipCache();
    for (const [key, value] of Object.entries(GOOGLE_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(async () => {
    await OAuthTicket.deleteMany({});
    await User.deleteMany({});
    for (const key of Object.keys(GOOGLE_ENV)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function startGoogleLogin(agent) {
    const redirect = await agent.get('/api/auth/google/redirect').redirects(0);
    expect(redirect.status).toBe(302);
    const location = redirect.headers.location;
    expect(location).toContain('accounts.google.com/o/oauth2/v2/auth');
    const uri = new URL(location);
    expect(uri.searchParams.get('code_challenge')).toBeTruthy();
    return uri.searchParams.get('state');
  }

  it('GET /google/redirect 302s to Google authorize with PKCE (sets session cookie on API host)', async () => {
    const agent = request.agent(app);
    const res = await agent.get('/api/auth/google/redirect').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(res.headers.location).toContain('client_id=google-client-id');
    expect(res.headers.location).toContain('code_challenge=');
    expect(res.headers.location).toContain('code_challenge_method=S256');
    expect(res.headers['set-cookie']?.join(';') || '').toMatch(/connect\.sid/i);
  });

  it('GET /google/callback redirects with ticket for authorized group member', async () => {
    const agent = request.agent(app);
    const state = await startGoogleLogin(agent);
    const res = await agent
      .get('/api/auth/google/callback')
      .query({ code: 'good-code', state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\?ticket=/);

    const ticket = new URL(res.headers.location, 'http://localhost').searchParams.get('ticket');
    expect(ticket).toBeTruthy();

    const exchange = await agent.post('/api/auth/oauth-exchange').send({ ticket });
    expect(exchange.status).toBe(200);
    expect(exchange.body.user.role).toBe('support_admin');
    expect(exchange.body.user.email).toBe('member@isoconsultingservices.com.au');

    const user = await User.findOne({ email: 'member@isoconsultingservices.com.au' });
    expect(user?.role).toBe('support_admin');
    expect(user?.oauthId).toBe('google-sub-1');
  });

  it('Google oauth-exchange sets session Authorization so workspaces are not missing credentials', async () => {
    const agent = request.agent(app);
    const state = await startGoogleLogin(agent);
    const callback = await agent
      .get('/api/auth/google/callback')
      .query({ code: 'good-code', state });
    const ticket = new URL(callback.headers.location, 'http://localhost').searchParams.get('ticket');
    const exchange = await agent.post('/api/auth/oauth-exchange').send({ ticket });
    expect(exchange.status).toBe(200);

    // /verify must keep/re-attach the shared PAT for support_admin.
    const verify = await agent.get('/api/auth/verify');
    expect(verify.status).toBe(200);
    expect(verify.body.authenticated).toBe(true);

    // Missing session.Authorization returns 401 + error_type oauth with that message.
    const workspaces = await agent.get('/api/workspaces?limit=50');
    expect(workspaces.status).toBe(200);
    expect(workspaces.body.error_type).toBeUndefined();
  });

  it('GET /google/callback redirects with group_denied for non-member', async () => {
    const agent = request.agent(app);
    const state = await startGoogleLogin(agent);
    const res = await agent
      .get('/api/auth/google/callback')
      .query({ code: 'outsider-code', state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('login=error');
    expect(res.headers.location).toContain('reason=group_denied');
  });

  it('GET /google/callback redirects with verify_failed when Directory cannot decide', async () => {
    const agent = request.agent(app);
    const state = await startGoogleLogin(agent);
    const res = await agent
      .get('/api/auth/google/callback')
      .query({ code: 'outage-code', state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('reason=verify_failed');
  });

  it('rejects callback without matching pre-auth session (login CSRF)', async () => {
    const agent = request.agent(app);
    const state = await startGoogleLogin(agent);
    // Different agent = different session cookie → binding fails
    const other = request.agent(app);
    const res = await other
      .get('/api/auth/google/callback')
      .query({ code: 'good-code', state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('reason=state_invalid');
  });

  it('POST /api/auth/login is removed', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'any@example.com', password: 'secret' });
    expect(res.status).toBe(404);
  });

  it('GET /verify revokes support_admin when Directory reports not_member', async () => {
    const agent = request.agent(app);
    const state = await startGoogleLogin(agent);
    const callback = await agent
      .get('/api/auth/google/callback')
      .query({ code: 'good-code', state });
    const ticket = new URL(callback.headers.location, 'http://localhost').searchParams.get('ticket');
    await agent.post('/api/auth/oauth-exchange').send({ ticket });

    const { checkUserGroupMembership } = await import('../../src/utils/googleGroupMembershipHelpers.js');
    checkUserGroupMembership.mockResolvedValueOnce({
      status: 'not_member',
      isMember: false,
      error: 'not_a_group_member',
    });

    const verify = await agent.get('/api/auth/verify');
    expect(verify.status).toBe(403);
    expect(verify.body.reason).toBe('group_denied');
  });

  it('GET /verify keeps support session without refresh when Directory verify_error', async () => {
    const agent = request.agent(app);
    const state = await startGoogleLogin(agent);
    const callback = await agent
      .get('/api/auth/google/callback')
      .query({ code: 'good-code', state });
    const ticket = new URL(callback.headers.location, 'http://localhost').searchParams.get('ticket');
    await agent.post('/api/auth/oauth-exchange').send({ ticket });

    const before = await agent.get('/api/auth/verify');
    expect(before.status).toBe(200);
    expect(before.body.authenticated).toBe(true);

    const { checkUserGroupMembership } = await import('../../src/utils/googleGroupMembershipHelpers.js');
    checkUserGroupMembership.mockResolvedValueOnce({
      status: 'verify_error',
      isMember: false,
      error: 'API disabled',
    });

    const duringOutage = await agent.get('/api/auth/verify');
    expect(duringOutage.status).toBe(200);
    expect(duringOutage.body.authenticated).toBe(true);
    expect(duringOutage.body.membershipStatus).toBe('verify_uncertain');
  });
});
