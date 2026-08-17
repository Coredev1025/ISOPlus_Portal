import { signOAuthState, verifyOAuthState, getFrontendBaseUrl, getAllowedOrigins, stripTrailingSlashes } from './helpers.js';
import { toRequiredQueryString } from './securityHelpers.js';

export function captureFrontendOriginFromRequest(req) {
  const getHeader = typeof req?.get === 'function' ? req.get.bind(req) : () => '';
  const origin = getHeader('origin');
  if (origin) return origin;
  const referer = getHeader('referer');
  if (!referer) return '';
  try {
    return new URL(referer).origin;
  } catch {
    return '';
  }
}

export function buildXeroConsentUrl(consentUrl, workspaceId, frontendOrigin, userId) {
  const hasOrigin = typeof frontendOrigin === 'string' && frontendOrigin.trim() !== '';
  const state = signOAuthState({
    flow: 'xero',
    workspaceId: workspaceId != null ? String(workspaceId) : undefined,
    origin: hasOrigin ? frontendOrigin.trim() : undefined,
    userId: userId != null ? String(userId) : undefined,
  });
  const withState = new URL(consentUrl);
  withState.searchParams.set('state', state);
  return withState.toString();
}

export function applyIncomingOAuthStateToXeroClient(xeroClient, url) {
  const requestUrl = new URL(url || '', 'https://placeholder.local');
  const state = requestUrl.searchParams.get('state') || undefined;
  if (xeroClient?.config) {
    xeroClient.config.state = state;
  }
  return state;
}

export function payloadFromXeroOAuthState(state) {
  const verified = verifyOAuthState(typeof state === 'string' ? state : null);
  if (!verified.ok || verified.payload?.flow !== 'xero') {
    return { workspaceId: '', origin: '', userId: '' };
  }
  return {
    workspaceId: toRequiredQueryString(verified.payload?.workspaceId),
    origin:
      typeof verified.payload?.origin === 'string' ? verified.payload.origin.trim() : '',
    userId: toRequiredQueryString(verified.payload?.userId),
  };
}

export function resolveXeroReturnFrontend(origin) {
  const normalized = stripTrailingSlashes(origin || '');
  if (normalized && getAllowedOrigins().includes(normalized)) {
    return normalized;
  }
  return getFrontendBaseUrl();
}
