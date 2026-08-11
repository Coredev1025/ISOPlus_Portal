/**
 * Translation between the Epic 5 picker (Generate Invoices Every / Run On /
 * Run At / Start Date / Next Run) and the cron expression stored on a
 * `ScheduledJob`. The end user never types a cron expression — they pick a
 * frequency, and optionally a day, from a constrained set. This module is
 * the write-path translation for that picker, and its inverse for display.
 *
 * Pure — no I/O, no database, no Express. Not wired into any route: the
 * Epic 5 UI does not exist yet, so there is no consumer. Raw cron remains a
 * fully-supported, hand-editable escape hatch on the schedule record for
 * shapes the picker cannot express (e.g. "last business day of the month");
 * `describeCron` returns `null` rather than throwing for those, so a UI can
 * fall back to showing the raw expression read-only instead of crashing.
 */

const FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);

function assertRange(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `cadence: ${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(value)}`,
    );
  }
}

function assertAbsent(name, value, frequency) {
  if (value !== undefined) {
    throw new Error(`cadence: ${name} is not valid for a ${frequency} frequency`);
  }
}

function assertFrequency(frequency) {
  if (!FREQUENCIES.has(frequency)) {
    throw new Error(
      `cadence: frequency must be one of 'daily', 'weekly', 'monthly', got ${JSON.stringify(frequency)}`,
    );
  }
}

/**
 * Restricted to 1–28 deliberately: a monthly schedule on the 29th, 30th or
 * 31st silently skips whichever months are too short for it — every
 * February for 29/30, most of the year for 31 — and for invoice issuance
 * that means a client simply does not get billed that month. There is no
 * silent clamping or "closest valid day" behaviour here; a genuine
 * end-of-month cadence must be configured as a raw cron expression on the
 * schedule record instead, outside the picker.
 */
function assertDayOfMonth(dayOfMonth) {
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
    throw new Error(
      'cadence: dayOfMonth must be an integer between 1 and 28 — the 29th, 30th or 31st ' +
        'would silently skip some months (every February for 29/30, most months for 31), ' +
        'so a client scheduled there would simply not be billed that month. Use a raw ' +
        'cron expression on the schedule record for a genuine end-of-month cadence.',
    );
  }
}

function validateDailyFields({ dayOfWeek, dayOfMonth }) {
  assertAbsent('dayOfWeek', dayOfWeek, 'daily');
  assertAbsent('dayOfMonth', dayOfMonth, 'daily');
}

function validateWeeklyFields({ dayOfWeek, dayOfMonth }) {
  assertAbsent('dayOfMonth', dayOfMonth, 'weekly');
  assertRange('dayOfWeek', dayOfWeek, 0, 6);
}

function validateMonthlyFields({ dayOfWeek, dayOfMonth }) {
  assertAbsent('dayOfWeek', dayOfWeek, 'monthly');
  assertDayOfMonth(dayOfMonth);
}

const FIELD_VALIDATORS = {
  daily: validateDailyFields,
  weekly: validateWeeklyFields,
  monthly: validateMonthlyFields,
};

function validatePicker(picker) {
  const { frequency, hour, minute } = picker ?? {};
  assertFrequency(frequency);
  assertRange('hour', hour, 0, 23);
  assertRange('minute', minute, 0, 59);
  FIELD_VALIDATORS[frequency](picker ?? {});
}

function cronForDaily({ hour, minute }) {
  return `${minute} ${hour} * * *`;
}

function cronForWeekly({ hour, minute, dayOfWeek }) {
  return `${minute} ${hour} * * ${dayOfWeek}`;
}

function cronForMonthly({ hour, minute, dayOfMonth }) {
  return `${minute} ${hour} ${dayOfMonth} * *`;
}

const CRON_BUILDERS = {
  daily: cronForDaily,
  weekly: cronForWeekly,
  monthly: cronForMonthly,
};

/**
 * Translates a picker selection into the cron expression stored on the
 * schedule. Throws, naming the offending field and its allowed range, for
 * anything the picker should never have produced — including a `dayOfWeek`
 * on a monthly schedule or vice versa, which is a caller bug worth
 * surfacing rather than silently ignoring.
 */
export function buildCron(picker) {
  validatePicker(picker);
  return CRON_BUILDERS[picker.frequency](picker);
}

const PLAIN_INTEGER = /^\d+$/;

/** A bare integer field within [min, max], or null for anything else — a
 * wildcard, a list, a range, a step — none of which the picker can express. */
function parsePlainInt(field, min, max) {
  if (!PLAIN_INTEGER.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

function describeDaily(domField, dowField, hour, minute) {
  if (domField !== '*' || dowField !== '*') return null;
  return { frequency: 'daily', hour, minute };
}

function describeWeekly(domField, dowField, hour, minute) {
  if (domField !== '*') return null;
  const dayOfWeek = parsePlainInt(dowField, 0, 6);
  return dayOfWeek === null ? null : { frequency: 'weekly', hour, minute, dayOfWeek };
}

function describeMonthly(domField, dowField, hour, minute) {
  if (dowField !== '*') return null;
  const dayOfMonth = parsePlainInt(domField, 1, 28);
  return dayOfMonth === null ? null : { frequency: 'monthly', hour, minute, dayOfMonth };
}

/**
 * The inverse of buildCron, so every user-created schedule can be displayed
 * back in the picker. Returns `null` — never throws — for any expression
 * outside the picker's vocabulary: a step (an every-30-minutes expression), a list
 * (`0 2 * * 1,3,5`), a range (`0 9-17 * * *`), a month restriction, or a
 * `dayOfMonth` of 29–31. An ops-authored cron in one of those shapes is a
 * legitimate state — the schedule record permits it as an escape hatch —
 * and the UI is expected to fall back to showing it read-only rather than
 * crash trying to render it as a picker selection.
 */
export function describeCron(cron) {
  if (typeof cron !== 'string') return null;

  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minuteField, hourField, domField, monthField, dowField] = fields;
  if (monthField !== '*') return null;

  const minute = parsePlainInt(minuteField, 0, 59);
  const hour = parsePlainInt(hourField, 0, 23);
  if (minute === null || hour === null) return null;

  return (
    describeDaily(domField, dowField, hour, minute) ??
    describeWeekly(domField, dowField, hour, minute) ??
    describeMonthly(domField, dowField, hour, minute)
  );
}
