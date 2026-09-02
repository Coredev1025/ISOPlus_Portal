import querystring from 'querystring';
import axios from 'axios';
import {
  GOOGLE_OAUTH_AUTHORIZE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_OAUTH_USERINFO_URL,
  GOOGLE_SUPPORT_OAUTH_FLOW,
} from '../constants/googleAuth.js';
import { resolveGoogleOAuthConfig } from './googleAuthConfigHelpers.js';
import { signOAuthState } from './helpers.js';
import { info, warn, error as logError } from './logger.js';

const LOG_SCOPE = 'Google-OAuth';

export function buildGoogleOAuthRedirectUrl(state) {
  const config = resolveGoogleOAuthConfig();
  if (!config.configured) {
    warn(LOG_SCOPE, 'Cannot build Google OAuth redirect: client not configured', {
      hasClientId: Boolean(config.clientId),
      hasClientSecret: Boolean(config.clientSecret),
      hasCallbackUrl: Boolean(config.callbackUrl),
    });
    return { ok: false, reason: 'not_configured' };
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
  });

  info(LOG_SCOPE, 'Built Google OAuth authorize URL', {
    callbackUrl: config.callbackUrl,
    scopes: config.scopes,
    hasState: Boolean(state),
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
 * @param {string} code
 * @param {{ postToken?: Function, getUserInfo?: Function }} [deps]
 */
export async function exchangeGoogleAuthCode(code, deps = {}) {
  const config = resolveGoogleOAuthConfig();
  if (!config.configured) {
    warn(LOG_SCOPE, 'Google token exchange skipped: client not configured');
    return { ok: false, reason: 'not_configured' };
  }

  info(LOG_SCOPE, 'Exchanging Google authorization code for tokens', {
    callbackUrl: config.callbackUrl,
    hasCode: Boolean(code),
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
      }),
    );

    const accessToken = tokenResponse?.data?.access_token;
    if (!accessToken) {
      warn(LOG_SCOPE, 'Google token endpoint returned no access_token', {
        upstreamStatus: tokenResponse?.status ?? null,
        upstreamKeys: tokenResponse?.data ? Object.keys(tokenResponse.data) : [],
      });
      return { ok: false, reason: 'missing_access_token', upstream: tokenResponse?.data };
    }

    info(LOG_SCOPE, 'Google access token received; fetching userinfo', {
      upstreamStatus: tokenResponse?.status ?? null,
      tokenType: tokenResponse?.data?.token_type || null,
      hasIdToken: Boolean(tokenResponse?.data?.id_token),
    });

    const getUserInfo =
      deps.getUserInfo ||
      ((token) =>
        axios.get(GOOGLE_OAUTH_USERINFO_URL, {
          headers: { Authorization: `Bearer ${token}` },
        }));

    const profileResponse = await getUserInfo(accessToken);
    const profile = profileResponse?.data;
    if (!profile?.email) {
      warn(LOG_SCOPE, 'Google userinfo missing email', {
        upstreamStatus: profileResponse?.status ?? null,
        profileKeys: profile ? Object.keys(profile) : [],
      });
      return { ok: false, reason: 'missing_profile_email', upstream: profile };
    }

    const normalized = {
      id: String(profile.sub || profile.id || ''),
      email: String(profile.email).toLowerCase().trim(),
      name: profile.name ? String(profile.name) : String(profile.email),
      photo_url: profile.picture ? String(profile.picture) : '',
      email_verified: profile.email_verified === true,
    };

    info(LOG_SCOPE, 'Google userinfo fetched', {
      email: normalized.email,
      oauthId: normalized.id,
      emailVerified: normalized.email_verified,
      hasName: Boolean(normalized.name),
    });

    return { ok: true, profile: normalized };
  } catch (err) {
    logError(LOG_SCOPE, 'Google OAuth token exchange or userinfo failed', {
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
