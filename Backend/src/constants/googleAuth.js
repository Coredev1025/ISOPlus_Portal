/**
 * Google support-admin authentication constants.
 *
 * Touchpoints:
 * - utils/googleAuthConfigHelpers.js — env resolution
 * - utils/googleOAuthHelpers.js — OAuth redirect, token exchange
 * - utils/googleIdTokenHelpers.js — ID token JWKS / aud verification
 * - utils/googlePkceHelpers.js — PKCE + session binding
 * - utils/googleGroupMembershipHelpers.js — Admin SDK group check
 * - utils/googleMembershipCacheHelpers.js — verify re-check cache / break-glass
 * - routes/auth.js — /google/redirect, /google/callback, oauth-exchange, /verify
 */

/** OAuth state JWT payload flow value for support-admin Google sign-in. */
export const GOOGLE_SUPPORT_OAUTH_FLOW = 'google-support-login';

/** Stored on OAuthTicket.flow for the support-admin handoff ticket. */
export const GOOGLE_SUPPORT_TICKET_FLOW = 'google-support';

/** Session key for pre-auth PKCE + state binding (express-session). */
export const GOOGLE_SUPPORT_PREAUTH_SESSION_KEY = 'googleSupportOAuth';

/** Scopes for end-user Google OAuth (openid required for ID token). */
export const GOOGLE_OAUTH_SCOPES = [
  'openid',
  'email',
  'profile',
];

/** Domain-Wide Delegation scope for the service account group lookup. */
export const GOOGLE_DIRECTORY_GROUP_READONLY_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.group.readonly';

export const GOOGLE_DIRECTORY_SCOPES = [GOOGLE_DIRECTORY_GROUP_READONLY_SCOPE];

/** Google OAuth endpoints (stable; not env-specific). */
export const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Support-admin session JWT lifetime. Membership is also re-checked on
 * GET /api/auth/verify with a 5-minute cache — revoke is not instant at group
 * remove; worst case is this TTL if the user never hits /verify.
 */
export const GOOGLE_SUPPORT_SESSION_EXPIRES_IN = '4h';
