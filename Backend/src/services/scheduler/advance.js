import { computeNextRun as cronNextRun } from './nextRun.js';
import {
  computeNextRun as pickerNextRun,
  startOfDayInstant,
} from '../../utils/automationScheduleHelpers.js';

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
 * The value a schedule's startDate must be *stored* as, so that reading it
 * back through normaliseStartDate above returns the calendar date the client
 * actually sent.
 *
 * This is the write-side half of that pair, and the two only stay correct
 * together — which is why they live in the same file. Without it, the first
 * nextRunAt was computed from the raw client string ('2026-09-01') while every
 * later advance re-read the Mongoose-cast Date (2026-09-01T00:00:00Z) and
 * reformatted it in the job's timezone: one calendar day earlier for any zone
 * west of Greenwich, which puts the whole series off phase from its second run
 * onward. Anchoring on local midnight makes the round trip lossless, so both
 * paths compute from the same calendar date.
 *
 * Idempotent EXCEPT where local midnight does not exist — a spring-forward
 * that jumps 00:00 to 01:00, e.g. '2026-09-06' in America/Santiago, which
 * reads back as the 5th. Narrow (one date a year, only in zones whose
 * transition is at midnight) and not a phase bug: both paths still anchor on
 * the same value, so the series stays evenly spaced, and re-normalising
 * converges after one step. Recorded as a follow-up rather than fixed here.
 */
export function canonicalStartDate(startDate, timezone) {
  return startOfDayInstant(normaliseStartDate(startDate, timezone), timezone);
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
/**
 * The schedule as a plain object.
 *
 * Spreading a Mongoose subdocument copies its internal properties, not its
 * fields, so `{...job.schedule}` on a hydrated document loses `every`,
 * `runOn` and `runAt` entirely and the picker arithmetic silently falls back
 * to its defaults — a monthly schedule advancing roughly daily.
 *
 * Every production caller reads with .lean() (tick.js claims lean, and
 * claimAtMostOnce passes lean: true), so this is not reachable today. It is
 * guarded because nothing in the signature says "lean only", and the failure
 * is silent: a wrong Date rather than a throw.
 */
function plainSchedule(schedule) {
  return typeof schedule?.toObject === 'function' ? schedule.toObject() : schedule;
}

export function advanceSchedule(job, now) {
  const hasCron = Boolean(job?.cron);
  const hasPicker = Boolean(job?.schedule?.every?.unit);

  if (hasCron === hasPicker) {
    throw new Error('advanceSchedule: exactly one of cron or schedule is required');
  }

  if (hasCron) {
    return cronNextRun(job.cron, job.timezone, now);
  }

  const stored = plainSchedule(job.schedule);
  const schedule = {
    ...stored,
    startDate: normaliseStartDate(stored.startDate, job.timezone),
  };
  return pickerNextRun(schedule, now, job.timezone);
}
