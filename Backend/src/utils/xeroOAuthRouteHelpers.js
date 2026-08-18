import { error } from './logger.js';
import { pickAllowedValue, toRequiredQueryString } from './securityHelpers.js';
import { createXeroOAuthClient, getAuthUrl, callback } from '../services/xero.js';
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
  normalizePortalUserId,
} from './xeroOAuthSessionHelpers.js';
import { claimXeroConnectTicket, createXeroConnectTicket } from './xeroOAuthConnectTicketHelpers.js';
import { logXeroConnectFailure } from './xeroOAuthAuditHelpers.js';
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

function attachXeroOAuthActor(req, actor) {
  if (!actor?.userId) return;
  req.user = {
    userId: actor.userId,
    role: actor.role,
    email: actor.email || '',
  };
}

/**
 * Callback authorization is bound to the portal user captured when the
 * consent URL was minted (session JWT userId, or the one-time connect ticket).
 * A different signed-in user cannot complete this callback.
 */
async function xeroOAuthCallbackAuthorized(payload, req) {
  const sessionUser = readXeroOAuthSessionUser(req);
  if (xeroOAuthStateMatchesSession(payload, sessionUser)) {
    attachXeroOAuthActor(req, sessionUser);
    return true;
  }
  const claimed = await claimXeroConnectTicket(payload.connectTicket, payload);
  if (!claimed) return false;
  attachXeroOAuthActor(req, { userId: claimed.userId, email: claimed.email });
  return true;
}

export async function handleXeroOAuthRedirect(req, res) {
  try {
    const userId = normalizePortalUserId(req.user?.userId);
    if (!userId) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    const workspaceId = toRequiredQueryString(req.query?.workspaceId);
    if (!workspaceId) {
      return res.status(400).json({ message: 'workspaceId is required' });
    }
    const frontendOrigin = captureFrontendOriginFromRequest(req);
    const connectTicket = await createXeroConnectTicket({
      userId,
      workspaceId,
      origin: frontendOrigin,
      email: typeof req.user?.email === 'string' ? req.user.email : '',
    });
    if (typeof req.session?.save === 'function') {
      await new Promise((resolve, reject) => {
        req.session.save((err) => (err ? reject(err) : resolve()));
      });
    }
    const xero = await createXeroOAuthClient();
    const url = await getAuthUrl(
      workspaceId,
      frontendOrigin,
      userId,
      connectTicket,
      xero
    );
    if (!isTrustedXeroConsentUrl(url)) {
      await logXeroConnectFailure({
        workspaceId,
        reason: XERO_OAUTH_REASON_OAUTH_FAILED,
        req,
      });
      return res.status(200).json({
        message: 'Error generating redirect URL',
        error: 'Invalid Xero redirect URL',
      });
    }
    return res.json({ url });
  } catch (err) {
    error('Xero-Service', 'Error generating redirect URL', err);
    const workspaceId = toRequiredQueryString(req.query?.workspaceId);
    await logXeroConnectFailure({
      workspaceId,
      reason: XERO_OAUTH_REASON_OAUTH_FAILED,
      req,
    });
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

async function redirectXeroConnectFailure(res, workspaceId, reason, frontendBase, req) {
  await logXeroConnectFailure({ workspaceId, reason, req });
  redirectXeroReturn(res, workspaceId, 'error', reason, frontendBase);
}

export async function handleXeroOAuthCallback(req, res) {
  const payload = payloadFromXeroOAuthState(req.query?.state);
  const frontend = resolveXeroReturnFrontend(payload.origin);
  try {
    if (!(await xeroOAuthCallbackAuthorized(payload, req))) {
      return redirectXeroConnectFailure(
        res,
        payload.workspaceId,
        XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED,
        frontend,
        req
      );
    }
    if (!payload.workspaceId) {
      return redirectXeroReturn(res, '', 'error', XERO_OAUTH_REASON_INVALID_STATE, frontend);
    }
    if (!req.query?.code) {
      return redirectXeroConnectFailure(
        res,
        payload.workspaceId,
        XERO_OAUTH_REASON_MISSING_CODE,
        frontend,
        req
      );
    }

    const xero = await createXeroOAuthClient();
    const result = await callback(req.query.code, req.url, xero);
    if (!result?.success) {
      return redirectXeroConnectFailure(
        res,
        payload.workspaceId,
        XERO_OAUTH_REASON_OAUTH_FAILED,
        frontend,
        req
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
      return redirectXeroConnectFailure(
        res,
        payload.workspaceId,
        reasonForSavedConnection(saved),
        frontend,
        req
      );
    }

    return redirectXeroReturn(res, payload.workspaceId, 'success', undefined, frontend);
  } catch (err) {
    error('Xero-Service', 'Error in Xero callback', err);
    return redirectXeroConnectFailure(
      res,
      payload.workspaceId,
      XERO_OAUTH_REASON_OAUTH_FAILED,
      frontend,
      req
    );
  }
}
