import { XERO_CONSENT_HOSTS } from '../constants/xeroOAuth.js';
import { getAllowedOrigins, getFrontendBaseUrl, stripTrailingSlashes } from './helpers.js';

export function isTrustedXeroConsentUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return XERO_CONSENT_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

function allowedReturnOrigins() {
  return new Set([...getAllowedOrigins(), stripTrailingSlashes(getFrontendBaseUrl())]);
}

export function isSafeXeroFrontendReturnUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (url.username || url.password) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!allowedReturnOrigins().has(url.origin)) return false;
    if (url.pathname === '/dashboard') return true;
    return /^\/workspace\/[^/]+\/finance-settings$/.test(url.pathname);
  } catch {
    return false;
  }
}

function serializeSafeReturnUrl(urlString) {
  const url = new URL(urlString);
  return `${url.origin}${url.pathname}${url.search}`;
}

export function trustedFrontendRedirectUrl(urlString, fallbackUrl) {
  for (const candidate of [urlString, fallbackUrl]) {
    if (isSafeXeroFrontendReturnUrl(candidate)) {
      return serializeSafeReturnUrl(candidate);
    }
  }
  const origin = stripTrailingSlashes(getFrontendBaseUrl());
  return `${origin}/dashboard?xero=error`;
}
