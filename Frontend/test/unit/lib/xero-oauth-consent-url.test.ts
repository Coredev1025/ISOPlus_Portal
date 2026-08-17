import { describe, expect, it } from 'vitest';
import {
  isTrustedXeroConsentUrl,
  trustedXeroConsentHref,
} from '@/lib/xero-oauth-consent-url';

describe('trustedXeroConsentHref', () => {
  it('returns a rebuilt https Xero URL after host validation', () => {
    const url = 'https://login.xero.com/identity/connect/authorize?state=abc';
    expect(isTrustedXeroConsentUrl(url)).toBe(true);
    expect(trustedXeroConsentHref(url)).toBe(url);
  });

  it('returns empty for open-redirect targets', () => {
    expect(trustedXeroConsentHref('https://evil.example/?next=https://login.xero.com')).toBe(
      ''
    );
    expect(trustedXeroConsentHref('http://login.xero.com/identity/connect/authorize')).toBe(
      ''
    );
    expect(isTrustedXeroConsentUrl('not-a-url')).toBe(false);
  });
});
