import { describe, it, expect } from 'vitest';

import {
  buildStatementLedger,
  collectPayments,
  hasStatementActivity,
} from '../../../src/utils/statementLedger.js';

/**
 * Turning invoices and payments into the settled statement the renderer takes.
 *
 * Charges come from the document ledger, not from re-adding the items — section
 * 4.2 says to carry the figure the invoice billed through unchanged, and for
 * Age Care that figure depends on whether the board is Low Cat.
 *
 * Payments come from the ISO+ service records, where they are entered by hand.
 */

const TZ = 'Australia/Sydney';
const PERIOD = { start: '2026-07-01T00:00:00.000+10:00', end: '2026-08-31T23:59:59.999+10:00' };

const invoice = (invoiceNumber, createdAt, invoiceTotal, dueDate) => ({
  invoiceNumber, createdAt, invoiceTotal, dueDate,
});

const paidItem = (invoicedBy, amount, date) => ({
  itemId: `i-${invoicedBy}-${amount}`,
  invoicedBy,
  data: {
    'Payment Status': 'Paid',
    'Amount Received($)': amount,
    'Invoice Received Date': date,
  },
});

describe('collectPayments', () => {
  it('reads the amount and date off the service record', () => {
    const payments = collectPayments([paidItem('INV-1', 500, '2026-07-20')]);
    expect(payments).toEqual([
      { invoiceNumber: 'INV-1', amount: 500, date: '2026-07-20' },
    ]);
  });

  it('sums several records paid against the same invoice', () => {
    const payments = collectPayments([
      paidItem('INV-1', 300, '2026-07-20'),
      paidItem('INV-1', 200, '2026-07-20'),
    ]);
    expect(payments).toHaveLength(2);
    expect(payments.reduce((sum, p) => sum + p.amount, 0)).toBe(500);
  });

  it('ignores a record with no amount received', () => {
    expect(collectPayments([paidItem('INV-1', 0, '2026-07-20')])).toEqual([]);
  });

  it('ignores a record that was never invoiced', () => {
    const orphan = { itemId: 'x', data: { 'Amount Received($)': 100, 'Invoice Received Date': '2026-07-20' } };
    expect(collectPayments([orphan])).toEqual([]);
  });

  it('reads a dollar-formatted amount, not just a number', () => {
    const payments = collectPayments([paidItem('INV-1', '$1,232.50', '2026-07-20')]);
    expect(payments[0].amount).toBe(1232.5);
  });
});

describe('buildStatementLedger — dated payments', () => {
  const invoices = [
    invoice('INV-1160', '2026-07-01', 1195, '2026-08-15'),
    invoice('INV-1161', '2026-08-01', 1232.5, '2026-09-14'),
  ];

  it('makes one charge row per invoice, carrying its billed total', () => {
    const { ledger } = buildStatementLedger({
      invoices, items: [], period: PERIOD, openingBalance: 0, timezone: TZ,
    });
    expect(ledger.rows.map((r) => [r.reference, r.charge]))
      .toEqual([['INV-1160', 1195], ['INV-1161', 1232.5]]);
    expect(ledger.closingBalance).toBe(2427.5);
  });

  it('interleaves payments with charges in date order', () => {
    const items = [paidItem('INV-1160', 1195, '2026-07-20')];
    const { ledger } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ,
    });
    expect(ledger.rows.map((r) => r.reference))
      .toEqual(['INV-1160', 'INV-1160', 'INV-1161']);
    expect(ledger.rows[1].payment).toBe(1195);
    expect(ledger.closingBalance).toBe(1232.5);
  });

  it('ages only what is still outstanding on each invoice', () => {
    const items = [paidItem('INV-1160', 1195, '2026-07-20')];
    const { ageing } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ,
      asAt: '2026-08-31T00:00:00.000+10:00',
    });
    // INV-1160 is settled, so only INV-1161 ages, and it is not yet due.
    expect(ageing.current).toBe(1232.5);
    expect(ageing.d1to30).toBe(0);
  });

  it('reconciles: the ageing buckets sum to the closing balance', () => {
    const items = [paidItem('INV-1160', 500, '2026-07-20')];
    const { ledger, ageing } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ,
      asAt: '2026-08-31T00:00:00.000+10:00',
    });
    const bucketTotal = Object.values(ageing).reduce((sum, v) => sum + v, 0);
    expect(bucketTotal).toBe(ledger.closingBalance);
  });

  it('excludes an invoice raised outside the period', () => {
    const outside = [invoice('INV-OLD', '2025-01-01', 900, '2025-01-15')];
    const { ledger } = buildStatementLedger({
      invoices: outside, items: [], period: PERIOD, openingBalance: 0, timezone: TZ,
    });
    expect(ledger.rows).toEqual([]);
  });

  it('treats an invoice with no recorded total as zero rather than NaN', () => {
    const untotalled = [invoice('INV-X', '2026-07-01', undefined, '2026-08-15')];
    const { ledger } = buildStatementLedger({
      invoices: untotalled, items: [], period: PERIOD, openingBalance: 0, timezone: TZ,
    });
    expect(ledger.closingBalance).toBe(0);
  });
});

describe('buildStatementLedger — no payment date available', () => {
  const invoices = [invoice('INV-1160', '2026-07-01', 1195, '2026-08-15')];
  const items = [paidItem('INV-1160', 500, '2026-07-20')];

  it('nets the payment against its invoice instead of making a dated row', () => {
    const { ledger } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, datedPayments: false,
    });
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].charge).toBe(1195);
    expect(ledger.rows[0].payment).toBe(500);
    expect(ledger.closingBalance).toBe(695);
  });

  it('still reconciles against the ageing', () => {
    const { ledger, ageing } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, datedPayments: false,
      asAt: '2026-08-31T00:00:00.000+10:00',
    });
    const bucketTotal = Object.values(ageing).reduce((sum, v) => sum + v, 0);
    expect(bucketTotal).toBe(ledger.closingBalance);
  });
});

describe('hasStatementActivity (section 4.5)', () => {
  it('is false when there was no activity and nothing is owing', () => {
    const { ledger } = buildStatementLedger({
      invoices: [], items: [], period: PERIOD, openingBalance: 0, timezone: TZ,
    });
    expect(hasStatementActivity(ledger)).toBe(false);
  });

  it('is true when something is still owing, even with no activity in the period', () => {
    const { ledger } = buildStatementLedger({
      invoices: [], items: [], period: PERIOD, openingBalance: 250, timezone: TZ,
    });
    expect(hasStatementActivity(ledger)).toBe(true);
  });

  it('is true when there was activity, even if it nets to zero', () => {
    const invoices = [invoice('INV-1', '2026-07-01', 100, '2026-07-15')];
    const { ledger } = buildStatementLedger({
      invoices, items: [paidItem('INV-1', 100, '2026-07-20')], period: PERIOD, openingBalance: 0, timezone: TZ,
    });
    expect(ledger.closingBalance).toBe(0);
    expect(hasStatementActivity(ledger)).toBe(true);
  });
});

/**
 * Found by a local end-to-end run, which failed the statement rather than
 * sending it: buckets totalling 423.70 against a closing balance of 400.50.
 *
 * Ageing considered every invoice ever raised, including one raised *after*
 * the period the statement covers — so the statement's own two figures could
 * not agree, and section 4.3's check refused the document. Every invoice is
 * still considered, which is what the 90+ bucket needs; the boundary is that
 * the statement cannot know about a document that did not exist yet when it
 * was struck.
 */
describe('buildStatementLedger — ageing stops at the statement date', () => {
  const period = { start: '2025-01-01T00:00:00.000Z', end: '2025-01-31T23:59:59.999Z' };

  it('ignores an invoice raised after the period it covers', () => {
    const { ledger, ageing } = buildStatementLedger({
      invoices: [
        {
          invoiceNumber: 'INV-1', invoiceTotal: 420.5, createdAt: '2025-01-10T00:00:00.000Z', dueDate: '2025-01-24T00:00:00.000Z',
        },
        // Raised eighteen months later; no business appearing on this statement.
        {
          invoiceNumber: 'INV-2', invoiceTotal: 23.2, createdAt: '2026-09-08T00:00:00.000Z', dueDate: '2026-09-22T00:00:00.000Z',
        },
      ],
      period,
      openingBalance: 0,
    });

    const bucketTotal = Object.values(ageing).reduce((sum, value) => sum + value, 0);
    expect(bucketTotal).toBe(ledger.closingBalance);
    expect(bucketTotal).toBe(420.5);
  });

  it('ignores a payment recorded after the period it covers', () => {
    const { ledger, ageing } = buildStatementLedger({
      invoices: [{
        invoiceNumber: 'INV-1', invoiceTotal: 100, createdAt: '2025-01-10T00:00:00.000Z', dueDate: '2025-01-24T00:00:00.000Z',
      }],
      items: [{
        invoicedBy: 'INV-1',
        data: { 'Amount Received($)': '100', 'Invoice Received Date': '2026-09-08T00:00:00.000Z' },
      }],
      period,
      openingBalance: 0,
    });

    const bucketTotal = Object.values(ageing).reduce((sum, value) => sum + value, 0);
    expect(bucketTotal).toBe(ledger.closingBalance);
    expect(bucketTotal).toBe(100);
  });
});
