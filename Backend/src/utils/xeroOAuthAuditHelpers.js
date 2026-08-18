/**
 * User-facing Xero connect failure audit messages.
 * Keep detail strings aligned with Frontend/lib/xero-oauth-return.ts.
 *
 * Touchpoints: utils/xeroOAuthRouteHelpers.js
 */
import {
  XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED,
  XERO_OAUTH_REASON_INVALID_STATE,
  XERO_OAUTH_REASON_MISSING_CODE,
  XERO_OAUTH_REASON_NO_ORGANISATION,
  XERO_OAUTH_REASON_OAUTH_FAILED,
  XERO_OAUTH_REASON_SAVE_FAILED,
} from '../constants/xeroOAuth.js';
import { logXeroAudit } from './xeroAuditHelpers.js';

const DEFAULT_CONNECT_FAILURE_DETAIL =
  'Could not complete the Xero authentication. Please try again.';

const XERO_CONNECT_FAILURE_DETAILS = {
  [XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED]:
    'The Xero connection could not be verified. Click Connect Xero again while you are signed in. If this keeps happening, allow cookies for this site or try another browser.',
  [XERO_OAUTH_REASON_INVALID_STATE]: DEFAULT_CONNECT_FAILURE_DETAIL,
  [XERO_OAUTH_REASON_MISSING_CODE]: DEFAULT_CONNECT_FAILURE_DETAIL,
  [XERO_OAUTH_REASON_OAUTH_FAILED]: DEFAULT_CONNECT_FAILURE_DETAIL,
  [XERO_OAUTH_REASON_NO_ORGANISATION]:
    'No Xero organisation was selected. Please try again and choose an organisation.',
  [XERO_OAUTH_REASON_SAVE_FAILED]: DEFAULT_CONNECT_FAILURE_DETAIL,
};

export function xeroConnectFailureDetail(reason) {
  const key = typeof reason === 'string' ? reason.trim() : '';
  return XERO_CONNECT_FAILURE_DETAILS[key] || DEFAULT_CONNECT_FAILURE_DETAIL;
}

export async function logXeroConnectFailure({ workspaceId, reason, req }) {
  const normalizedWorkspaceId = String(workspaceId || '').trim();
  if (!normalizedWorkspaceId) return;

  await logXeroAudit({
    workspaceId: normalizedWorkspaceId,
    action: 'Failed to connect Xero',
    detail: xeroConnectFailureDetail(reason),
    req,
    entityType: 'Business',
    success: false,
  });
}
