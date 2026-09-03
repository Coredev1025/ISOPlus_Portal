import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  buildGoogleOAuthRedirectUrl,
  isVerifiedGoogleProfile,
  signGoogleSupportOAuthState,
  verifyGoogleSupportOAuthState,
} from '../../../src/utils/googleOAuthHelpers.js';
import { verifyOAuthState } from '../../../src/utils/helpers.js';
import { GOOGLE_SUPPORT_OAUTH_FLOW } from '../../../src/constants/googleAuth.js';

const BASE_ENV = {
  JWT_SECRET: 'test-jwt-secret',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  GOOGLE_OAUTH_CALLBACK_URL: 'https://api.example.com/api/auth/google/callback',
};

describe('googleOAuthHelpers', () => {
  const saved = {};

  beforeEach(() => {
    for (const key of Object.keys(BASE_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = BASE_ENV[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(BASE_ENV)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('builds a Google authorize URL with signed state and PKCE', () => {
    const state = signGoogleSupportOAuthState();
    const built = buildGoogleOAuthRedirectUrl(state, {
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
    });
    expect(built.ok).toBe(true);
    expect(built.redirectUri).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(built.redirectUri).toContain('client_id=client-id');
    expect(built.redirectUri).toContain(encodeURIComponent(state));
    expect(built.redirectUri).toContain('code_challenge=challenge');
    expect(built.redirectUri).toContain('code_challenge_method=S256');
  });

  it('refuses to build an authorize URL without PKCE', () => {
    const built = buildGoogleOAuthRedirectUrl(signGoogleSupportOAuthState());
    expect(built.ok).toBe(false);
    expect(built.reason).toBe('missing_pkce');
  });

  it('accepts only google-support OAuth state payloads', () => {
    const state = signGoogleSupportOAuthState();
    const verified = verifyGoogleSupportOAuthState(verifyOAuthState(state));
    expect(verified.ok).toBe(true);
    expect(verified.payload.flow).toBe(GOOGLE_SUPPORT_OAUTH_FLOW);
  });

  it('rejects ISO+ login state for google support callback', () => {
    const isoplusState = jwt.sign({ flow: 'isoplus-login', nonce: 'x' }, process.env.JWT_SECRET);
    const verified = verifyGoogleSupportOAuthState(verifyOAuthState(isoplusState));
    expect(verified.ok).toBe(false);
    expect(verified.reason).toBe('invalid_flow');
  });

  it('requires email_verified on Google profiles', () => {
    expect(
      isVerifiedGoogleProfile({
        id: '123',
        email: 'user@example.com',
        email_verified: true,
      }),
    ).toBe(true);
    expect(
      isVerifiedGoogleProfile({
        id: '123',
        email: 'user@example.com',
        email_verified: false,
      }),
    ).toBe(false);
  });
});
