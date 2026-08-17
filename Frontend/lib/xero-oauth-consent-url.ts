import { XERO_CONSENT_HOSTS } from '@/constants/xeroOAuth';

export function isTrustedXeroConsentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return XERO_CONSENT_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function trustedXeroConsentHref(url: string): string {
  if (!isTrustedXeroConsentUrl(url)) return '';
  const parsed = new URL(url);
  return `https://${parsed.hostname}${parsed.pathname}${parsed.search}`;
}
