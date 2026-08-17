/**
 * Persist Xero OAuth tokens on a Business document.
 *
 * Touchpoints: routes/business.js, utils/xeroOAuthRouteHelpers.js
 */
import Business from '../models/Business.js';
import { logXeroAudit } from './xeroAuditHelpers.js';

export function resolveConnectTenantId(body) {
  const fromBody = typeof body?.tenantId === 'string' ? body.tenantId.trim() : '';
  if (fromBody) return fromBody;
  const fromOrg =
    typeof body?.organization?.organisationId === 'string'
      ? body.organization.organisationId.trim()
      : '';
  return fromOrg || null;
}

export function buildXeroTokenPayload(tokens) {
  if (!tokens?.access_token || !tokens?.refresh_token) return null;
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_at,
    refreshTokenExpiresAt: Date.now() + 60 * 24 * 60 * 60 * 1000,
  };
}

export async function persistXeroConnection({
  workspaceId,
  tokens,
  organization,
  tenantId,
}) {
  const xeroTenantId = resolveConnectTenantId({ tenantId, organization });
  const tokenPayload = buildXeroTokenPayload(tokens);
  if (!xeroTenantId) return { error: 'no_organisation' };
  if (!tokenPayload) return { error: 'missing_tokens' };

  let business = await Business.findOne({ workspaceId: { $eq: String(workspaceId) } });
  if (!business) {
    business = new Business({
      workspaceId,
      xeroIntegrated: true,
      xeroTenantId,
      xeroTokens: tokenPayload,
      xeroOrganization: organization || null,
    });
  } else {
    business.xeroIntegrated = true;
    business.xeroTenantId = xeroTenantId;
    business.xeroTokens = tokenPayload;
    if (organization) {
      business.xeroOrganization = organization;
    }
  }
  await business.save();
  return { business };
}

export async function saveConnectedXeroBusiness({
  workspaceId,
  tokens,
  organization,
  tenantId,
  req,
}) {
  const result = await persistXeroConnection({
    workspaceId,
    tokens,
    organization,
    tenantId,
  });
  if (result.error) return result;

  await logXeroAudit({
    workspaceId,
    action: 'Connected Xero',
    detail: 'Xero integration connected',
    req,
    entityType: 'Business',
    entityId: result.business?._id?.toString(),
    success: true,
  });
  return result;
}
