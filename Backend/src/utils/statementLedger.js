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
 *
 * KAN-274 departs from the spec's original period-only charge scoping: every
 * invoice and payment ever recorded for the participant is a line item, as at
 * the moment the statement was struck, not only the ones this statement's own
 * period spans. See "Changes since approval" in
 * `docs/superpowers/specs/2026-08-20-invoice-item-selection-and-statements-design.md`.
 */

import {
  STATEMENT_AMOUNT_RECEIVED,
  STATEMENT_PAYMENT_DATE,
} from '../constants/statementAttributes.js';
import { buildAgeingSummary } from './statementAgeing.js';
import { buildRunningBalance, roundMoney } from './statementTransactions.js';
import { readField } from './invoiceSelectionFields.js';
import { startOfDayInstant } from './automationScheduleHelpers.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';

/** A bare `YYYY-MM-DD` date, with no time or offset of its own. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `value` as a comparable instant, in `tz`.
 *
 * `Payment Received Date` (KAN-277) is entered through a date picker as a bare
 * `YYYY-MM-DD`, with no time component. Parsed directly, that is implicit UTC
 * midnight — mid-morning in `tz` — so a payment dated "today" reads as still
 * hours in the future for the first part of every business day, and gets
 * excluded by a same-moment `raisedBy`/`asAtCutoff` check that should include
 * it. Anchoring it on local midnight in `tz` instead (the same technique
 * `startOfDayInstant` already uses for schedule boundaries) means the payment
 * counts as raised from the moment its calendar day begins, matching how a
 * human reads "28/09/2026" on a payment: it happened sometime that day, and
 * that day has necessarily started by the time anyone is checking.
 *
 * A full ISO instant (invoice `createdAt`, which already carries its own
 * offset per `invoiceSelectionFields.js`) does not match and is parsed as-is.
 */
function toComparableInstant(value, tz) {
  return BARE_DATE.test(String(value ?? '').trim())
    ? startOfDayInstant(value, tz)
    : new Date(value);
}

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

/** Whether a payment carries a date the ledger can place it by. */
const isDated = (payment) => !Number.isNaN(new Date(payment.date).getTime());

/**
 * Whether `value` is a usable date at or before `asAt`.
 *
 * KAN-274: charge and payment rows used to be scoped to the statement's own
 * period (`withinPeriod`, since removed). Every invoice ever raised is now a
 * line item regardless of which period it belongs to, so the only boundary
 * left is the one `asAtCutoff` already applies to ageing — a document raised
 * after the statement was struck is not on it, because it did not exist yet.
 * An unusable date is excluded rather than kept, unlike `asAtCutoff`: a
 * payment with no date must not get a row of its own here, it is netted onto
 * its invoice instead (see `chargeRows`).
 *
 * `tz` only affects a bare `YYYY-MM-DD` date (KAN-277) — see
 * `toComparableInstant`. A full ISO instant, which is what every other date
 * this file compares already is, parses the same regardless.
 */
const raisedBy = (value, asAt, tz) => {
  const at = toComparableInstant(value, tz).getTime();
  if (Number.isNaN(at)) return false;
  return at <= new Date(asAt).getTime();
};

const paidAgainst = (payments, invoiceNumber) => roundMoney(
  payments
    .filter((p) => p.invoiceNumber === invoiceNumber)
    .reduce((sum, p) => sum + p.amount, 0),
);

/**
 * Charge rows, one per invoice ever raised for the participant, as at `asAt`.
 *
 * KAN-274: every invoice is a line item here now, not only ones this
 * statement's own period spans — the CR this shipped under. A freshly
 * generated invoice's `createdAt` almost always falls just after whatever
 * period is current when it is generated (the invoicing job's own eligibility
 * window excludes its own run day), so scoping this to the period made a
 * brand new invoice invisible on the very next statement, visible only in the
 * running balance and ageing figures.
 *
 * When payments cannot be dated, the payment is netted onto the charge row
 * rather than given a row of its own — see `buildStatementLedger`. In dated
 * mode the same happens to the individual payment that has no date: it takes
 * its invoice's date, because that is the earliest it can have been made and
 * the one date the ageing already knows it by.
 */
function chargeRows(invoices, payments, asAt, datedPayments, tz) {
  const netted = datedPayments ? payments.filter((p) => !isDated(p)) : payments;
  return invoices
    .filter((inv) => raisedBy(inv.createdAt, asAt, tz))
    .map((inv, index) => ({
      date: inv.createdAt,
      reference: inv.invoiceNumber,
      description: inv.description || 'Services invoiced',
      // KAN-273: the statement's Due Date column, carried straight through
      // from the invoice — undefined rather than a placeholder when the
      // invoice has none, so the renderer leaves the cell blank.
      dueDate: inv.dueDate,
      charge: roundMoney(parseAmount(inv.invoiceTotal)),
      payment: paidAgainst(netted, inv.invoiceNumber),
      sequence: index * 2,
    }));
}

/**
 * Payment rows, one per recorded payment, as at `asAt`.
 *
 * KAN-274: no longer scoped to the period either, for the same reason as
 * `chargeRows` — every charge row it might offset can now come from any
 * period, so a payment scoped to only the current one would leave an older,
 * already-settled invoice looking outstanding again on this statement.
 */
function paymentRows(payments, asAt, tz) {
  return payments
    .filter((p) => raisedBy(p.date, asAt, tz))
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
 * A payment with no usable date is kept, on its invoice's date: `chargeRows`
 * nets it onto the same invoice, and `openingBalanceBefore` counts it from the
 * same date, so the ledger and the ageing agree on it. They did not always —
 * kept here and dropped there, a single undated payment made section 4.3's
 * check throw, which failed the whole board's run.
 */
function asAtCutoff(invoices, payments, asAt, tz) {
  const at = new Date(asAt).getTime();
  const notAfter = (value) => {
    const when = toComparableInstant(value, tz).getTime();
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
 * The settled ledger and ageing for one participant, as at `asAt`.
 *
 * `period` is no longer used to scope which invoices or payments become rows
 * — KAN-274 made every one of them a line item regardless of period, so the
 * caller's `openingBalance` should be 0 (see `generateStatementOfAccount.js`):
 * with the full history already on the ledger, there is nothing left for an
 * opening figure to carry forward without counting the same invoice twice.
 * `period` is kept only as the fallback source for `asAt` — callers that
 * genuinely want "as at the period's own end" (the pure-function tests below
 * that do not care about generation timing) can still get it from the
 * default — and for whatever the caller prints as the period covered.
 *
 * `datedPayments` is the switch for the open question about
 * `Payment Received Date`. With it true — the default — each payment gets its
 * own dated row and the running balance means what the sample shows. With it
 * false, payments are netted onto their invoice's row instead: the statement
 * still reconciles and the ageing is unchanged, but there are no payment lines
 * and the balance column tracks invoices rather than events.
 *
 * The two must not be mixed. Netting a payment onto its charge row *and*
 * giving it a row of its own would count it twice, so the flag is threaded
 * through both row builders from one place. The one exception is a payment
 * with no date: dated mode has no row to give it, so it is netted onto its
 * invoice instead, and `paymentRows` never sees it.
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
    ...chargeRows(invoices, payments, asAt, datedPayments, timezone),
    ...(datedPayments ? paymentRows(payments, asAt, timezone) : []),
  ];

  const ledger = buildRunningBalance(openingBalance, rows);
  const settled = asAtCutoff(invoices, payments, asAt, timezone);
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
