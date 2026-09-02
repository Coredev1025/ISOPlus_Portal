import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  describeGoogleSupportAuthConfig,
  isGoogleSupportAuthConfigured,
  parseServiceAccountCredentials,
  resolveGoogleDirectoryConfig,
  resolveGoogleOAuthConfig,
} from '../../../src/utils/googleAuthConfigHelpers.js';

const BASE_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  GOOGLE_OAUTH_CALLBACK_URL: 'https://api.example.com/api/auth/google/callback',
  GOOGLE_ADMIN_EMAIL: 'admin@example.com',
  GOOGLE_TARGET_GROUP: 'group@example.com',
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: 'sa@project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  }),
};

describe('googleAuthConfigHelpers', () => {
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

  it('resolves OAuth config when client id, secret and callback are set', () => {
    const config = resolveGoogleOAuthConfig();
    expect(config.configured).toBe(true);
    expect(config.clientId).toBe('client-id');
    expect(config.callbackUrl).toBe('https://api.example.com/api/auth/google/callback');
  });

  it('builds callback URL from BACKEND_URL when callback env is absent', () => {
    delete process.env.GOOGLE_OAUTH_CALLBACK_URL;
    process.env.BACKEND_URL = 'https://portal-be-dev.example.com/';
    const config = resolveGoogleOAuthConfig();
    expect(config.callbackUrl).toBe('https://portal-be-dev.example.com/api/auth/google/callback');
    expect(config.configured).toBe(true);
  });

  it('parses inline service account JSON', () => {
    const creds = parseServiceAccountCredentials();
    expect(creds.client_email).toBe('sa@project.iam.gserviceaccount.com');
    expect(creds.private_key).toContain('BEGIN PRIVATE KEY');
  });

  it('reports directory config as configured with admin, group and credentials', () => {
    const config = resolveGoogleDirectoryConfig();
    expect(config.configured).toBe(true);
    expect(config.adminEmail).toBe('admin@example.com');
    expect(config.targetGroup).toBe('group@example.com');
  });

  it('isGoogleSupportAuthConfigured is false when OAuth client secret is missing', () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    expect(isGoogleSupportAuthConfigured()).toBe(false);
  });

  it('describeGoogleSupportAuthConfig never includes secrets', () => {
    const diag = describeGoogleSupportAuthConfig();
    expect(diag).toMatchObject({
      oauthConfigured: true,
      directoryConfigured: true,
      targetGroup: 'group@example.com',
      serviceAccountEmail: 'sa@project.iam.gserviceaccount.com',
      hasPrivateKey: true,
      credentialSource: 'json_env',
    });
    expect(diag).not.toHaveProperty('clientSecret');
    expect(diag).not.toHaveProperty('private_key');
    expect(JSON.stringify(diag)).not.toContain('BEGIN PRIVATE KEY');
  });
});
