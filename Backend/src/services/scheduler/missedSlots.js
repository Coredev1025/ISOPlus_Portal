import { countMissedSlots } from './nextRun.js';
import { advanceSchedule } from './advance.js';

/**
 * Upper bound on the walk, matching countMissedSlots' own cap.
 *
 * Without it, a daily schedule whose row was left behind by years of downtime
 * would iterate once per elapsed day inside a database update. The count is
 * a health signal, not an accounting record — "at least this many" is all it
 * ever needs to convey.
 */
export const MAX_MISSED_WALK = 1000;

/**
 * Slots that came and went between a schedule's due slot and now.
 *
 * Cron keeps its existing arithmetic: countMissedSlots walks a cron iterator
 * and is unchanged, so at-most-once behaviour is byte-for-byte what it was.
 *
 * Picker schedules had no equivalent, which is why they contributed zero. The
 * walk below is the equivalent, expressed in the schedule's own steps —
 * "every 3 months" counts quarters, not months — by asking advanceSchedule
 * for the next slot repeatedly. That is the same function the tick uses to
 * advance, so the count cannot drift from the cadence actually being run.
 */
function countPickerMissedSlots(job, now, max) {
  let missed = 0;
  let cursor = job.nextRunAt;

  while (missed < max) {
    const next = advanceSchedule(job, cursor);

    if (next >= now) break;
    // A schedule that will not move forward would spin here. advanceSchedule
    // is strictly increasing for every shape reachable through
    // upsertSchedule, so this is a guard against a malformed row rather than
    // an expected branch.
    if (next <= cursor) break;

    cursor = next;
    missed += 1;
  }

  return missed;
}

export function missedSlotsFor(job, now, max = MAX_MISSED_WALK) {
  if (!job?.nextRunAt || job.nextRunAt >= now) return 0;

  if (job.cron) {
    return countMissedSlots(job.cron, job.timezone, job.nextRunAt, now, max);
  }

  // Neither representation, or a picker shape with no unit: nothing to walk.
  // advanceSchedule would throw on both, and a health counter must not be
  // what takes a tick down.
  if (!job.schedule?.every?.unit) return 0;

  return countPickerMissedSlots(job, now, max);
}
