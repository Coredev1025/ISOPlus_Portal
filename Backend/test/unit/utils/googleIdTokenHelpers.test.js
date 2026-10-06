import { describe, it, expect, vi } from 'vitest';
import { verifyGoogleIdTokenClaims } from '../../../src/utils/googleIdTokenHelpers.js';

describe('googleIdTokenHelpers', () => {
  it('accepts a verified token with matching aud and email_verified', async () => {
    const verifyIdToken = vi.fn(async () => ({
      getPayload: () => ({
        sub: 'google-sub-1',
        email: 'user@example.com',
        email_verified: true,
        name: 'User',
        picture: 'https://example.com/a.png',
        iss: 'https://accounts.google.com',
        aud: 'client-id',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    }));

    const result = await verifyGoogleIdTokenClaims('id.token', {
      clientId: 'client-id',
      verifyIdToken,
    });

    expect(result.ok).toBe(true);
    expect(result.profile).toMatchObject({
      id: 'google-sub-1',
      email: 'user@example.com',
      email_verified: true,
    });
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: 'id.token',
      audience: 'client-id',
    });
  });

  it('rejects unverified email even if verifyIdToken succeeds', async () => {
    const result = await verifyGoogleIdTokenClaims('id.token', {
      clientId: 'client-id',
      verifyIdToken: async () => ({
        getPayload: () => ({
          sub: 'google-sub-1',
          email: 'user@example.com',
          email_verified: false,
          iss: 'https://accounts.google.com',
          aud: 'client-id',
        }),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unverified_email');
  });

  it('rejects when id token is missing', async () => {
    const result = await verifyGoogleIdTokenClaims('', { clientId: 'client-id' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_id_token');
  });
});
