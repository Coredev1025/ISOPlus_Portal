import { describe, it, expect } from 'vitest';

import {
  buildStatementLedger,
  hasStatementActivity,
} from '../../src/utils/statementLedger.js';
import { invoicesFromDocuments } from '../../src/utils/statementAccountHistory.js';

/**
 * KAN-303. How the statement of account joins invoices (from the document
 * ledger, pdflinks) to payments (from the item marker, invoicedBy) TODAY. Pure
 * functions only: these record current behaviour, accidents included, ahead of
 * KAN-302. See docs/superpowers/specs/2026-10-04-invoice-source-of-truth-design.md.
 *
 * Design cases pinned: b, c, d, g, h, l and the production shape of section 2.6.
 */

const TZ = 'Australia/Sydney';
const PERIOD = { start: '2026-07-01T00:00:00.000+10:00', end: '2026-08-31T23:59:59.999+10:00' };

const doc = (over = {}) => ({
  type: 'NDIS Invoice',
  invoiceNumber: 'INV-1',
  invoiceTotal: 100,
  createdAt: '2026-07-10T00:00:00.000Z',
  ...over,
});

const paid = (marker, amount, date = '2026-07-20') => ({
  itemId: `i-${marker}-${amount}`,
  invoicedBy: marker,
  data: { 'Payment Status': 'Paid', 'Amount Received($)': amount, 'Payment Received Date': date },
});

const build = (documents, items) => buildStatementLedger({
  invoices: invoicesFromDocuments(documents), items, period: PERIOD, openingBalance: 0, timezone: TZ,
});

describe('a payment is applied only when its marker equals a listed invoice number, character for character', () => {
  it('applies a payment whose marker equals the ledger number', () => {
    const { payments, unmatchedPayments } = build([doc()], [paid('INV-1', 40)]);
    expect(payments.map((p) => p.amount)).toEqual([40]);
    expect(unmatchedPayments).toEqual([]);
  });

  it('leaves a payment on a Xero marker unmatched (case c): the Xero invoice has no ledger row', () => {
    const { payments, unmatchedPayments } = build([doc()], [paid('INV-0001 (Xero)', 40)]);
    expect(payments).toEqual([]);
    expect(unmatchedPayments.map((p) => [p.invoiceNumber, p.amount])).toEqual([['INV-0001 (Xero)', 40]]);
  });

  it('leaves a payment on a pending: claim unmatched (case l)', () => {
    const { unmatchedPayments } = build([doc()], [paid('pending:ndis:20260701-0900:Jane', 40)]);
    expect(unmatchedPayments).toHaveLength(1);
  });

  it('leaves a payment on a suffixed marker unmatched against a plain ledger number, and the reverse (case b)', () => {
    const suffixedMarker = build([doc({ invoiceNumber: 'INV-24' })], [paid('INV-24 (ISO+™)', 40)]);
    expect(suffixedMarker.unmatchedPayments).toHaveLength(1);

    const plainMarker = build([doc({ invoiceNumber: 'INV-24 (ISO+™)' })], [paid('INV-24', 40)]);
    expect(plainMarker.unmatchedPayments).toHaveLength(1);
  });

  it('leaves a payment whose invoice has no ledger document unmatched (case d, marker-only)', () => {
    const { unmatchedPayments } = build([doc({ invoiceNumber: 'INV-2' })], [paid('INV-3', 100)]);
    expect(unmatchedPayments.map((p) => p.invoiceNumber)).toEqual(['INV-3']);
  });

  it('does not reduce the closing balance by an unmatched payment', () => {
    const { ledger } = build([doc()], [paid('INV-3', 100)]);
    expect(ledger.closingBalance).toBe(100);
  });
});

describe('two invoice documents for the same work (case g)', () => {
  it('charges both, and the payment follows the invoice number the item\'s marker names', () => {
    const documents = [
      doc({ invoiceNumber: 'INV-1', invoiceTotal: 100, createdAt: '2026-07-10T00:00:00.000Z' }),
      doc({ invoiceNumber: 'INV-2', invoiceTotal: 100, createdAt: '2026-07-20T00:00:00.000Z', pdfLink: 'https://x/2.pdf' }),
    ];
    const { ledger, payments } = build(documents, [paid('INV-1', 100)]);

    expect(payments.map((p) => p.invoiceNumber)).toEqual(['INV-1']);
    expect(ledger.rows.filter((r) => r.charge > 0).map((r) => [r.reference, r.charge]))
      .toEqual([['INV-1', 100], ['INV-2', 100]]);
    expect(ledger.closingBalance).toBe(100);
  });
});

describe('a ledger row with no invoice number (case h)', () => {
  it('KNOWN GAP: becomes a charge with an empty reference that nothing can ever settle', async () => {
    const documents = [doc({ invoiceNumber: undefined, invoiceTotal: 75 })];
    const invoices = invoicesFromDocuments(documents);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].invoiceNumber).toBe('');
    expect(invoices[0].invoiceTotal).toBe(75);

    // A payment is collected only when its item carries a marker, so an item with no
    // marker contributes nothing, and the empty-reference charge stays outstanding.
    const { payments, unmatchedPayments, ledger } = build(documents, [paid('', 75), paid(undefined, 75)]);
    expect(payments).toEqual([]);
    expect(unmatchedPayments).toEqual([]);
    expect(ledger.closingBalance).toBe(75);
  });

  it('is dropped when it has no total, which is how a hand-raised row from before the figure was recorded behaves', () => {
    expect(invoicesFromDocuments([doc({ invoiceNumber: undefined, invoiceTotal: undefined })])).toEqual([]);
  });
});

describe('the production shape (design section 2.6): documents with no number and no total', () => {
  // On the 2026-10-03 production snapshot every invoice-type pdflinks row (19 of
  // them) has no invoiceNumber and no invoiceTotal, and no item has a marker.
  const productionRows = [
    { type: 'NDIS Invoice', pdfLink: 'https://s3/a.pdf', createdAt: '2026-06-01T00:00:00.000Z' },
    { type: 'NDIS Invoice', pdfLink: 'https://s3/b.pdf', createdAt: '2026-06-15T00:00:00.000Z' },
    { type: 'Invoice', pdfLink: 'https://s3/c.pdf', createdAt: '2026-06-20T00:00:00.000Z' },
  ];

  it('lists no invoices at all', () => {
    expect(invoicesFromDocuments(productionRows)).toEqual([]);
  });

  it('shows no statement activity, so a customer with only such invoices gets nothing, or a balance of zero', () => {
    const { ledger } = build(productionRows, []);
    expect(ledger.rows).toEqual([]);
    expect(hasStatementActivity(ledger)).toBe(false);
  });

  it('would also leave a payment unmatched, since there are no invoices to apply it to', () => {
    const { unmatchedPayments, ledger } = build(productionRows, [paid('INV-22', 100)]);
    expect(unmatchedPayments).toHaveLength(1);
    expect(ledger.closingBalance).toBe(0);
  });
});
