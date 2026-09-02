import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import OAuthTicket from '../../src/models/OAuthTicket.js';
import User from '../../src/models/User.js';
import { GOOGLE_SUPPORT_OAUTH_FLOW } from '../../src/constants/googleAuth.js';

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
};

vi.mock('../../src/utils/googleGroupMembershipHelpers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkUserGroupMembership: vi.fn(async (email) => ({
      isMember: email === 'member@isoconsultingservices.com.au',
    })),
  };
});

vi.mock('../../src/utils/googleOAuthHelpers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    exchangeGoogleAuthCode: vi.fn(async (code) => {
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
      return { ok: false, reason: 'token_exchange' };
    }),
  };
});

describe('Google support-admin auth routes', () => {
  const saved = {};

  beforeEach(() => {
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

  function googleState() {
    return jwt.sign({ flow: GOOGLE_SUPPORT_OAUTH_FLOW, nonce: 'n' }, process.env.JWT_SECRET, {
      expiresIn: '30m',
    });
  }

  it('GET /google/redirect returns authorize URL when configured', async () => {
    const res = await request(app).get('/api/auth/google/redirect');
    expect(res.status).toBe(200);
    expect(res.body.redirect_uri).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(res.body.redirect_uri).toContain('client_id=google-client-id');
  });

  it('GET /google/callback redirects with ticket for authorized group member', async () => {
    const agent = request.agent(app);
    const res = await agent
      .get('/api/auth/google/callback')
      .query({ code: 'good-code', state: googleState() });

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
  });

  it('GET /google/callback redirects with group_denied for non-member', async () => {
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ code: 'outsider-code', state: googleState() });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('login=error');
    expect(res.headers.location).toContain('reason=group_denied');
  });

  it('POST /api/auth/login is removed', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'any@example.com', password: 'secret' });
    expect(res.status).toBe(404);
  });
});
