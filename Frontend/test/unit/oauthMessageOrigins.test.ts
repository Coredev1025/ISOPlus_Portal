import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isTrustedOAuthMessageOrigin } from '@/app/utils/oauthMessageOrigins';

describe('isTrustedOAuthMessageOrigin', () => {
  const originalBackend = process.env.NEXT_PUBLIC_BACKEND_URL;
  const originalTrusted = process.env.NEXT_PUBLIC_TRUSTED_ORIGINS;

  beforeEach(() => {
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost:3000' },
    });
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:3001';
    delete process.env.NEXT_PUBLIC_TRUSTED_ORIGINS;
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_BACKEND_URL = originalBackend;
    process.env.NEXT_PUBLIC_TRUSTED_ORIGINS = originalTrusted;
    vi.unstubAllGlobals();
  });

  it('accepts the current window origin', () => {
    expect(isTrustedOAuthMessageOrigin('http://localhost:3000')).toBe(true);
  });

  it('accepts the backend origin', () => {
    expect(isTrustedOAuthMessageOrigin('http://localhost:3001')).toBe(true);
  });

  it('accepts extra trusted origins', () => {
    process.env.NEXT_PUBLIC_TRUSTED_ORIGINS = 'https://trusted.example';
    expect(isTrustedOAuthMessageOrigin('https://trusted.example')).toBe(true);
  });

  it('rejects unknown origins and empty values', () => {
    expect(isTrustedOAuthMessageOrigin('https://evil.example')).toBe(false);
    expect(isTrustedOAuthMessageOrigin('')).toBe(false);
  });
});
