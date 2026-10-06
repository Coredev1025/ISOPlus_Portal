import { describe, it, expect } from 'vitest';
import Business from '../../../src/models/Business.js';

describe('Business model', () => {
  it('creates a Business with default documentNumbering and disabled automation toggle (Epic 2 / KAN-7)', async () => {
    const biz = await Business.create({ name: 'Acme', workspaceId: 'ws-1' });
    expect(biz.documentNumbering.invoice.prefix).toBe('INV-');
    expect(biz.documentNumbering.invoice.nextNumber).toBe(1);
    expect(biz.documentNumbering.purchaseOrder.prefix).toBe('PO-');
    expect(biz.documentNumbering.purchaseOrder.nextNumber).toBe(1);
    expect(biz.documentNumbering.quote.prefix).toBe('QT-');
    expect(biz.documentNumbering.quote.nextNumber).toBe(1);
    expect(biz.documentNumbering.statement.prefix).toBe('STM-');
    expect(biz.documentNumbering.statement.nextNumber).toBe(1);
    expect(biz.xeroIntegrated).toBe(false);
    expect(biz.headOfficeTimezone).toBe('Australia/Sydney');
    expect(biz.featureToggles.invoiceStatementAutomation).toBe(false);
  });

  it('does not declare xeroConnectionLogs on the Business schema', () => {
    expect(Business.schema.path('xeroConnectionLogs')).toBeUndefined();
  });
});

