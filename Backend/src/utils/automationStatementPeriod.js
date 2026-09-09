import {
  previousCalendarMonth,
  previousMonthServiceDeliveryWindow,
} from './automationPreviousMonth.js';
import { schedulePeriodServiceDeliveryWindow } from './automationScheduleWindow.js';

/**
 * What one statement run covers.
 *
 * Section 4.1 of the invoice selection spec: the statement period is
 * "configured separately from invoicing, and can be weekly or monthly". The
 * cadence stored on the schedule already decides *when* the job fires; until
 * this module existed it did not decide *what* the statement covered. The
 * statement path called previousCalendarMonth unconditionally, so a workspace
 * on a weekly cadence received the whole of the previous calendar month again
 * every week, each copy carrying a fresh statement number — which is what a
 * client reported as a wrong statement.
 */

/**
 * Is the period this schedule bills exactly one calendar month?
 *
 * Only `every: { n: 1, unit: 'month' }` is, and so is a schedule that never
 * reached us — the historical caller passed none, and its behaviour has to
 * survive unchanged. Everything else (a week, a fortnight, three days, a
 * quarter, two months) is a span this module must not pretend is a month.
 *
 * Note this is NOT the same as "step one month back from the slot", which is
 * what schedulePeriodServiceDeliveryWindow does: a monthly schedule firing on
 * the 14th steps back to 13 July – 13 August, where a monthly statement has
 * always covered 1–31 July. The calendar month is the customer-facing
 * contract for that cadence, so it is kept.
 */
function coversOneCalendarMonth(schedule) {
  const every = schedule?.every;
  if (!every) return true;
  const n = Math.max(1, Number(every.n ?? 1));
  return n === 1 && String(every.unit ?? 'month').toLowerCase() === 'month';
}

/**
 * The bounds and, where there is one, the month label for the period ending at
 * `slot`.
 *
 * `budgetPeriod` is null for any period that is not a whole calendar month.
 * The NDIS budget statement is a calendar-month document by construction, not
 * by convention: `src/assets/monthlyStatement.json` carries fixed, read-only
 * text saying "the services you received in the previous calendar month", its
 * budget rows are fetched by month and year rather than by date range, and its
 * quarter banner is derived from a month number. There is no honest month
 * label for a week, so this reports that there is none rather than naming the
 * month the week happens to fall in and shipping a document whose own body
 * contradicts its dates. The statement of account, which works in instants,
 * follows the cadence in every case.
 *
 * Touchpoints: services/automation/generateStatements.js.
 */
export function statementPeriodForSchedule(slot, timezone, schedule) {
  if (coversOneCalendarMonth(schedule)) {
    return {
      window: previousMonthServiceDeliveryWindow(slot, timezone),
      budgetPeriod: previousCalendarMonth(slot, timezone),
    };
  }
  return {
    window: schedulePeriodServiceDeliveryWindow(slot, timezone, schedule),
    budgetPeriod: null,
  };
}
