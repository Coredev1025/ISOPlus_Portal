// Scheduling arithmetic for Invoice & Statement Automation (Epic 5).
//
// Pure and clock-free: `from` is always supplied by the caller, never read from
// the system clock, so this is testable without freezing time. The scheduler
// tick selects work with `nextRun <= now()`, and the client sees `Next Run` as a
// read-only field, so a wrong answer here either bills a participant twice or
// never bills them.
//
// Everything is computed in **wall-clock** terms in the business's timezone.
// "Run At 09:00" means 09:00 to the person who typed it, on both sides of a
// daylight-saving transition — which naive UTC arithmetic gets wrong by an hour
// twice a year. No new dependency: `moment` in this repo has no timezone data,
// and the codebase already does timezone work with Intl.

import { MONTHS_PER_UNIT, WEEKDAYS } from '../constants/automation.js';

const MS_PER_DAY = 86_400_000;

/** The offset, in ms, between UTC and `tz` at the instant `date`. */
function offsetMs(date, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

    // Intl renders hour 24 for midnight in some locales/engines; normalise it.
    const hour = parts.hour === '24' ? 0 : Number(parts.hour);
    const asIfUtc = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        hour, Number(parts.minute), Number(parts.second),
    );
    return asIfUtc - date.getTime();
}

/**
 * The instant at which the wall clock in `tz` reads the given date and time.
 *
 * Two passes: the first guess uses the offset at the equivalent UTC instant,
 * which is wrong near a transition; re-reading the offset at that corrected
 * instant fixes it. When the wall time does not exist (the hour skipped by a
 * spring-forward), this lands on a real instant just after the gap rather than
 * returning an Invalid Date — the schedule still fires, which is what matters.
 */
function wallTimeToInstant({ year, month, day, hour, minute }, tz) {
    const naive = Date.UTC(year, month - 1, day, hour, minute);
    const firstPass = naive - offsetMs(new Date(naive), tz);
    const secondPass = naive - offsetMs(new Date(firstPass), tz);
    return new Date(secondPass);
}

/** Wall-clock calendar fields of `date` in `tz`. */
function wallFieldsOf(date, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'long',
    }).formatToParts(date).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: parts.hour === '24' ? 0 : Number(parts.hour),
        minute: Number(parts.minute),
        weekday: String(parts.weekday).toLowerCase(),
    };
}

function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "09:00" -> { hour: 9, minute: 0 }. Invalid input falls back to midnight. */
export function parseRunAt(runAt) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(runAt ?? '').trim());
    if (!match) return { hour: 0, minute: 0 };
    const hour = Math.min(23, Math.max(0, Number(match[1])));
    const minute = Math.min(59, Math.max(0, Number(match[2])));
    return { hour, minute };
}

/** Calendar date `offset` days after `fields`, ignoring time. */
function addDays({ year, month, day }, offset) {
    const shifted = new Date(Date.UTC(year, month - 1, day + offset));
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
    };
}

/**
 * Calendar date `offset` months after `fields`, with the day-of-month clamped
 * to the target month's length.
 *
 * The clamp is the point: "the 31st" in a 30-day month must be the 30th, not
 * the 1st of the next month. Rolling over shifts every subsequent run and can
 * fire twice in one calendar month.
 */
function addMonthsClamped({ year, month }, offset, desiredDay) {
    const zeroBased = (month - 1) + offset;
    const targetYear = year + Math.floor(zeroBased / 12);
    const targetMonth = ((zeroBased % 12) + 12) % 12 + 1;
    return {
        year: targetYear,
        month: targetMonth,
        day: Math.min(desiredDay, daysInMonth(targetYear, targetMonth)),
    };
}

/**
 * A day-of-month, clamped to 1-31, falling back when the input is not a number.
 *
 * The empty string is treated as absent rather than coerced: `'' ?? fallback`
 * is `''`, and `Number('')` is 0, so an empty runOn clamped to the 1st instead
 * of falling back to the startDate's own day.
 */
function clampDay(value, fallback) {
    const absent = value === '' || value === null || value === undefined;
    const day = Number(absent ? fallback : value);
    return Number.isFinite(day) ? Math.min(31, Math.max(1, Math.trunc(day))) : fallback;
}

/**
 * How many months forward of the start month the series is anchored, so that
 * it lands in the month the client picked.
 *
 * `cycleMonths` is the FULL step — `n * MONTHS_PER_UNIT[unit]`, i.e. 6 for
 * "every 2 quarters", not 3. It must match the step `nextByMonths` takes, or
 * the series is aligned on one modulus and sampled on another, and the chosen
 * month only appears by parity luck: aligning mod 3 while stepping 6 months
 * turned "every 2 quarters in June" into September and March forever, with
 * June never occurring at all.
 *
 * The deliberate cost, for `year` with n >= 2: the first run can be pushed out
 * by a whole cycle. A March schedule starting Aug 2026 lands on Mar 2028
 * rather than Mar 2027, because Mar 2027 is not phase-aligned to a two-year
 * step from the anchor. That trade is accepted on purpose — the client picked
 * March and still gets March, just one cycle later. Silently billing them in a
 * month they did not choose, every cycle, forever, is the worse failure. Do
 * not "simplify" this back to MONTHS_PER_UNIT.
 */
function monthShift(runOnMonth, startMonth, cycleMonths) {
    const month = Number(runOnMonth);
    if (!Number.isFinite(month)) return 0;
    const wanted = Math.min(12, Math.max(1, Math.trunc(month)));
    return (((wanted - startMonth) % cycleMonths) + cycleMonths) % cycleMonths;
}

/**
 * The anchor and target day-of-month for a month/quarter/year series.
 *
 * `runOn` carries two shapes, matching exactly what the API accepts
 * (utils/automationSettingsHelpers.js `validateRunOn`) and what the picker
 * sends (Frontend/lib/automation-run-on-options.ts): an integer day-of-month
 * for `month`, and `{month, day}` for `quarter` and `year`. Reading the object
 * shape as a number is what produced `day: NaN` and an Invalid Date, and
 * ignoring its `month` made "yearly on 15 March" inexpressible.
 *
 * The anchor's own day is irrelevant — nextByMonths re-clamps with
 * `desiredDay` — so only its year and month are used. `stepMonths` is the same
 * step nextByMonths will take; see monthShift for why the two must agree.
 */
function monthlySeries(runOn, start, stepMonths) {
    const isMonthDay = runOn !== null && typeof runOn === 'object';
    const desiredDay = clampDay(isMonthDay ? runOn.day : runOn, start.day);
    const shift = isMonthDay ? monthShift(runOn.month, start.month, stepMonths) : 0;
    return { anchor: addMonthsClamped(start, shift, desiredDay), desiredDay };
}

function parseStartDate(startDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(startDate ?? ''));
    if (!match) return null;
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * The instant at which the calendar day `YYYY-MM-DD` begins in `tz`.
 *
 * A startDate is a calendar date, but `ScheduledJob.schedule.startDate` is a
 * Mongoose `Date`, so something has to choose which instant represents that
 * day. Anchoring on local midnight is the choice that survives the round trip:
 * reading the stored instant back in the same timezone yields the same
 * calendar date, which is what the arithmetic here needs. Casting the bare
 * string instead anchors on UTC midnight, which reads back as the *previous*
 * day anywhere west of Greenwich.
 *
 * Anything that is not a parseable calendar date is returned untouched, so a
 * client's `"not-a-date"` still reaches the schema and is still rejected as a
 * CastError rather than being silently turned into null.
 */
export function startOfDayInstant(startDate, tz) {
    const fields = parseStartDate(startDate);
    if (!fields) return startDate;
    return wallTimeToInstant({ ...fields, hour: 0, minute: 0 }, tz);
}

/** Step a day/week schedule forward until it passes `from`. */
function nextByDays(anchor, stepDays, time, from, tz) {
    let candidate = wallTimeToInstant({ ...anchor, ...time }, tz);
    if (candidate > from) return candidate;

    // Jump most of the way in one calculation, then step — the loop only covers
    // the remainder and any DST drift, so it runs a couple of times at most.
    const approxSteps = Math.floor((from.getTime() - candidate.getTime()) / (MS_PER_DAY * stepDays));
    let cursor = addDays(anchor, approxSteps * stepDays);
    candidate = wallTimeToInstant({ ...cursor, ...time }, tz);

    while (candidate <= from) {
        cursor = addDays(cursor, stepDays);
        candidate = wallTimeToInstant({ ...cursor, ...time }, tz);
    }
    return candidate;
}

/**
 * How many iterations `nextByMonths` may take after its opening jump. The jump
 * lands within one step of the answer, so this is slack, not a working budget —
 * it exists so a pathological input cannot spin, not to bound normal use.
 */
const MAX_MONTH_STEPS = 16;

/** Step a month/quarter/year schedule forward until it passes `from`. */
function nextByMonths(anchor, stepMonths, desiredDay, time, from, tz) {
    const at = (offset) => wallTimeToInstant(
        { ...addMonthsClamped(anchor, offset, desiredDay), ...time }, tz,
    );

    let candidate = at(0);
    if (candidate > from) return candidate;

    // Jump most of the way in one calculation, the way nextByDays does. The
    // previous version bounded the loop by the month *offset* (`offset < 400`)
    // rather than by iterations, so a startDate more than ~33 years back
    // exhausted the cap while the candidate was still behind `from` — and the
    // stale candidate was returned anyway. That stored a nextRunAt in the past
    // which was also a fixed point, so the tick claimed it, advanced it to
    // itself, and re-fired it every minute forever.
    const fromFields = wallFieldsOf(from, tz);
    const monthsApart = (fromFields.year - anchor.year) * 12 + (fromFields.month - anchor.month);
    let offset = Math.max(0, Math.floor(monthsApart / stepMonths) * stepMonths);
    candidate = at(offset);

    for (let step = 0; candidate <= from && step < MAX_MONTH_STEPS; step += 1) {
        offset += stepMonths;
        candidate = at(offset);
    }
    return candidate;
}

function weekdayAnchor(startFields, runOn, tz, time) {
    const target = WEEKDAYS.indexOf(String(runOn ?? '').toLowerCase());
    if (target < 0) return startFields;

    const startInstant = wallTimeToInstant({ ...startFields, ...time }, tz);
    const current = WEEKDAYS.indexOf(wallFieldsOf(startInstant, tz).weekday);
    return addDays(startFields, (target - current + 7) % 7);
}

/**
 * The contract below, asserted rather than assumed.
 *
 * A candidate at or before `from` is the one failure nothing downstream can
 * catch: `upsertSchedule` stores it, every tick claims it, `advanceSchedule`
 * answers the same instant so the claim's compare-and-swap succeeds, and
 * `missedSlotsFor` returns 0 because its own `next <= cursor` guard fires — so
 * the schedule re-fires forever with `missedRuns` still at zero.
 *
 * Throwing is strictly better than that. The `Scheduler: ` prefix is what
 * `isScheduleClientError` (utils/automationSettingsHelpers.js) keys on, so a
 * save carrying such settings is answered 400 rather than 500, and a row that
 * somehow reaches the tick is quarantined by `claimAtMostOnce` instead of
 * being retried every minute.
 */
function assertStrictlyAfter(candidate, from) {
    if (candidate > from) return candidate;
    throw new Error(
        `Scheduler: computed next run ${String(candidate)} is not after ${String(from)}`,
    );
}

function nextRunFor(settings, from, timezone) {
    const n = Math.max(1, Number(settings?.every?.n ?? 1));
    const unit = String(settings?.every?.unit ?? 'day').toLowerCase();
    const time = parseRunAt(settings?.runAt);

    const start = parseStartDate(settings?.startDate) ?? wallFieldsOf(from, timezone);

    if (unit === 'week') {
        return nextByDays(weekdayAnchor(start, settings?.runOn, timezone, time), n * 7, time, from, timezone);
    }

    const monthsPerUnit = MONTHS_PER_UNIT[unit];
    if (monthsPerUnit) {
        const stepMonths = n * monthsPerUnit;
        const { anchor, desiredDay } = monthlySeries(settings?.runOn, start, stepMonths);
        return nextByMonths(anchor, stepMonths, desiredDay, time, from, timezone);
    }

    // 'day', and any unknown unit: treated as daily rather than throwing. A
    // scheduler that stops dead on one bad settings document stops for every
    // client.
    return nextByDays(start, n, time, from, timezone);
}

/**
 * When this automation should next run.
 *
 * @param {object} settings              `{ every: {n, unit}, runOn, runAt, startDate }`
 * @param {Date}   from                  compute the next run strictly after this instant
 * @param {string} timezone              IANA zone, e.g. 'Australia/Sydney'
 * @returns {Date} always strictly after `from`, and never before `startDate`
 */
export function computeNextRun(settings, from, timezone = 'Australia/Sydney') {
    return assertStrictlyAfter(nextRunFor(settings, from, timezone), from);
}
