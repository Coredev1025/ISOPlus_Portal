/**
 * Xero OAuth consent hosts and callback reason codes.
 *
 * Touchpoints: utils/xeroOAuthRedirectSafety.js, utils/xeroOAuthRouteHelpers.js,
 * Frontend/constants/xeroOAuth.ts
 */
export const XERO_CONSENT_HOSTS = ['login.xero.com', 'identity.xero.com'];

export const XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED = 'authentication_required';
export const XERO_OAUTH_REASON_INVALID_STATE = 'invalid_state';
export const XERO_OAUTH_REASON_MISSING_CODE = 'missing_code';
export const XERO_OAUTH_REASON_OAUTH_FAILED = 'oauth_failed';
export const XERO_OAUTH_REASON_NO_ORGANISATION = 'no_organisation';
export const XERO_OAUTH_REASON_SAVE_FAILED = 'save_failed';
