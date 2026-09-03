import { OAuth2Client } from 'google-auth-library';
import { resolveGoogleOAuthConfig } from './googleAuthConfigHelpers.js';
import { info, warn } from './logger.js';

const LOG_SCOPE = 'Google-IdToken';

const ALLOWED_ISSUERS = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
]);

/**
 * Verify Google ID token signature + claims (iss, aud, exp, email_verified).
 * Prefer this over trusting userinfo alone — aud prevents cross-app token replay.
 *
 * @param {string} idToken
 * @param {{ clientId?: string, verifyIdToken?: Function }} [deps]
 */
export async function verifyGoogleIdTokenClaims(idToken, deps = {}) {
  if (!idToken || typeof idToken !== 'string') {
    return { ok: false, reason: 'missing_id_token' };
  }

  const clientId = deps.clientId || resolveGoogleOAuthConfig().clientId;
  if (!clientId) {
    return { ok: false, reason: 'not_configured' };
  }

  try {
    const verifyIdToken =
      deps.verifyIdToken ||
      ((args) => new OAuth2Client(clientId).verifyIdToken(args));

    const ticket = await verifyIdToken({
      idToken,
      audience: clientId,
    });
    const payload = ticket?.getPayload?.() || {};

    if (!ALLOWED_ISSUERS.has(payload.iss)) {
      warn(LOG_SCOPE, 'ID token rejected: unexpected issuer', { iss: payload.iss || null });
      return { ok: false, reason: 'invalid_issuer' };
    }

    if (payload.email_verified !== true) {
      warn(LOG_SCOPE, 'ID token rejected: email not verified', {
        email: payload.email || null,
      });
      return { ok: false, reason: 'unverified_email' };
    }

    if (!payload.sub || !payload.email) {
      return { ok: false, reason: 'incomplete_claims' };
    }

    const profile = {
      id: String(payload.sub),
      email: String(payload.email).toLowerCase().trim(),
      name: payload.name ? String(payload.name) : String(payload.email),
      photo_url: payload.picture ? String(payload.picture) : '',
      email_verified: true,
    };

    info(LOG_SCOPE, 'Google ID token verified', {
      email: profile.email,
      oauthId: profile.id,
      aud: payload.aud || null,
      iss: payload.iss || null,
    });

    return { ok: true, profile };
  } catch (err) {
    warn(LOG_SCOPE, 'Google ID token verification failed', {
      message: err?.message || 'verify_failed',
    });
    return { ok: false, reason: 'invalid_id_token', error: err?.message };
  }
}
