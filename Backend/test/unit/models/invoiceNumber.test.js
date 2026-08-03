import { describe, it, expect } from 'vitest';
import InvoiceNumber from '../../../src/models/InvoiceNumber.js';

describe('InvoiceNumber model', () => {
  it('requires itemId, workspaceId, boardId, invoiceNumber and type', async () => {
    await expect(InvoiceNumber.create({})).rejects.toThrow();
  });

  it('accepts PDF and Xero types', async () => {
    const pdf = await InvoiceNumber.create({
      itemId: 'i1', workspaceId: 'ws', boardId: 'b', invoiceNumber: 'INV-1', type: 'PDF',
    });
    expect(pdf.type).toBe('PDF');
    const xero = await InvoiceNumber.create({
      itemId: 'i2', workspaceId: 'ws', boardId: 'b', invoiceNumber: 'INV-2', type: 'Xero',
    });
    expect(xero.type).toBe('Xero');
  });

  it('rejects invalid type', async () => {
    await expect(
      InvoiceNumber.create({
        itemId: 'i3', workspaceId: 'ws', boardId: 'b', invoiceNumber: 'INV-3', type: 'Other',
      })
    ).rejects.toThrow();
  });
});
