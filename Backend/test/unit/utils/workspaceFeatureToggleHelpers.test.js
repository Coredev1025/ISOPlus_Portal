import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/auditLogger.js', () => ({
  logAuditTrail: vi.fn(async () => {}),
}));

import Business from '../../../src/models/Business.js';
import { logAuditTrail } from '../../../src/utils/auditLogger.js';
import {
  requireOwnerOrSupportAdmin,
  parseWorkspaceIdParam,
  getInvoiceStatementAutomationFlag,
  buildFeatureTogglesPayload,
  normalizeFeatureTogglesForProfile,
  parseInvoiceStatementAutomationBody,
  findBusinessByWorkspaceId,
  upsertInvoiceStatementAutomation,
  auditFeatureToggleUpdate,
} from '../../../src/utils/workspaceFeatureToggleHelpers.js';

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe('requireOwnerOrSupportAdmin', () => {
  it('allows owner and support_admin', () => {
    const res = mockRes();
    expect(requireOwnerOrSupportAdmin({ user: { role: 'owner' } }, res)).toBe(true);
    expect(requireOwnerOrSupportAdmin({ user: { role: 'support_admin' } }, res)).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  it('rejects other roles with 403', () => {
    const res = mockRes();
    expect(requireOwnerOrSupportAdmin({ user: { role: 'isoplus_user' } }, res)).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/Owner or Support Admin/i);
  });
});

describe('parseWorkspaceIdParam', () => {
  it('returns sanitized workspaceId', () => {
    expect(parseWorkspaceIdParam(' ws-123 ')).toBe('ws-123');
  });

  it('returns null for invalid segments', () => {
    expect(parseWorkspaceIdParam('../evil')).toBeNull();
    expect(parseWorkspaceIdParam('')).toBeNull();
    expect(parseWorkspaceIdParam(null)).toBeNull();
  });
});

describe('feature toggle payload helpers', () => {
  it('defaults missing flag to false', () => {
    expect(getInvoiceStatementAutomationFlag(null)).toBe(false);
    expect(getInvoiceStatementAutomationFlag({})).toBe(false);
    expect(getInvoiceStatementAutomationFlag({ featureToggles: {} })).toBe(false);
  });

  it('reads enabled flag', () => {
    expect(
      getInvoiceStatementAutomationFlag({
        featureToggles: { invoiceStatementAutomation: true },
      })
    ).toBe(true);
  });

  it('builds and normalizes payload for business profile', () => {
    expect(buildFeatureTogglesPayload(null)).toEqual({
      invoiceStatementAutomation: false,
    });
    expect(
      normalizeFeatureTogglesForProfile({ name: 'Acme', featureToggles: {} })
    ).toEqual({
      name: 'Acme',
      featureToggles: { invoiceStatementAutomation: false },
    });
  });

  it('normalizes profile featureToggles when automation is enabled (Epic 1 tab gate)', () => {
    expect(
      normalizeFeatureTogglesForProfile({
        name: 'Acme',
        featureToggles: { invoiceStatementAutomation: true },
      })
    ).toEqual({
      name: 'Acme',
      featureToggles: { invoiceStatementAutomation: true },
    });
  });

  it('treats non-boolean truthy stored values as enabled via Boolean()', () => {
    expect(
      getInvoiceStatementAutomationFlag({
        featureToggles: { invoiceStatementAutomation: 1 },
      })
    ).toBe(true);
  });
});

describe('parseInvoiceStatementAutomationBody', () => {
  it('accepts boolean values', () => {
    expect(parseInvoiceStatementAutomationBody({ invoiceStatementAutomation: true })).toEqual({
      value: true,
    });
    expect(parseInvoiceStatementAutomationBody({ invoiceStatementAutomation: false })).toEqual({
      value: false,
    });
  });

  it('rejects non-boolean values', () => {
    expect(parseInvoiceStatementAutomationBody({})).toEqual({
      error: 'invoiceStatementAutomation must be a boolean',
    });
    expect(parseInvoiceStatementAutomationBody({ invoiceStatementAutomation: 'yes' })).toEqual({
      error: 'invoiceStatementAutomation must be a boolean',
    });
  });
});

describe('upsertInvoiceStatementAutomation persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults new business feature toggle to false', async () => {
    const biz = await Business.create({ name: 'Acme', workspaceId: 'ws-toggle-default' });
    expect(biz.featureToggles.invoiceStatementAutomation).toBe(false);
  });

  it('upserts the flag and findBusinessByWorkspaceId reads it', async () => {
    const updated = await upsertInvoiceStatementAutomation('ws-toggle-1', true);
    expect(updated.featureToggles.invoiceStatementAutomation).toBe(true);

    const found = await findBusinessByWorkspaceId('ws-toggle-1');
    expect(found).not.toBeNull();
    expect(getInvoiceStatementAutomationFlag(found)).toBe(true);

    const disabled = await upsertInvoiceStatementAutomation('ws-toggle-1', false);
    expect(disabled.featureToggles.invoiceStatementAutomation).toBe(false);
  });
});

describe('auditFeatureToggleUpdate (Epic 2 / KAN-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes before/after invoiceStatementAutomation to the audit trail', async () => {
    const req = { user: { email: 'owner@example.com' } };
    await auditFeatureToggleUpdate({
      workspaceId: 'ws-audit-1',
      enabled: true,
      previous: false,
      req,
    });

    expect(logAuditTrail).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-audit-1',
        action: 'Updated workspace feature toggles',
        detail: 'Invoice & Statement Automation set to true',
        entityType: 'Workspace',
        entityId: 'ws-audit-1',
        before: { invoiceStatementAutomation: false },
        after: { invoiceStatementAutomation: true },
        req,
      })
    );
  });
});
