import { describe, it, expect } from 'vitest';
import { resolveSessionCookieOptions } from '../../../src/utils/sessionCookieHelpers.js';

describe('resolveSessionCookieOptions', () => {
  it('keeps SameSite=lax in test so local/supertest cookies work', () => {
    expect(
      resolveSessionCookieOptions({
        NODE_ENV: 'test',
        BACKEND_URL: 'https://example.ngrok-free.app',
      }),
    ).toMatchObject({ sameSite: 'lax', secure: false, httpOnly: true });
  });

  it('uses SameSite=none + Secure when BACKEND_URL is https (ngrok / split origin)', () => {
    expect(
      resolveSessionCookieOptions({
        NODE_ENV: 'development',
        BACKEND_URL: 'https://locust-one-mutt.ngrok-free.app',
      }),
    ).toMatchObject({ sameSite: 'none', secure: true, httpOnly: true });
  });

  it('uses SameSite=none + Secure in production', () => {
    expect(
      resolveSessionCookieOptions({
        NODE_ENV: 'production',
        BACKEND_URL: 'https://api.example.com',
      }),
    ).toMatchObject({ sameSite: 'none', secure: true });
  });

  it('keeps SameSite=lax for plain local http backends', () => {
    expect(
      resolveSessionCookieOptions({
        NODE_ENV: 'development',
        BACKEND_URL: 'http://localhost:4001',
      }),
    ).toMatchObject({ sameSite: 'lax', secure: false });
  });
});
