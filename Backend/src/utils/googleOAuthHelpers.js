import querystring from 'querystring';
import axios from 'axios';
import {
  GOOGLE_OAUTH_AUTHORIZE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_SUPPORT_OAUTH_FLOW,
} from '../constants/googleAuth.js';
import { resolveGoogleOAuthConfig } from './googleAuthConfigHelpers.js';
import { signOAuthState } from './helpers.js';
import { verifyGoogleIdTokenClaims } from './googleIdTokenHelpers.js';
import { info, warn, error as logError } from './logger.js';

const LOG_SCOPE = 'Google-OAuth';

export function buildGoogleOAuthRedirectUrl(state, { codeChallenge, codeChallengeMethod = 'S256' } = {}) {
  const config = resolveGoogleOAuthConfig();
  if (!config.configured) {
    warn(LOG_SCOPE, 'Cannot build Google OAuth redirect: client not configured', {
      hasClientId: Boolean(config.clientId),
      hasClientSecret: Boolean(config.clientSecret),
      hasCallbackUrl: Boolean(config.callbackUrl),
    });
    return { ok: false, reason: 'not_configured' };
  }

  if (!codeChallenge) {
    warn(LOG_SCOPE, 'Cannot build Google OAuth redirect: PKCE code_challenge required');
    return { ok: false, reason: 'missing_pkce' };
  }

  const query = querystring.stringify({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    response_type: 'code',
    scope: config.scopes.join(' '),
    access_type: 'online',
    include_granted_scopes: 'true',
    prompt: 'select_account',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
  });

  info(LOG_SCOPE, 'Built Google OAuth authorize URL', {
    callbackUrl: config.callbackUrl,
    scopes: config.scopes,
    hasState: Boolean(state),
    hasPkce: true,
  });

  return {
    ok: true,
    redirectUri: `${GOOGLE_OAUTH_AUTHORIZE_URL}?${query}`,
  };
}

export function signGoogleSupportOAuthState() {
  return signOAuthState({ flow: GOOGLE_SUPPORT_OAUTH_FLOW });
}

export function verifyGoogleSupportOAuthState(stateResult) {
  if (!stateResult?.ok) return stateResult;
  if (stateResult.payload?.flow !== GOOGLE_SUPPORT_OAUTH_FLOW) {
    warn(LOG_SCOPE, 'Rejected OAuth state with unexpected flow', {
      expectedFlow: GOOGLE_SUPPORT_OAUTH_FLOW,
      actualFlow: stateResult.payload?.flow || null,
    });
    return { ok: false, reason: 'invalid_flow', errorName: null, payload: null };
  }
  return stateResult;
}

/**
 * Exchange code (+ PKCE verifier) for tokens, then verify the ID token claims.
 *
 * @param {string} code
 * @param {{ codeVerifier: string, postToken?: Function, verifyIdTokenClaims?: Function }} deps
 */
export async function exchangeGoogleAuthCode(code, deps = {}) {
  const config = resolveGoogleOAuthConfig();
  if (!config.configured) {
    warn(LOG_SCOPE, 'Google token exchange skipped: client not configured');
    return { ok: false, reason: 'not_configured' };
  }

  if (!deps.codeVerifier) {
    warn(LOG_SCOPE, 'Google token exchange skipped: missing PKCE verifier');
    return { ok: false, reason: 'missing_pkce_verifier' };
  }

  info(LOG_SCOPE, 'Exchanging Google authorization code for tokens', {
    callbackUrl: config.callbackUrl,
    hasCode: Boolean(code),
    hasPkceVerifier: true,
  });

  try {
    const postToken =
      deps.postToken ||
      ((payload) =>
        axios.post(GOOGLE_OAUTH_TOKEN_URL, payload, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }));

    const tokenResponse = await postToken(
      querystring.stringify({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.callbackUrl,
        code,
        code_verifier: deps.codeVerifier,
      }),
    );

    const idToken = tokenResponse?.data?.id_token;
    if (!idToken) {
      warn(LOG_SCOPE, 'Google token endpoint returned no id_token', {
        upstreamStatus: tokenResponse?.status ?? null,
        upstreamKeys: tokenResponse?.data ? Object.keys(tokenResponse.data) : [],
      });
      return { ok: false, reason: 'missing_id_token' };
    }

    info(LOG_SCOPE, 'Google tokens received; verifying ID token', {
      upstreamStatus: tokenResponse?.status ?? null,
      tokenType: tokenResponse?.data?.token_type || null,
      hasAccessToken: Boolean(tokenResponse?.data?.access_token),
    });

    const verify = deps.verifyIdTokenClaims || verifyGoogleIdTokenClaims;
    const verified = await verify(idToken, { clientId: config.clientId });
    if (!verified.ok) {
      return { ok: false, reason: verified.reason || 'invalid_id_token' };
    }

    return { ok: true, profile: verified.profile };
  } catch (err) {
    logError(LOG_SCOPE, 'Google OAuth token exchange or ID token verify failed', {
      err,
      upstreamStatus: err?.response?.status ?? null,
      upstreamError: err?.response?.data?.error || null,
      upstreamDescription: err?.response?.data?.error_description || null,
      callbackUrl: config.callbackUrl,
    });
    throw err;
  }
}

export function isVerifiedGoogleProfile(profile) {
  return Boolean(profile?.email && profile?.id && profile.email_verified === true);
}
