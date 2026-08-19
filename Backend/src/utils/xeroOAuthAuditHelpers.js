/**
 * Xero connect failure audit logging.
 *
 * Touchpoints: utils/xeroOAuthRouteHelpers.js
 */
import { logXeroAudit } from './xeroAuditHelpers.js';

function normalizeConnectFailureReason(reason) {
  const key = typeof reason === 'string' ? reason.trim() : '';
  return key || 'unknown';
}

export async function logXeroConnectFailure({ workspaceId, reason, req }) {
  const normalizedWorkspaceId = String(workspaceId || '').trim();
  if (!normalizedWorkspaceId) return;

  await logXeroAudit({
    workspaceId: normalizedWorkspaceId,
    action: 'Failed to connect Xero',
    detail: normalizeConnectFailureReason(reason),
    req,
    entityType: 'Business',
    success: false,
  });
}
