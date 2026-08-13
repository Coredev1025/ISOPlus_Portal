import { AUTOMATION_UNITS } from '../../models/AutomationSettings.js';

/**
 * Validates the picker half of a schedule, the way isValidSchedule validates
 * the cron half.
 *
 * This exists because the ScheduledJob schema does not protect the real write
 * path. Its enum, `min`, and `required` rules live on document middleware,
 * and every production write goes through findOneAndUpdate/updateOne, which
 * runs query middleware and passes no runValidators. upsertSchedule already
 * knew this for cron — it calls isValidSchedule explicitly — but trusted its
 * caller entirely for picker schedules.
 *
 * What got through, observed against the live write path: `unit: 'fortnight'`,
 * `n: 0`, `n: -3`, and `runAt: '99:99'` were all persisted. None of them is a
 * liveness bug — advanceSchedule always moves forward, so a bad `n` behaves as
 * 1 and a bad `runAt` resolves to some other time — which is precisely what
 * makes them worth rejecting. A schedule that quietly bills on a cadence
 * nobody chose is harder to notice than one that refuses to save.
 *
 * Returns a message naming the offending field, or null when the schedule is
 * fine. A string rather than a throw so the caller decides the error type,
 * matching isValidSchedule's boolean-return shape.
 */

// 24-hour HH:MM. Anchored, so '09:00 ' and '0900' are both rejected.
const RUN_AT = /^([01]\d|2[0-3]):[0-5]\d$/;

function everyError(every) {
  if (!every || typeof every !== 'object') return 'schedule.every is required';
  if (!AUTOMATION_UNITS.includes(every.unit)) {
    return `schedule.every.unit must be one of ${AUTOMATION_UNITS.join(', ')}`;
  }
  if (!Number.isInteger(every.n) || every.n < 1) {
    return 'schedule.every.n must be a positive integer';
  }
  return null;
}

/**
 * Absent is fine — upsertSchedule anchors an absent startDate on the current
 * date. An unparseable one is not: canonicalStartDate would carry the
 * Invalid Date straight into the arithmetic.
 */
function startDateError(startDate) {
  if (startDate === null || startDate === undefined) return null;
  if (Number.isNaN(new Date(startDate).getTime())) {
    return 'schedule.startDate is not a valid date';
  }
  return null;
}

export function pickerScheduleError(schedule) {
  if (!schedule || typeof schedule !== 'object') return 'schedule must be an object';

  const failure = everyError(schedule.every);
  if (failure) return failure;

  if (!RUN_AT.test(String(schedule.runAt ?? ''))) {
    return 'schedule.runAt must be HH:MM in 24-hour form';
  }

  return startDateError(schedule.startDate);
}
