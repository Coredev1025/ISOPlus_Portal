import { computeNextRun as cronNextRun } from './nextRun.js';
import {
  computeNextRun as pickerNextRun,
  startOfDayInstant,
} from '../../utils/automationScheduleHelpers.js';

/**
 * automationScheduleHelpers.parseStartDate only matches a YYYY-MM-DD string,
 * but both `ScheduledJob.schedule.startDate` and `AutomationSettings.<block>
 * .startDate` are Mongoose `Date` — so a document read from the DB failed that
 * regex silently and computeNextRun anchored on `now`, permanently dropping the
 * intended start date from the series.
 *
 * Deliberately NOT `toISOString()`: the arithmetic is wall-clock in the job's
 * own timezone, and UTC formatting rolls the calendar day backwards for any
 * zone west of Greenwich. 'en-CA' gives YYYY-MM-DD directly.
 *
 * Exported for `repointWorkspaceSchedules` (schedules.js), which has to read a
 * stored startDate back as the calendar date it was *written* in before
 * re-anchoring it in a new zone. A string passes through untouched, which is
 * what makes it safe to feed the result straight back to canonicalStartDate.
 */
export function normaliseStartDate(startDate, timezone) {
  if (!(startDate instanceof Date)) return startDate;
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(startDate);
}

/**
 * The value a schedule's startDate must be *stored* as, so that reading it back
 * through normaliseStartDate above returns the calendar date the client sent.
 * Without it the first nextRunAt came from the raw client string while every
 * later advance re-read the Mongoose-cast Date — one calendar day earlier west
 * of Greenwich, putting the series off phase from its second run onward.
 *
 * Not idempotent where local midnight does not exist (a spring-forward at
 * midnight, e.g. '2026-09-06' in America/Santiago). Not a phase bug — both
 * paths still anchor on the same value — and recorded as a follow-up.
 */
export function canonicalStartDate(startDate, timezone) {
  return startOfDayInstant(normaliseStartDate(startDate, timezone), timezone);
}

/**
 * The schedule as a plain object.
 *
 * Spreading a Mongoose subdocument copies its internal properties, not its
 * fields, so `{...job.schedule}` on a hydrated document loses `every`, `runOn`
 * and `runAt` entirely and the picker arithmetic silently falls back to its
 * defaults — a monthly schedule advancing roughly daily.
 */
function plainSchedule(schedule) {
  return typeof schedule?.toObject === 'function' ? schedule.toObject() : schedule;
}

/** The next firing instant for either schedule representation. */
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
