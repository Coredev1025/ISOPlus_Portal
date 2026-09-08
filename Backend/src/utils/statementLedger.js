/**
 * Turning invoices and payments into the settled statement the renderer takes.
 *
 * Section 4 of the invoice selection spec. Two rules shape this file:
 *
 *   4.2 — "Carry the figure the invoice bills through unchanged rather than
 *         recalculating from source items." So charges come from
 *         `invoiceTotal` on the document ledger, never from re-adding items.
 *         The Age Care total is the participant's contribution on most boards
 *         and the full service amount on Low Cat, so recomputing would mean
 *         replicating that branch in a second place and getting it wrong the
 *         day one of them changes.
 *   4.5 — An account with no activity and nothing owing gets no statement.
 *
 * Payments come from the ISO+ service records, where they are entered by hand.
 */

import {
  STATEMENT_AMOUNT_RECEIVED,
  STATEMENT_PAYMENT_DATE,
} from '../constants/statementAttributes.js';
import { buildAgeingSummary } from './statementAgeing.js';
import { buildRunningBalance, roundMoney } from './statementTransactions.js';
import { readField } from './invoiceSelectionFields.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';

/**
 * A dollar amount that may arrive as a number or as a formatted string.
 *
 * ISO+ attributes come through the sync as whatever was typed, so '$1,232.50'
 * and 1232.5 are both possible for the same field.
 */
function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value ?? '').replace(/[$,\s]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Every payment recorded against an invoice, one entry per service record.
 *
 * A record with no `invoicedBy` has never been billed, so money against it
 * cannot be applied to any invoice — it is skipped rather than guessed at.
 */
export function collectPayments(items) {
  const payments = [];
  for (const item of items || []) {
    const invoiceNumber = item?.invoicedBy;
    if (!invoiceNumber) continue;
    const amount = roundMoney(parseAmount(readField(item, STATEMENT_AMOUNT_RECEIVED)));
    if (amount === 0) continue;
    payments.push({
      invoiceNumber,
      amount,
      date: readField(item, STATEMENT_PAYMENT_DATE),
    });
  }
  return payments;
}

const withinPeriod = (value, period) => {
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return false;
  return at >= new Date(period.start).getTime() && at <= new Date(period.end).getTime();
};

const paidAgainst = (payments, invoiceNumber) => roundMoney(
  payments
    .filter((p) => p.invoiceNumber === invoiceNumber)
    .reduce((sum, p) => sum + p.amount, 0),
);

/**
 * Charge rows, one per invoice raised in the period.
 *
 * When payments cannot be dated, the payment is netted onto the charge row
 * rather than given a row of its own — see `buildStatementLedger`.
 */
function chargeRows(invoices, payments, period, datedPayments) {
  return invoices
    .filter((inv) => withinPeriod(inv.createdAt, period))
    .map((inv, index) => ({
      date: inv.createdAt,
      reference: inv.invoiceNumber,
      description: inv.description || 'Services invoiced',
      charge: roundMoney(parseAmount(inv.invoiceTotal)),
      payment: datedPayments ? 0 : paidAgainst(payments, inv.invoiceNumber),
      sequence: index * 2,
    }));
}

/**
 * Payment rows, one per recorded payment, in the period.
 */
function paymentRows(payments, period) {
  return payments
    .filter((p) => withinPeriod(p.date, period))
    .map((p, index) => ({
      date: p.date,
      reference: p.invoiceNumber,
      description: 'Payment received',
      charge: 0,
      payment: p.amount,
      sequence: index * 2 + 1,
    }));
}

/**
 * Everything that had happened by the time the statement was struck.
 *
 * A document raised after `asAt` is not on this statement — it did not exist
 * yet — and neither is a payment recorded after it. Without this boundary the
 * ageing counted invoices the closing balance never saw, and the statement's
 * own two figures disagreed: a local run produced buckets totalling $423.70
 * against a closing balance of $400.50, which section 4.3's check rightly
 * refused to render.
 *
 * A payment with no usable date is kept. It cannot be placed on either side of
 * the boundary, and dropping it would report money as still owing that the
 * client has already sent — the worse of the two errors to make on a document
 * that asks them to pay.
 */
function asAtCutoff(invoices, payments, asAt) {
  const at = new Date(asAt).getTime();
  if (Number.isNaN(at)) return { invoices, payments };
  const notAfter = (value) => {
    const when = new Date(value).getTime();
    return Number.isNaN(when) || when <= at;
  };
  return {
    invoices: invoices.filter((inv) => notAfter(inv.createdAt)),
    payments: payments.filter((p) => notAfter(p.date)),
  };
}

/**
 * What is still owing on each invoice, for the ageing summary.
 *
 * Ageing is computed from the outstanding amount, not the invoiced amount: a
 * settled invoice must not keep appearing in a bucket. Every invoice raised by
 * the statement date is considered, not only those raised in the period,
 * because an older unpaid invoice is exactly what the 90+ bucket is for.
 */
function outstandingByInvoice(invoices, payments) {
  return invoices
    .map((inv) => ({
      dueDate: inv.dueDate,
      amount: roundMoney(parseAmount(inv.invoiceTotal) - paidAgainst(payments, inv.invoiceNumber)),
    }))
    .filter((entry) => entry.amount !== 0);
}

/**
 * The settled ledger and ageing for one participant and period.
 *
 * `datedPayments` is the switch for the open question about
 * `Invoice Received Date`. With it true — the default — each payment gets its
 * own dated row and the running balance means what the sample shows. With it
 * false, payments are netted onto their invoice's row instead: the statement
 * still reconciles and the ageing is unchanged, but there are no payment lines
 * and the balance column tracks invoices rather than events.
 *
 * The two must not be mixed. Netting a payment onto its charge row *and*
 * giving it a row of its own would count it twice, so the flag is threaded
 * through both row builders from one place.
 */
export function buildStatementLedger({
  invoices = [],
  items = [],
  period,
  openingBalance = 0,
  asAt = period?.end,
  timezone = DEFAULT_TIMEZONE,
  datedPayments = true,
}) {
  const payments = collectPayments(items);
  const rows = [
    ...chargeRows(invoices, payments, period, datedPayments),
    ...(datedPayments ? paymentRows(payments, period) : []),
  ];

  const ledger = buildRunningBalance(openingBalance, rows);
  const settled = asAtCutoff(invoices, payments, asAt);
  const ageing = buildAgeingSummary(
    outstandingByInvoice(settled.invoices, settled.payments), asAt, timezone,
  );

  return { ledger, ageing, payments };
}

/**
 * Is there anything worth sending?
 *
 * Section 4.5: no activity in the period and nothing owing means no statement.
 * Activity alone is enough — an account that was invoiced and paid in full
 * still gets a statement showing that, which is the record the participant
 * wants. A nil balance with no movement is the only case that produces
 * nothing.
 */
export function hasStatementActivity(ledger) {
  return ledger.rows.length > 0 || roundMoney(ledger.closingBalance) !== 0;
}
