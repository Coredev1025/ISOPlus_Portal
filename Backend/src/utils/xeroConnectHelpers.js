/**
 * Persist Xero OAuth tokens on a Business document.
 *
 * Touchpoints: utils/xeroOAuthRouteHelpers.js
 */
import Business from '../models/Business.js';
import { logXeroAudit } from './xeroAuditHelpers.js';
import { ensureDefaultLineItemMapping, buildDefaultLineItemMapping } from './xeroLineItemMapping.js';

export function buildXeroTokenPayload(tokens) {
  if (!tokens?.access_token || !tokens?.refresh_token) return null;
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_at,
    refreshTokenExpiresAt: Date.now() + 60 * 24 * 60 * 60 * 1000,
  };
}

function resolveConnectTenantId(tenantId, organization) {
  const fromTenant = typeof tenantId === 'string' ? tenantId.trim() : '';
  if (fromTenant) return fromTenant;
  const fromOrg =
    typeof organization?.organisationId === 'string'
      ? organization.organisationId.trim()
      : '';
  return fromOrg || null;
}

export async function saveConnectedXeroBusiness({
  workspaceId,
  tokens,
  organization,
  tenantId,
  req,
}) {
  const xeroTenantId = resolveConnectTenantId(tenantId, organization);
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
      xeroLineItemMapping: buildDefaultLineItemMapping(),
    });
  } else {
    business.xeroIntegrated = true;
    business.xeroTenantId = xeroTenantId;
    business.xeroTokens = tokenPayload;
    if (organization) {
      business.xeroOrganization = organization;
    }
    // Seed only when nothing is mapped yet — never overwrite operator choices.
    business.xeroLineItemMapping = ensureDefaultLineItemMapping(
      business.xeroLineItemMapping
    );
  }
  await business.save();

  await logXeroAudit({
    workspaceId,
    action: 'Connected Xero',
    detail: 'Xero integration connected',
    req,
    entityType: 'Business',
    entityId: business._id?.toString(),
    success: true,
  });
  return { business };
}
