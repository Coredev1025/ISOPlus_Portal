/**
 * How overdue the balance is, bucketed.
 *
 * Section 4.3 of the invoice selection spec. Two things it insists on, both of
 * which are easy to get wrong and visible to the participant when you do:
 *
 *   - Ageing runs from each invoice's DUE date, not its issue date. Manual
 *     invoicing sets the due date to issue plus 14 days, so an invoice issued
 *     40 days ago is 26 days overdue, not 40. Ageing from the issue date
 *     overstates every bucket by the payment terms.
 *   - The buckets must sum to the closing balance, checked before rendering,
 *     with the statement failed rather than sent if they do not.
 */

import { roundMoney } from './statementTransactions.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';

/**
 * Ordered youngest to oldest, which is also the column order on the statement.
 * `maxDaysOverdue` is inclusive; null is the open-ended final bucket.
 */
export const AGEING_BUCKETS = Object.freeze([
  { key: 'current', label: 'Current', maxDaysOverdue: 0 },
  { key: 'd1to30', label: '1-30 days', maxDaysOverdue: 30 },
  { key: 'd31to60', label: '31-60 days', maxDaysOverdue: 60 },
  { key: 'd61to90', label: '61-90 days', maxDaysOverdue: 90 },
  { key: 'd90plus', label: '90+ days', maxDaysOverdue: null },
]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The calendar day `value` falls on in `timezone`, as a UTC-midnight instant.
 *
 * Both dates are reduced to their wall-clock day in the business timezone
 * before subtracting, for two reasons. A due date at 09:00 and a statement run
 * at 23:00 on the same day must be nought days overdue rather than a fraction
 * of one. And reducing to the UTC day instead would shift every Australian
 * date back one, because Sydney is ahead of Greenwich — an invoice would age
 * into the next bucket a day early.
 *
 * 'en-CA' renders YYYY-MM-DD directly, the same trick wallYmdKey uses in
 * utils/automationScheduleWindow.js.
 */
function wallDayInstant(value, timezone) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
    .format(parsed).split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Whole days between the due date and the statement date.
 */
function daysOverdue(dueDate, asAt, timezone) {
  const due = wallDayInstant(dueDate, timezone);
  const at = wallDayInstant(asAt, timezone);
  if (due === null || at === null) return 0;
  return Math.floor((at - due) / MS_PER_DAY);
}

/**
 * Which bucket an invoice due on `dueDate` falls in, as at `asAt`.
 *
 * Not yet due, or due today, is Current: an invoice is not overdue on the day
 * it falls due.
 */
export function ageingBucketFor(dueDate, asAt, timezone = DEFAULT_TIMEZONE) {
  const overdue = daysOverdue(dueDate, asAt, timezone);
  if (overdue <= 0) return 'current';
  const bucket = AGEING_BUCKETS.find(
    (b) => b.maxDaysOverdue !== null && overdue <= b.maxDaysOverdue,
  );
  return bucket ? bucket.key : 'd90plus';
}

/**
 * Every bucket, summed from the outstanding amounts.
 *
 * `outstanding` is one entry per invoice that still has money against it:
 * `{ dueDate, amount }`. Amounts may be negative — a credit note ages into the
 * bucket its own due date puts it in, so it reduces the same period it
 * corrects rather than the newest one.
 */
export function buildAgeingSummary(outstanding, asAt, timezone = DEFAULT_TIMEZONE) {
  const summary = Object.fromEntries(AGEING_BUCKETS.map((b) => [b.key, 0]));
  for (const entry of outstanding || []) {
    const amount = Number(entry?.amount || 0);
    if (amount === 0) continue;
    summary[ageingBucketFor(entry.dueDate, asAt, timezone)] += amount;
  }
  for (const key of Object.keys(summary)) summary[key] = roundMoney(summary[key]);
  return summary;
}

/**
 * The check section 4.3 asks for, before anything is rendered.
 *
 * Compared in whole cents, not as floats. `1232.51 - 1232.50` is
 * 0.009999999999990905 in floating point, so a `>= 0.01` test on the
 * difference silently passes a statement that is a cent out — which is exactly
 * the disagreement this exists to catch.
 */
export function assertAgeingReconciles(summary, closingBalance) {
  const total = roundMoney(
    Object.values(summary).reduce((sum, value) => sum + Number(value || 0), 0),
  );
  const stated = roundMoney(closingBalance);
  if (Math.abs(Math.round(total * 100) - Math.round(stated * 100)) >= 1) {
    throw new Error(
      `statement: ageing does not reconcile — buckets total ${total}, `
      + `closing balance stated as ${stated}`,
    );
  }
}
