import { CronExpressionParser } from 'cron-parser';

/** The next instant `cron` fires at in `timezone`, strictly after `from`. */
export function computeNextRun(cron, timezone, from) {
  return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone })
    .next()
    .toDate();
}

/**
 * How many slots were skipped between `scheduledFor` and `now`, excluding
 * `scheduledFor` itself — that one is about to run. `max` bounds the walk so a
 * schedule left disabled for years cannot stall a tick.
 */
export function countMissedSlots(cron, timezone, scheduledFor, now, max = 1000) {
  if (scheduledFor >= now) return 0;

  const iterator = CronExpressionParser.parse(cron, {
    currentDate: scheduledFor,
    tz: timezone,
  });

  let missed = 0;
  while (missed < max) {
    if (iterator.next().toDate() >= now) break;
    missed += 1;
  }
  return missed;
}

/**
 * The smallest gap, in minutes, between consecutive fires of `cron`, sampled
 * over `slotCount` slots walked forward from `from` in `timezone`. Used to
 * enforce a minimum-interval floor — the *smallest* gap matters, not the
 * average, because a cron can mix cadences (e.g. `0 9-17 * * *` fires hourly
 * during the day and has a ~16-hour gap overnight; the hourly gap is the one
 * that must be checked against the floor).
 *
 * Each slot is computed from the previous one via computeNextRun, whose
 * contract guarantees strictly-after — so consecutive slots can never
 * collide or go backwards, including across a daylight-saving transition
 * where a local day is 23 or 25 hours. That guarantee is what keeps this
 * function from returning a spurious zero or negative gap; it does not need
 * its own DST handling on top of it.
 */
export function minIntervalMinutes(cron, timezone, from, slotCount = 10) {
  let previous = computeNextRun(cron, timezone, from);
  let minMs = Infinity;

  for (let i = 1; i < slotCount; i += 1) {
    const slot = computeNextRun(cron, timezone, previous);
    minMs = Math.min(minMs, slot.getTime() - previous.getTime());
    previous = slot;
  }
  return minMs / 60000;
}

/** Whether this pair can be scheduled at all. Used before writing a record. */
export function isValidSchedule(cron, timezone) {
  if (typeof timezone !== 'string' || timezone.length === 0) return false;

  try {
    // cron-parser accepts an unknown timezone here and only fails later inside
    // next(), with an opaque "CronDate: unhandled timestamp". Intl rejects it
    // now, with a RangeError.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    CronExpressionParser.parse(cron, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}
