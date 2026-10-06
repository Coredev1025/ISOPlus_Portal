import {
  AUTOMATION_UNITS,
  MAX_EVERY_N,
  RUN_AT_PATTERN,
} from '../../constants/automation.js';

/**
 * Validates the picker half of a schedule, the way isValidSchedule validates
 * the cron half.
 *
 * The ScheduledJob schema does not protect the real write path: its enum,
 * `min` and `required` rules live on document middleware, and every production
 * write goes through findOneAndUpdate/updateOne with no runValidators. Observed
 * persisting against the live write path: `unit: 'fortnight'`, `n: 0`, `n: -3`
 * and `runAt: '99:99'`, each then billing on a cadence nobody chose.
 *
 * Returns a message naming the offending field, or null. A string rather than a
 * throw so the caller decides the error type.
 *
 * `runOn` is deliberately NOT checked here: its rules change with the unit, and
 * `utils/automationSettingsHelpers.js` (`validateRunOn`) already encodes all of
 * them for the one write path that exists. Extracting a helper both validators
 * call is a recorded follow-up.
 */

function everyError(every) {
  if (!every || typeof every !== 'object') return 'schedule.every is required';
  if (!AUTOMATION_UNITS.includes(every.unit)) {
    return `schedule.every.unit must be one of ${AUTOMATION_UNITS.join(', ')}`;
  }
  if (!Number.isInteger(every.n) || every.n < 1) {
    return 'schedule.every.n must be a positive integer';
  }
  // The same ceiling validateBlock applies at the route.
  if (every.n > MAX_EVERY_N) {
    return `schedule.every.n must be ${MAX_EVERY_N} or less`;
  }
  return null;
}

/**
 * Absent is fine — upsertSchedule anchors on the current date. An unparseable
 * one is not: canonicalStartDate would carry Invalid Date into the arithmetic.
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
