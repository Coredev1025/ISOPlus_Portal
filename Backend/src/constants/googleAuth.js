/**
 * Google support-admin authentication constants.
 *
 * Touchpoints:
 * - utils/googleAuthConfigHelpers.js — env resolution
 * - utils/googleOAuthHelpers.js — OAuth redirect, token exchange, profile
 * - utils/googleGroupMembershipHelpers.js — Admin SDK group check
 * - routes/auth.js — /google/redirect, /google/callback, oauth-exchange branch
 */

/** OAuth state JWT payload flow value for support-admin Google sign-in. */
export const GOOGLE_SUPPORT_OAUTH_FLOW = 'google-support-login';

/** Stored on OAuthTicket.flow for the support-admin handoff ticket. */
export const GOOGLE_SUPPORT_TICKET_FLOW = 'google-support';

/** Scopes for end-user Google OAuth (identity only; no Admin SDK here). */
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
export const GOOGLE_OAUTH_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
