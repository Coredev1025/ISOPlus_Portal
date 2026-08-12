import { computeNextRun as cronNextRun } from './nextRun.js';
import { computeNextRun as pickerNextRun } from '../../utils/automationScheduleHelpers.js';

/**
 * automationScheduleHelpers.parseStartDate only matches a YYYY-MM-DD string
 * (`/^(\d{4})-(\d{2})-(\d{2})/`). Both `ScheduledJob.schedule.startDate` and
 * `AutomationSettings.<block>.startDate` are declared as Mongoose `Date`, so
 * a real document read from the DB — the shape this module actually
 * receives — fails that regex silently: `String(aDate)` renders as
 * "Sun Aug 02 2026 22:00:00 GMT+0800 (...)", parseStartDate returns null, and
 * computeNextRun falls back to anchoring on `now` instead of the intended
 * start date, permanently dropping it from the series.
 *
 * Deliberately NOT `toISOString().slice(0, 10)` or any other UTC/local-time
 * formatting: this schedule's arithmetic is defined in wall-clock terms in
 * the job's own timezone (see automationScheduleHelpers.js's module
 * comment), so the calendar date a stored instant represents must be read in
 * that same timezone. Formatting in UTC or the server's local zone rolls the
 * calendar day backwards for any zone west of Greenwich — 'en-CA' gives
 * YYYY-MM-DD directly, so no extra parsing is needed.
 */
function normaliseStartDate(startDate, timezone) {
  if (!(startDate instanceof Date)) return startDate;
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(startDate);
}

/**
 * The next firing instant for either schedule representation.
 *
 * Cron and picker schedules are both legitimate — cron cannot express "every
 * 2 weeks" or "every 3 months from a start date", which Epic 5 requires, and
 * the picker cannot express the irregular shapes cron handles. This is the
 * only place that knows both exist; callers pass a job and get a Date.
 *
 * Note the two computeNextRun functions take their arguments in different
 * orders. Absorbing that here is most of why this module exists — along with
 * the startDate type mismatch handled by normaliseStartDate above.
 */
export function advanceSchedule(job, now) {
  const hasCron = Boolean(job?.cron);
  const hasPicker = Boolean(job?.schedule?.every?.unit);

  if (hasCron === hasPicker) {
    throw new Error('advanceSchedule: exactly one of cron or schedule is required');
  }

  if (hasCron) {
    return cronNextRun(job.cron, job.timezone, now);
  }

  const schedule = {
    ...job.schedule,
    startDate: normaliseStartDate(job.schedule.startDate, job.timezone),
  };
  return pickerNextRun(schedule, now, job.timezone);
}
