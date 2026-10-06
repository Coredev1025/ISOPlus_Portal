import { describe, it, expect } from 'vitest';

import {
  invoicesFromDocuments,
  openingBalanceBefore,
} from '../../../src/utils/statementAccountHistory.js';

const doc = (over = {}) => ({
  type: 'NDIS Invoice',
  invoiceNumber: 'INV-1001',
  invoiceTotal: 100,
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

describe('invoicesFromDocuments', () => {
  it('keeps only invoice documents, not statements', () => {
    const invoices = invoicesFromDocuments([
      doc(),
      doc({ type: 'Monthly Statement', invoiceNumber: 'STMT-1', invoiceTotal: undefined }),
    ]);
    expect(invoices.map((i) => i.invoiceNumber)).toEqual(['INV-1001']);
  });

  it('drops a row with no billed figure, which cannot be charged on a statement', () => {
    expect(invoicesFromDocuments([doc({ invoiceTotal: undefined })])).toEqual([]);
  });

  // Section 4.3: ageing runs from the due date. PDFLink stores no due date, so
  // it is derived the same way manual invoicing sets it — issue plus 14 days.
  it('derives a due date fourteen days after issue', () => {
    const [invoice] = invoicesFromDocuments([doc()]);
    expect(new Date(invoice.dueDate).toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });

  // Mongoose defaults createdAt, so only a hand-inserted row lacks it — and
  // the seeding recipe in the docs is exactly how such rows get made. Without
  // a date the invoice cannot be placed on the ledger, and deriving a due
  // date from it threw a RangeError instead.
  it('drops a row with no createdAt rather than throwing', () => {
    expect(invoicesFromDocuments([doc({ createdAt: undefined })])).toEqual([]);
  });

  // The invoice's own date, not the moment its row was written. They agree for
  // a scheduled run that fires on time and disagree for every other case: a
  // held or caught-up slot, and an invoice raised by hand where the operator
  // sets `Invoice Date` on the item. A statement that dates a charge by the
  // write time contradicts the invoice it is reporting, and a backdated
  // invoice lands on today rather than in the month it belongs to.
  it('dates a charge by the invoice date when the row carries one', () => {
    const [invoice] = invoicesFromDocuments([
      doc({ invoiceDate: '2026-06-20T00:00:00.000Z', createdAt: '2026-09-10T11:26:27.000Z' }),
    ]);
    expect(new Date(invoice.createdAt).toISOString()).toBe('2026-06-20T00:00:00.000Z');
  });

  it('ages a backdated invoice from its own date, not from when it was recorded', () => {
    const [invoice] = invoicesFromDocuments([
      doc({ invoiceDate: '2026-06-20T00:00:00.000Z', createdAt: '2026-09-10T11:26:27.000Z' }),
    ]);
    expect(new Date(invoice.dueDate).toISOString()).toBe('2026-07-04T00:00:00.000Z');
  });

  // Every row written before the field existed has none, and they must keep
  // behaving exactly as they did.
  it('falls back to the write time when there is no invoice date', () => {
    const [invoice] = invoicesFromDocuments([doc()]);
    expect(new Date(invoice.createdAt).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  // An unusable value must not silently become the epoch, which would file the
  // invoice in 1970 and put the whole ledger out of order.
  it('ignores an unusable invoice date rather than filing the invoice at the epoch', () => {
    const [invoice] = invoicesFromDocuments([doc({ invoiceDate: 'not a date' })]);
    expect(new Date(invoice.createdAt).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('carries the billed figure through unchanged', () => {
    const [invoice] = invoicesFromDocuments([doc({ invoiceTotal: 1232.5 })]);
    expect(invoice.invoiceTotal).toBe(1232.5);
  });
});

describe('openingBalanceBefore', () => {
  const invoices = [
    { invoiceNumber: 'INV-1', invoiceTotal: 100, createdAt: '2026-07-01T00:00:00.000Z' },
    { invoiceNumber: 'INV-2', invoiceTotal: 50, createdAt: '2026-08-10T00:00:00.000Z' },
  ];
  const payments = [
    { invoiceNumber: 'INV-1', amount: 40, date: '2026-07-20T00:00:00.000Z' },
    { invoiceNumber: 'INV-2', amount: 50, date: '2026-08-20T00:00:00.000Z' },
  ];

  it('is what was owing when the period opened', () => {
    expect(openingBalanceBefore(invoices, payments, '2026-08-01T00:00:00.000Z')).toBe(60);
  });

  it('is nought for an account with no history', () => {
    expect(openingBalanceBefore([], [], '2026-08-01T00:00:00.000Z')).toBe(0);
  });

  // An undated payment takes its invoice's date, the same rule the ledger
  // applies, so the two agree on which side of the boundary it fell. Dropping
  // it here while the ageing kept it is what made section 4.3's check throw.
  it('places a payment with no date on its invoice', () => {
    expect(openingBalanceBefore(invoices, [{ invoiceNumber: 'INV-1', amount: 40 }], '2026-08-01T00:00:00.000Z'))
      .toBe(60);
  });

  it('leaves an undated payment on an invoice raised in the period out of the opening balance', () => {
    expect(openingBalanceBefore(invoices, [{ invoiceNumber: 'INV-2', amount: 50 }], '2026-08-01T00:00:00.000Z'))
      .toBe(100);
  });
});
