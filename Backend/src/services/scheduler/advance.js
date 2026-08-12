import { computeNextRun as cronNextRun } from './nextRun.js';
import { computeNextRun as pickerNextRun } from '../../utils/automationScheduleHelpers.js';

/**
 * The next firing instant for either schedule representation.
 *
 * Cron and picker schedules are both legitimate — cron cannot express "every
 * 2 weeks" or "every 3 months from a start date", which Epic 5 requires, and
 * the picker cannot express the irregular shapes cron handles. This is the
 * only place that knows both exist; callers pass a job and get a Date.
 *
 * Note the two computeNextRun functions take their arguments in different
 * orders. Absorbing that here is most of why this module exists.
 */
export function advanceSchedule(job, now) {
  const hasCron = Boolean(job?.cron);
  const hasPicker = Boolean(job?.schedule?.every?.unit);

  if (hasCron === hasPicker) {
    throw new Error('advanceSchedule: exactly one of cron or schedule is required');
  }

  return hasCron
    ? cronNextRun(job.cron, job.timezone, now)
    : pickerNextRun(job.schedule, now, job.timezone);
}
