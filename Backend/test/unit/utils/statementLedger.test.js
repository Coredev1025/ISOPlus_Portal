import { describe, it, expect } from 'vitest';

import {
  buildStatementLedger,
  collectPayments,
  hasStatementActivity,
} from '../../../src/utils/statementLedger.js';
import { assertAgeingReconciles } from '../../../src/utils/statementAgeing.js';

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
    'Payment Received Date': date,
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

  // KAN-285: an amount with no Payment Received Date is bad data. It is not a
  // payment the statement can place, so it is not collected at all.
  it('ignores an amount received that has no Payment Received Date', () => {
    expect(collectPayments([paidItem('INV-1', 100, undefined)])).toEqual([]);
    expect(collectPayments([paidItem('INV-1', 100, '')])).toEqual([]);
    expect(collectPayments([paidItem('INV-1', 100, null)])).toEqual([]);
  });

  it('ignores an amount received whose date cannot be read', () => {
    expect(collectPayments([paidItem('INV-1', 100, 'not a date')])).toEqual([]);
  });

  it('keeps the dated payment and drops the undated one on the same invoice', () => {
    const payments = collectPayments([
      paidItem('INV-1', 10, undefined),
      paidItem('INV-1', 5, '2026-09-30'),
    ]);
    expect(payments).toEqual([{ invoiceNumber: 'INV-1', amount: 5, date: '2026-09-30' }]);
  });

  it('ignores a record that was never invoiced', () => {
    const orphan = { itemId: 'x', data: { 'Amount Received($)': 100, 'Payment Received Date': '2026-07-20' } };
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

  // KAN-273: the statement's Due Date column read nothing — the invoice's own
  // due date was computed (statementAccountHistory.js) but never carried onto
  // the charge row, so the printed statement fell back to a template
  // placeholder ("XX/XX/XX") instead of the real date.
  it('carries the invoice due date onto its own charge row', () => {
    const { ledger } = buildStatementLedger({
      invoices, items: [], period: PERIOD, openingBalance: 0, timezone: TZ,
    });
    expect(ledger.rows.map((r) => r.dueDate)).toEqual(['2026-08-15', '2026-09-14']);
  });

  // A payment row is not an invoice and has no due date of its own — it must
  // not inherit the charge row's date.
  it('leaves the due date blank on a payment row', () => {
    const items = [paidItem('INV-1160', 1195, '2026-07-20')];
    const { ledger } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ,
    });
    const paymentRow = ledger.rows.find((r) => r.payment > 0);
    expect(paymentRow.dueDate).toBeUndefined();
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

/**
 * KAN-277: a payment dated "today" — a bare YYYY-MM-DD from the date picker —
 * checked a few hours into that same calendar day in the business timezone.
 *
 * `new Date('2026-09-28')` parses as UTC midnight, which is 10:00am in
 * Melbourne (AEST, UTC+10 — DST does not start until the first Sunday of
 * October 2026). Naive UTC comparison then treats the payment as still hours
 * in the future for the first part of every Melbourne business day, and
 * `raisedBy` wrongly excludes it — confirmed live on 2026-09-27/28.
 */
describe('buildStatementLedger — a payment dated today, checked early the same day (KAN-277)', () => {
  it('includes a payment dated today when asAt is only a few hours into that Melbourne day', () => {
    const invoices = [invoice('INV-1', '2026-09-01T00:00:00.000+10:00', 500, '2026-09-15')];
    const items = [paidItem('INV-1', 500, '2026-09-28')];
    const { ledger } = buildStatementLedger({
      invoices,
      items,
      period: PERIOD,
      openingBalance: 0,
      timezone: 'Australia/Melbourne',
      // 2:34am Melbourne on the 28th — still 16:34 UTC on the 27th, the exact
      // shape of the live reproduction.
      asAt: '2026-09-28T02:34:00.000+10:00',
    });
    const paymentRow = ledger.rows.find((r) => r.payment > 0);
    expect(paymentRow).toBeDefined();
    expect(paymentRow?.date).toBe('2026-09-28');
    expect(ledger.closingBalance).toBe(0);
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
        data: { 'Amount Received($)': '100', 'Payment Received Date': '2026-09-08T00:00:00.000Z' },
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
 * A payment with an amount but no received date (KAN-285). ISO+ lets the two be
 * entered separately, so this arrives from real boards.
 *
 * It is bad data, and it is left off the statement entirely: not netted onto
 * its invoice's row, not given a row of its own, not in the closing balance and
 * not in the ageing. All of those read the same collected payments, so the
 * ledger and the ageing still agree and section 4.3's check cannot throw.
 * (Earlier it was netted onto its invoice, which silently reduced what the
 * participant was shown as owing.)
 */
describe('buildStatementLedger — a payment with no date', () => {
  const asAt = '2026-08-31T00:00:00.000+10:00';
  const bucketSum = (ageing) => Object.values(ageing).reduce((sum, v) => sum + v, 0);

  it('is left off the statement: the invoice row shows no payment and the balance is the full amount', () => {
    const invoices = [invoice('INV-1', '2026-08-05', 250, '2026-08-19')];
    const items = [paidItem('INV-1', 100, undefined)];
    const { ledger, ageing } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt,
    });
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].payment).toBe(0);
    expect(ledger.closingBalance).toBe(250);
    expect(bucketSum(ageing)).toBe(250);
  });

  it('does not stop a dated payment on the same invoice getting its own row', () => {
    const invoices = [invoice('INV-1', '2026-08-05', 250, '2026-08-19')];
    const items = [paidItem('INV-1', 100, undefined), paidItem('INV-1', 50, '2026-08-20')];
    const { ledger, ageing } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt,
    });
    expect(ledger.rows.map((r) => [r.description, r.payment])).toEqual([
      ['Services invoiced', 0],
      ['Payment received', 50],
    ]);
    expect(ledger.closingBalance).toBe(200);
    expect(bucketSum(ageing)).toBe(200);
  });

  // The live case from SOA-9: $10 with no date and $5 dated 30/09 against one
  // invoice were shown combined as a single $15.00 payment.
  it('does not combine an undated $10 with a dated $5 into $15', () => {
    const invoices = [invoice('INV-24', '2026-08-05', 171.25, '2026-08-19')];
    const items = [paidItem('INV-24', 10, undefined), paidItem('INV-24', 5, '2026-08-30')];
    const { ledger } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt,
    });
    expect(ledger.rows.map((r) => r.payment)).toEqual([0, 5]);
    expect(ledger.closingBalance).toBe(166.25);
  });

  it('is left off in the non-dated mode as well', () => {
    const invoices = [invoice('INV-1', '2026-08-05', 250, '2026-08-19')];
    const items = [paidItem('INV-1', 100, undefined), paidItem('INV-1', 50, '2026-08-20')];
    const { ledger } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt, datedPayments: false,
    });
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].payment).toBe(50);
    expect(ledger.closingBalance).toBe(200);
  });

  // KAN-274: an invoice raised before the period is its own charge row, so the
  // caller supplies an opening balance of 0 (see generateStatementOfAccount.js).
  it('ages an invoice raised before the period at its full amount', () => {
    const invoices = [invoice('INV-OLD', '2026-03-01', 250, '2026-03-15')];
    const items = [paidItem('INV-OLD', 100, undefined)];
    const { ledger, ageing } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt,
    });
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].charge).toBe(250);
    expect(ledger.rows[0].payment).toBe(0);
    expect(ledger.closingBalance).toBe(250);
    expect(ageing.d90plus).toBe(250);
  });
});

/**
 * A payment recorded against an invoice number that is not among the
 * participant's invoices (KAN-286). There is nothing to apply it to, so it is
 * left off, like a record with no `invoicedBy`. Left on, it gave the ledger a
 * payment row the ageing never counted, the two totals disagreed, and the
 * statement's own reconciliation check threw while the PDF was rendered.
 */
describe('buildStatementLedger — a payment against an unknown invoice', () => {
  const asAt = '2026-08-31T00:00:00.000+10:00';
  const bucketSum = (ageing) => Object.values(ageing).reduce((sum, v) => sum + v, 0);

  it('gets no payment row, and the ledger still agrees with the ageing', () => {
    const invoices = [invoice('INV-1', '2026-08-05', 250, '2026-08-19')];
    const items = [paidItem('INV-GHOST', 100, '2026-08-20')];
    const { ledger, ageing } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt,
    });
    expect(ledger.rows.map((r) => [r.description, r.payment])).toEqual([['Services invoiced', 0]]);
    expect(ledger.closingBalance).toBe(250);
    expect(bucketSum(ageing)).toBe(ledger.closingBalance);
    expect(() => assertAgeingReconciles(ageing, ledger.closingBalance)).not.toThrow();
  });

  it('still counts a real payment on a known invoice next to the unknown one', () => {
    const invoices = [invoice('INV-1', '2026-08-05', 250, '2026-08-19')];
    const items = [paidItem('INV-GHOST', 100, '2026-08-20'), paidItem('INV-1', 50, '2026-08-21')];
    const { ledger, ageing } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt,
    });
    expect(ledger.rows.map((r) => [r.description, r.payment])).toEqual([
      ['Services invoiced', 0],
      ['Payment received', 50],
    ]);
    expect(ledger.closingBalance).toBe(200);
    expect(bucketSum(ageing)).toBe(200);
  });

  // Review finding: a "known" invoice that is dated after the statement's
  // as-at has no charge row and is dropped from the ageing, so a payment against
  // it must be left off too, or the statement throws again.
  it('leaves off a payment against an invoice that is not raised yet as at the statement date', () => {
    const invoices = [invoice('INV-FUTURE', '2026-10-15', 250, '2026-10-29')];
    const items = [paidItem('INV-FUTURE', 100, '2026-08-20')];
    const { ledger, ageing, unmatchedPayments } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt,
    });
    expect(ledger.rows).toHaveLength(0);
    expect(ledger.closingBalance).toBe(0);
    expect(bucketSum(ageing)).toBe(ledger.closingBalance);
    expect(() => assertAgeingReconciles(ageing, ledger.closingBalance)).not.toThrow();
    expect(unmatchedPayments).toHaveLength(1);
  });

  // The real stored format carries a suffix on both sides.
  it('matches on the full stored invoice number, suffix included', () => {
    const invoices = [invoice('INV-24 (ISO+™)', '2026-08-05', 171.25, '2026-08-19')];
    const items = [paidItem('INV-24 (ISO+™)', 5, '2026-08-20'), paidItem('INV-24', 10, '2026-08-20')];
    const { ledger, unmatchedPayments } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt,
    });
    expect(ledger.rows.map((r) => r.payment)).toEqual([0, 5]);
    expect(unmatchedPayments.map((p) => [p.invoiceNumber, p.amount])).toEqual([['INV-24', 10]]);
  });

  it('reports each payment it left off, so the caller can say so', () => {
    const invoices = [invoice('INV-1', '2026-08-05', 250, '2026-08-19')];
    const items = [paidItem('INV-GHOST', 100, '2026-08-20'), paidItem('INV-1', 50, '2026-08-21')];
    const { unmatchedPayments } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt,
    });
    expect(unmatchedPayments).toEqual([
      { invoiceNumber: 'INV-GHOST', amount: 100, date: '2026-08-20' },
    ]);
  });

  it('is left off in the non-dated mode as well', () => {
    const invoices = [invoice('INV-1', '2026-08-05', 250, '2026-08-19')];
    const items = [paidItem('INV-GHOST', 100, '2026-08-20')];
    const { ledger } = buildStatementLedger({
      invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt, datedPayments: false,
    });
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].payment).toBe(0);
    expect(ledger.closingBalance).toBe(250);
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
