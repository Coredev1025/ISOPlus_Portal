import { describe, it, expect } from 'vitest';

import { invoicesFromLedger, itemsOnActiveInvoices, unusableInvoices } from '../../../src/utils/invoiceLedger/statementSource.js';

/**
 * What the statement of account takes from the invoice record (KAN-309): the invoices,
 * and for every service record the invoice it currently belongs to, so a payment is
 * matched to its invoice by the record and never by the text of a number.
 */

const invoice = (over = {}) => ({
  _id: 'i1',
  number: 'INV-1',
  source: 'portal',
  total: 100,
  issuedAt: new Date('2026-07-10T00:00:00Z'),
  dueDate: new Date('2026-07-24T00:00:00Z'),
  status: 'issued',
  lines: [{ itemId: 'a', amount: 100 }],
  ...over,
});

describe('invoicesFromLedger', () => {
  it('takes the plain number, the total, the issue date and the due date', () => {
    expect(invoicesFromLedger([invoice()])).toEqual([{
      key: 'i1',
      invoiceNumber: 'INV-1',
      invoiceTotal: 100,
      createdAt: new Date('2026-07-10T00:00:00Z'),
      dueDate: new Date('2026-07-24T00:00:00Z'),
      description: 'Services invoiced',
    }]);
  });

  it('derives a due date of fourteen days when the invoice has none', () => {
    const [row] = invoicesFromLedger([invoice({ dueDate: undefined })]);
    expect(new Date(row.dueDate).toISOString().slice(0, 10)).toBe('2026-07-24');
  });

  it('rounds the total to cents and keeps duplicate numbers as separate invoices', () => {
    const rows = invoicesFromLedger([invoice({ total: 10.005 }), invoice({ _id: 'i2', duplicateOrdinal: 1 })]);
    expect(rows).toHaveLength(2);
    expect(rows[0].invoiceTotal).toBe(10.01);
  });

  it('leaves out an invoice with no usable total or issue date instead of stating $0 or throwing', () => {
    const rows = invoicesFromLedger([
      invoice({ _id: 'ok' }),
      invoice({ _id: 'no-total', total: undefined }),
      invoice({ _id: 'no-date', issuedAt: undefined, dueDate: undefined }),
      invoice({ _id: 'bad-date', issuedAt: 'not a date' }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['ok']);
    expect(unusableInvoices([invoice(), invoice({ _id: 'x', total: null })]).map((i) => i._id)).toEqual(['x']);
  });

  it('is empty for no invoices', () => {
    expect(invoicesFromLedger([])).toEqual([]);
    expect(invoicesFromLedger(undefined)).toEqual([]);
  });
});

describe('itemsOnActiveInvoices', () => {
  const item = (itemId, invoicedBy) => ({ itemId, invoicedBy, data: { 'Amount Received($)': 5 } });

  it('names the number of the invoice each item is on, whatever its marker says', () => {
    const active = new Map([['a', invoice()], ['b', invoice({ number: 'INV-9' })]]);
    const result = itemsOnActiveInvoices([item('a', 'INV-1 (ISO+™)'), item('b', 'INV-1')], active);
    expect(result.map((i) => i.invoicedBy)).toEqual(['INV-1', 'INV-9']);
  });

  it('carries the record id of the invoice, so two invoices with one number stay apart', () => {
    const active = new Map([['a', invoice({ _id: 'k9' })]]);
    expect(itemsOnActiveInvoices([item('a', 'INV-1')], active)[0].invoiceKey).toBe('k9');
  });

  it('keeps the marker of an item on no invoice, so its payment is reported as unmatched', () => {
    const result = itemsOnActiveInvoices([item('z', 'INV-3')], new Map());
    expect(result[0].invoicedBy).toBe('INV-3');
  });

  it('does not change its input', () => {
    const input = [item('a', 'old')];
    itemsOnActiveInvoices(input, new Map([['a', invoice()]]));
    expect(input[0].invoicedBy).toBe('old');
  });
});
