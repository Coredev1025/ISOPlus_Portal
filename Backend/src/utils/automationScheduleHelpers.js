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

const MS_PER_DAY = 86_400_000;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const MONTHS_PER_UNIT = { month: 1, quarter: 3, year: 12 };

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

function parseStartDate(startDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(startDate ?? ''));
    if (!match) return null;
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
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

/** Step a month/quarter/year schedule forward until it passes `from`. */
function nextByMonths(anchor, stepMonths, desiredDay, time, from, tz) {
    let offset = 0;
    let candidate = wallTimeToInstant(
        { ...addMonthsClamped(anchor, 0, desiredDay), ...time }, tz,
    );

    // Bounded rather than while(true): 400 steps is over 30 years at the
    // coarsest interval, so exceeding it means the inputs are nonsense and
    // looping forever would be worse than returning the last candidate.
    while (candidate <= from && offset < 400) {
        offset += stepMonths;
        candidate = wallTimeToInstant(
            { ...addMonthsClamped(anchor, offset, desiredDay), ...time }, tz,
        );
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
 * When this automation should next run.
 *
 * @param {object} settings              `{ every: {n, unit}, runOn, runAt, startDate }`
 * @param {Date}   from                  compute the next run strictly after this instant
 * @param {string} timezone              IANA zone, e.g. 'Australia/Sydney'
 * @returns {Date} always strictly after `from`, and never before `startDate`
 */
export function computeNextRun(settings, from, timezone = 'Australia/Sydney') {
    const n = Math.max(1, Number(settings?.every?.n ?? 1));
    const unit = String(settings?.every?.unit ?? 'day').toLowerCase();
    const time = parseRunAt(settings?.runAt);

    const start = parseStartDate(settings?.startDate) ?? wallFieldsOf(from, timezone);

    if (unit === 'day') {
        return nextByDays(start, n, time, from, timezone);
    }

    if (unit === 'week') {
        return nextByDays(weekdayAnchor(start, settings?.runOn, timezone, time), n * 7, time, from, timezone);
    }

    const monthsPerUnit = MONTHS_PER_UNIT[unit];
    if (monthsPerUnit) {
        const desiredDay = Math.min(31, Math.max(1, Number(settings?.runOn ?? start.day)));
        return nextByMonths(start, n * monthsPerUnit, desiredDay, time, from, timezone);
    }

    // Unknown unit: treat as daily rather than throwing. A scheduler that stops
    // dead on one bad settings document stops for every client.
    return nextByDays(start, n, time, from, timezone);
}
