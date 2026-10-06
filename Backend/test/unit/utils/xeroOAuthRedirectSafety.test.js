import { describe, expect, it } from 'vitest';
import {
  isSafeXeroFrontendReturnUrl,
  isTrustedXeroConsentUrl,
  trustedFrontendRedirectUrl,
} from '../../../src/utils/xeroOAuthRedirectSafety.js';

describe('isTrustedXeroConsentUrl', () => {
  it('accepts Xero login hosts over https without credentials', () => {
    expect(
      isTrustedXeroConsentUrl(
        'https://login.xero.com/identity/connect/authorize?state=abc'
      )
    ).toBe(true);
    expect(
      isTrustedXeroConsentUrl('https://identity.xero.com/connect/authorize?foo=1')
    ).toBe(true);
  });

  it('rejects open-redirect and non-https URLs', () => {
    expect(isTrustedXeroConsentUrl('https://evil.example/login.xero.com')).toBe(false);
    expect(isTrustedXeroConsentUrl('http://login.xero.com/identity/connect/authorize')).toBe(
      false
    );
    expect(
      isTrustedXeroConsentUrl('https://user:pass@login.xero.com/identity/connect/authorize')
    ).toBe(false);
    expect(isTrustedXeroConsentUrl('javascript:alert(1)')).toBe(false);
    expect(isTrustedXeroConsentUrl('not-a-url')).toBe(false);
  });
});

describe('trustedFrontendRedirectUrl', () => {
  it('rebuilds allow-listed finance-settings URLs and falls back otherwise', () => {
    process.env.FRONTEND_URL = 'http://localhost:3100';
    process.env.ALLOWED_ORIGINS = 'http://localhost:3100,https://app.example.com';
    const safe =
      'http://localhost:3100/workspace/ws-1/finance-settings?tab=accounting&xero=success';
    expect(isSafeXeroFrontendReturnUrl(safe)).toBe(true);
    expect(trustedFrontendRedirectUrl(safe, 'http://evil.test/')).toBe(safe);
    expect(trustedFrontendRedirectUrl('https://evil.test/phish', safe)).toBe(safe);
    expect(
      isSafeXeroFrontendReturnUrl('http://localhost:3100/workspace/../admin')
    ).toBe(false);
    expect(isSafeXeroFrontendReturnUrl('not a url')).toBe(false);
    expect(trustedFrontendRedirectUrl('javascript:alert(1)', 'not-a-url')).toBe(
      'http://localhost:3100/dashboard?xero=error'
    );
    delete process.env.FRONTEND_URL;
    delete process.env.ALLOWED_ORIGINS;
  });
});
