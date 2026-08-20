import Business from '../models/Business.js';
import { sanitizeApiPathSegment } from './securityHelpers.js';
import { logAuditTrail } from './auditLogger.js';

export function requireOwnerOrSupportAdmin(req, res) {
  if (req.user?.role === 'owner' || req.user?.role === 'support_admin') {
    return true;
  }
  res.status(403).json({
    message: 'Access denied. Owner or Support Admin permission required.',
  });
  return false;
}

export function parseWorkspaceIdParam(rawWorkspaceId) {
  try {
    return sanitizeApiPathSegment(rawWorkspaceId, 'workspaceId');
  } catch {
    return null;
  }
}

export function getInvoiceStatementAutomationFlag(business) {
  return Boolean(business?.featureToggles?.invoiceStatementAutomation);
}

/**
 * Is the workspace on the invoice/statement automation feature?
 *
 * The flag used to be read only by this module and the Business model, which
 * made it a label rather than a gate: the automation-settings PUT never
 * consulted it, so any admitted session could create an enabled schedule for a
 * workspace the flag said was not on the feature. A workspace with no Business
 * row at all has no flag, and so is off.
 */
export async function isInvoiceStatementAutomationEnabled(workspaceId) {
  const business = await findBusinessByWorkspaceId(workspaceId);
  return getInvoiceStatementAutomationFlag(business);
}

export function buildFeatureTogglesPayload(business) {
  return {
    invoiceStatementAutomation: getInvoiceStatementAutomationFlag(business),
  };
}

export function normalizeFeatureTogglesForProfile(businessPlain) {
  return {
    ...businessPlain,
    featureToggles: buildFeatureTogglesPayload(businessPlain),
  };
}

export function parseInvoiceStatementAutomationBody(body) {
  const value = body?.invoiceStatementAutomation;
  if (typeof value !== 'boolean') {
    return { error: 'invoiceStatementAutomation must be a boolean' };
  }
  return { value };
}

export async function findBusinessByWorkspaceId(workspaceId) {
  return Business.findOne({ workspaceId: { $eq: String(workspaceId) } });
}

export async function upsertInvoiceStatementAutomation(workspaceId, enabled) {
  // Update only — do not upsert a stub Business from the feature-toggle API.
  return Business.findOneAndUpdate(
    { workspaceId: { $eq: String(workspaceId) } },
    {
      $set: {
        'featureToggles.invoiceStatementAutomation': enabled,
      },
    },
    { new: true }
  );
}

export async function auditFeatureToggleUpdate({
  workspaceId,
  enabled,
  previous,
  req,
}) {
  await logAuditTrail({
    workspaceId: String(workspaceId),
    action: 'Updated workspace feature toggles',
    detail: `Invoice & Statement Automation set to ${enabled}`,
    req,
    entityType: 'Workspace',
    entityId: String(workspaceId),
    success: true,
    statusCode: 200,
    before: { invoiceStatementAutomation: previous },
    after: { invoiceStatementAutomation: enabled },
  });
}
