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
