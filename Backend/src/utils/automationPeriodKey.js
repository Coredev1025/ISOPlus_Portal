/**
 * A stable identifier for one scheduled slot, used as the dedupe half of a
 * BullMQ jobId.
 *
 * `slot` MUST be the nextRunAt value that was claimed, never Date.now(). A
 * retry after a crash claims the same slot and therefore produces the same
 * key, so BullMQ drops the boards already enqueued and admits only the
 * missing ones. Deriving this from the current time would produce a fresh
 * key on every retry and duplicate-bill every board that already succeeded.
 *
 * Formatted in the schedule's own timezone so two workspaces on different
 * zones cannot collide on the same instant.
 */
export function automationPeriodKey({ slot, timezone }) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .formatToParts(slot)
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});

  // Intl renders hour 24 for midnight in some engines; normalise it.
  const hour = parts.hour === '24' ? '00' : parts.hour;

  return `${parts.year}${parts.month}${parts.day}-${hour}${parts.minute}`;
}
