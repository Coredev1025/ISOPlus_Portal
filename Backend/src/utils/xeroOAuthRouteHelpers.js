import { error } from './logger.js';
import { pickAllowedValue, toRequiredQueryString } from './securityHelpers.js';
import { configure, getAuthUrl, callback } from '../services/xero.js';
import { saveConnectedXeroBusiness } from './xeroConnectHelpers.js';
import {
  XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED,
  XERO_OAUTH_REASON_INVALID_STATE,
  XERO_OAUTH_REASON_MISSING_CODE,
  XERO_OAUTH_REASON_NO_ORGANISATION,
  XERO_OAUTH_REASON_OAUTH_FAILED,
  XERO_OAUTH_REASON_SAVE_FAILED,
} from '../constants/xeroOAuth.js';
import {
  captureFrontendOriginFromRequest,
  payloadFromXeroOAuthState,
  resolveXeroReturnFrontend,
} from './xeroOAuthStateHelpers.js';
import {
  readXeroOAuthSessionUser,
  xeroOAuthStateMatchesSession,
} from './xeroOAuthSessionHelpers.js';
import { trustedFrontendRedirectUrl, isTrustedXeroConsentUrl } from './xeroOAuthRedirectSafety.js';
import { getFrontendBaseUrl } from './helpers.js';

const XERO_OAUTH_REASONS = [
  XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED,
  XERO_OAUTH_REASON_INVALID_STATE,
  XERO_OAUTH_REASON_MISSING_CODE,
  XERO_OAUTH_REASON_OAUTH_FAILED,
  XERO_OAUTH_REASON_NO_ORGANISATION,
  XERO_OAUTH_REASON_SAVE_FAILED,
];

export function buildXeroConnectReturnUrl(workspaceId, outcome, reason, frontendBase) {
  const base = frontendBase || resolveXeroReturnFrontend('');
  const params = new URLSearchParams();
  if (workspaceId) params.set('tab', 'accounting');
  params.set('xero', outcome);
  const safeReason = pickAllowedValue(reason, XERO_OAUTH_REASONS, '');
  if (safeReason) params.set('reason', safeReason);
  if (!workspaceId) return `${base}/dashboard?${params}`;
  return `${base}/workspace/${encodeURIComponent(workspaceId)}/finance-settings?${params}`;
}

function redirectXeroReturn(res, workspaceId, outcome, reason, frontendBase) {
  const location = buildXeroConnectReturnUrl(workspaceId, outcome, reason, frontendBase);
  const fallback = buildXeroConnectReturnUrl(
    '',
    'error',
    XERO_OAUTH_REASON_OAUTH_FAILED,
    getFrontendBaseUrl()
  );
  res.redirect(trustedFrontendRedirectUrl(location, fallback));
}

export async function handleXeroOAuthRedirect(req, res) {
  try {
    const userId = toRequiredQueryString(req.user?.userId);
    if (!userId) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    const workspaceId = toRequiredQueryString(req.query?.workspaceId);
    if (!workspaceId) {
      return res.status(400).json({ message: 'workspaceId is required' });
    }
    await configure();
    const url = await getAuthUrl(
      workspaceId,
      captureFrontendOriginFromRequest(req),
      userId
    );
    if (!isTrustedXeroConsentUrl(url)) {
      return res.status(200).json({
        message: 'Error generating redirect URL',
        error: 'Invalid Xero redirect URL',
      });
    }
    return res.json({ url });
  } catch (err) {
    error('Xero-Service', 'Error generating redirect URL', err);
    return res.status(200).json({
      message: 'Error generating redirect URL',
      error: 'Unable to generate a Xero consent URL',
    });
  }
}

function tenantIdFromOAuthResult(result) {
  if (typeof result?.tenantId === 'string' && result.tenantId.trim()) {
    return result.tenantId.trim();
  }
  const fromTenant = result?.tenants?.[0]?.tenantId;
  if (typeof fromTenant === 'string' && fromTenant.trim()) return fromTenant.trim();
  return undefined;
}

function reasonForSavedConnection(saved) {
  if (saved.error === 'no_organisation') return XERO_OAUTH_REASON_NO_ORGANISATION;
  return XERO_OAUTH_REASON_SAVE_FAILED;
}

export async function handleXeroOAuthCallback(req, res) {
  const payload = payloadFromXeroOAuthState(req.query?.state);
  const frontend = resolveXeroReturnFrontend(payload.origin);
  try {
    if (!xeroOAuthStateMatchesSession(payload, readXeroOAuthSessionUser(req))) {
      return redirectXeroReturn(
        res,
        payload.workspaceId,
        'error',
        XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED,
        frontend
      );
    }
    if (!payload.workspaceId) {
      return redirectXeroReturn(res, '', 'error', XERO_OAUTH_REASON_INVALID_STATE, frontend);
    }
    if (!req.query?.code) {
      return redirectXeroReturn(
        res,
        payload.workspaceId,
        'error',
        XERO_OAUTH_REASON_MISSING_CODE,
        frontend
      );
    }

    await configure();
    const result = await callback(req.query.code, req.url);
    if (!result?.success) {
      return redirectXeroReturn(
        res,
        payload.workspaceId,
        'error',
        XERO_OAUTH_REASON_OAUTH_FAILED,
        frontend
      );
    }

    const saved = await saveConnectedXeroBusiness({
      workspaceId: payload.workspaceId,
      tokens: result.tokenSet,
      organization: result.organization,
      tenantId: tenantIdFromOAuthResult(result),
      req,
    });
    if (saved.error) {
      return redirectXeroReturn(
        res,
        payload.workspaceId,
        'error',
        reasonForSavedConnection(saved),
        frontend
      );
    }

    return redirectXeroReturn(res, payload.workspaceId, 'success', undefined, frontend);
  } catch (err) {
    error('Xero-Service', 'Error in Xero callback', err);
    return redirectXeroReturn(
      res,
      payload.workspaceId,
      'error',
      XERO_OAUTH_REASON_OAUTH_FAILED,
      frontend
    );
  }
}
