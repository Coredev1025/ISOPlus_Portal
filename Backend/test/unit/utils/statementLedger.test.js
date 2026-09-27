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

  // KAN-274: every invoice ever raised for the participant is its own line
  // item now, not only the ones this statement's period happens to span — an
  // invoice raised well before the period still shows, same as one raised
  // just after it (the case the ticket's live reproduction turned on).
  it('includes an invoice raised outside the period, up to the asAt cutoff', () => {
    const outside = [invoice('INV-OLD', '2025-01-01', 900, '2025-01-15')];
    const { ledger } = buildStatementLedger({
      invoices: outside, items: [], period: PERIOD, openingBalance: 0, timezone: TZ,
    });
    expect(ledger.rows.map((r) => [r.reference, r.charge])).toEqual([['INV-OLD', 900]]);
    expect(ledger.closingBalance).toBe(900);
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

/**
 * KAN-274: the live reproduction. An invoice generated the day after its own
 * statement's period closed — the automated invoicing job's own eligibility
 * window always excludes its own run day, so a freshly generated invoice's
 * `createdAt` lands just outside whatever statement period is current at
 * generation time — was completely invisible as a line item on the very next
 * statement, only ever reflected in the ageing/closing-balance figures.
 *
 * INV-14 ($2,765.06), generated 27/09/2026. SOA-116, period 26/09–26/09/2026,
 * showed Opening $15,158.36 / Charges $0.00 / Closing $15,158.36 under the old
 * period-only filter — invisible as a row despite existing.
 */
describe('buildStatementLedger — an invoice raised the day after the period closes', () => {
  const dailyPeriod = { start: '2026-09-26T00:00:00.000+10:00', end: '2026-09-26T23:59:59.999+10:00' };

  it('is not shown when the statement is struck before the invoice exists (period.end as asAt)', () => {
    const invoices = [invoice('INV-14', '2026-09-27T00:00:00.000+10:00', 2765.06, '2026-10-11')];
    const { ledger } = buildStatementLedger({
      invoices, items: [], period: dailyPeriod, openingBalance: 0, timezone: TZ,
    });
    // Struck as-at the period's own end, the invoice did not exist yet.
    expect(ledger.rows).toEqual([]);
  });

  it('appears as its own charge row once the statement is struck after the invoice exists', () => {
    const invoices = [invoice('INV-14', '2026-09-27T00:00:00.000+10:00', 2765.06, '2026-10-11')];
    const { ledger } = buildStatementLedger({
      invoices,
      items: [],
      period: dailyPeriod,
      openingBalance: 0,
      timezone: TZ,
      // The moment generation actually happened — later than the period it
      // covers, which is what lets this statement see the invoice at all.
      asAt: '2026-09-27T09:00:00.000+10:00',
    });
    expect(ledger.rows.map((r) => [r.reference, r.charge])).toEqual([['INV-14', 2765.06]]);
    expect(ledger.closingBalance).toBe(2765.06);
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

/**
 * A payment with an amount but no received date. ISO+ lets the two be entered
 * separately, so this arrives from real boards.
 *
 * It has to land on the same side of every figure. Kept in the ageing and
 * dropped from the ledger, the buckets and the closing balance disagree and
 * section 4.3's check throws — which failed the whole board's run, not just
 * this participant's. So an undated payment takes its invoice's date: netted
 * onto the charge row, as the non-dated mode already does, and counted in
 * the ageing against the same invoice.
 */
describe('buildStatementLedger — a payment with no date', () => {
  const asAt = '2026-08-31T00:00:00.000+10:00';

  it('nets onto its invoice\'s charge row and still reconciles', () => {
    const invoices = [invoice('INV-1', '2026-08-05', 250, '2026-08-19')];
    const items = [paidItem('INV-1', 100, undefined)];
    const { ledger, ageing } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt,
    });
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].payment).toBe(100);
    expect(ledger.closingBalance).toBe(150);
    const bucketTotal = Object.values(ageing).reduce((sum, v) => sum + v, 0);
    expect(bucketTotal).toBe(150);
  });

  it('is not given a dated row of its own as well', () => {
    const invoices = [invoice('INV-1', '2026-08-05', 250, '2026-08-19')];
    const items = [paidItem('INV-1', 100, undefined), paidItem('INV-1', 50, '2026-08-20')];
    const { ledger } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt,
    });
    expect(ledger.rows.map((r) => r.payment)).toEqual([100, 50]);
    expect(ledger.closingBalance).toBe(100);
  });

  // KAN-274: an invoice raised before the period is now its own charge row
  // too, so the caller no longer supplies a non-zero opening balance for it —
  // doing so would double-count it, once on the line and once in the opening
  // figure. Passing 0 here is the contract `generateStatementOfAccount.js`
  // now follows.
  it('ages against an invoice raised before the period, as its own row', () => {
    const invoices = [invoice('INV-OLD', '2026-03-01', 250, '2026-03-15')];
    const items = [paidItem('INV-OLD', 100, undefined)];
    const { ledger, ageing } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt,
    });
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].charge).toBe(250);
    expect(ledger.rows[0].payment).toBe(100);
    expect(ledger.closingBalance).toBe(150);
    expect(ageing.d90plus).toBe(150);
  });
});

/**
 * Three invoices on one statement, asked for by the client so the arithmetic
 * could be checked rather than taken on trust. Every figure below is written
 * out longhand in the assertion, so a reader can add it up by eye.
 *
 * The three are raised inside the period and total $3,600.00:
 *   INV-3001  $1,000.00  raised 05/07, due 19/07
 *   INV-3002  $1,200.00  raised 12/07, due 26/07
 *   INV-3003  $1,400.00  raised 20/08, due 03/09
 *
 * The statement is read as at 31 August 2026, which is after the first two
 * fell due and before the third does.
 */
describe('buildStatementLedger — three invoices on one statement', () => {
  const AS_AT = '2026-08-31T00:00:00.000+10:00';
  const invoices = [
    invoice('INV-3001', '2026-07-05', 1000, '2026-07-19'),
    invoice('INV-3002', '2026-07-12', 1200, '2026-07-26'),
    invoice('INV-3003', '2026-08-20', 1400, '2026-09-03'),
  ];
  const ledgerFor = (items) => buildStatementLedger({
    invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt: AS_AT,
  });
  const bucketSum = (ageing) => Object.values(ageing).reduce((sum, v) => sum + v, 0);

  it('charges all three, once each, and totals them', () => {
    const { ledger } = ledgerFor([]);
    expect(ledger.rows.map((r) => [r.reference, r.charge])).toEqual([
      ['INV-3001', 1000],
      ['INV-3002', 1200],
      ['INV-3003', 1400],
    ]);
    expect(ledger.totalCharges).toBe(3600);
  });

  // All unpaid: nothing received, so the whole $3,600.00 is still owing.
  it('all unpaid: closes at the full 3,600.00 and the ageing agrees', () => {
    const { ledger, ageing } = ledgerFor([]);
    expect(ledger.totalPayments).toBe(0);
    expect(ledger.closingBalance).toBe(3600);
    // 3001 is 43 days overdue, 3002 is 36, both in the 31-60 bucket; 3003 is
    // not yet due, so it sits in Current.
    expect(ageing.d31to60).toBe(2200);
    expect(ageing.current).toBe(1400);
    expect(bucketSum(ageing)).toBe(3600);
  });

  // One paid, two unpaid: 3,600.00 charged less 1,000.00 received.
  it('one paid, two unpaid: closes at 2,600.00 and the ageing agrees', () => {
    const { ledger, ageing } = ledgerFor([paidItem('INV-3001', 1000, '2026-07-20')]);
    expect(ledger.totalCharges).toBe(3600);
    expect(ledger.totalPayments).toBe(1000);
    expect(ledger.closingBalance).toBe(2600);
    // INV-3001 is settled and drops out of the ageing entirely.
    expect(ageing.d31to60).toBe(1200);
    expect(ageing.current).toBe(1400);
    expect(bucketSum(ageing)).toBe(2600);
  });

  // All paid: every invoice settled in full, so the account closes at zero and
  // every ageing bucket is empty.
  it('all paid: closes at zero with nothing left to age', () => {
    const { ledger, ageing } = ledgerFor([
      paidItem('INV-3001', 1000, '2026-07-20'),
      paidItem('INV-3002', 1200, '2026-07-28'),
      paidItem('INV-3003', 1400, '2026-08-25'),
    ]);
    expect(ledger.totalCharges).toBe(3600);
    expect(ledger.totalPayments).toBe(3600);
    expect(ledger.closingBalance).toBe(0);
    expect(bucketSum(ageing)).toBe(0);
  });

  // A part payment against one invoice: the remainder keeps ageing, and the
  // two figures the document prints still have to agree.
  it('part payment: only the unpaid remainder ages', () => {
    const { ledger, ageing } = ledgerFor([paidItem('INV-3002', 500, '2026-07-28')]);
    expect(ledger.totalPayments).toBe(500);
    expect(ledger.closingBalance).toBe(3100);
    // INV-3001 in full plus the $700.00 still open on INV-3002.
    expect(ageing.d31to60).toBe(1700);
    expect(ageing.current).toBe(1400);
    expect(bucketSum(ageing)).toBe(3100);
  });

  // Section 4.4: the last running balance must equal the stated closing
  // balance, whatever mix of payments the period carries.
  it('the running balance ends on the stated closing balance', () => {
    for (const items of [
      [],
      [paidItem('INV-3001', 1000, '2026-07-20')],
      [paidItem('INV-3001', 1000, '2026-07-20'), paidItem('INV-3002', 1200, '2026-07-28')],
      [paidItem('INV-3002', 500, '2026-07-28')],
    ]) {
      const { ledger } = ledgerFor(items);
      expect(ledger.rows.at(-1).balance).toBe(ledger.closingBalance);
    }
  });
});
