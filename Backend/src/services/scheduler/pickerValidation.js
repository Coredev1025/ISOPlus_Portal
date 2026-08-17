import {
  AUTOMATION_UNITS,
  MAX_EVERY_N,
  RUN_AT_PATTERN,
} from '../../constants/automation.js';

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
 *
 * `runOn` is deliberately NOT checked here, and that is a decision rather than
 * an omission. Its rules change with the unit — a weekday name for `week`, a
 * day number for `month`, `{month, day}` for `quarter`/`year` — and
 * `utils/automationSettingsHelpers.js` (`validateRunOn`) already encodes all
 * of them for the one write path that exists. Re-encoding them here would put
 * a second copy of unit-dependent rules in the module whose whole purpose is
 * to stop two validators disagreeing.
 *
 * The cost is real and worth naming: an unreadable `runOn` does not fail the
 * save, it falls back to the startDate's own weekday or day-of-month — a
 * cadence nobody chose. The fix is to extract `validateRunOn` into a helper
 * both validators call, which is an edit to `automationSettingsHelpers.js`
 * and is recorded as a follow-up rather than duplicated here.
 */

function everyError(every) {
  if (!every || typeof every !== 'object') return 'schedule.every is required';
  if (!AUTOMATION_UNITS.includes(every.unit)) {
    return `schedule.every.unit must be one of ${AUTOMATION_UNITS.join(', ')}`;
  }
  if (!Number.isInteger(every.n) || every.n < 1) {
    return 'schedule.every.n must be a positive integer';
  }
  // The same ceiling validateBlock applies at the route. Two write-path
  // validators disagreeing on the bounds of one field is precisely what this
  // module exists to prevent, so it cannot be the thing that introduces one.
  if (every.n > MAX_EVERY_N) {
    return `schedule.every.n must be ${MAX_EVERY_N} or less`;
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

  if (!RUN_AT_PATTERN.test(String(schedule.runAt ?? ''))) {
    return 'schedule.runAt must be HH:MM in 24-hour form';
  }

  return startDateError(schedule.startDate);
}
