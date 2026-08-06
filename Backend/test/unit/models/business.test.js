import { describe, it, expect } from 'vitest';
import Business from '../../../src/models/Business.js';

describe('Business model', () => {
  it('creates a Business with default documentNumbering', async () => {
    const biz = await Business.create({ name: 'Acme', workspaceId: 'ws-1' });
    expect(biz.documentNumbering.invoice.prefix).toBe('INV-');
    expect(biz.documentNumbering.invoice.nextNumber).toBe(1000);
    expect(biz.documentNumbering.purchaseOrder.prefix).toBe('PO-');
    expect(biz.documentNumbering.quote.prefix).toBe('QT-');
    expect(biz.xeroIntegrated).toBe(false);
    expect(biz.headOfficeTimezone).toBe('Australia/Sydney');
    expect(biz.featureToggles.invoiceStatementAutomation).toBe(false);
  });
});

