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
  // `hourCycle: 'h23'` rather than `hour12: false`: it pins midnight to "00"
  // by request instead of leaving it to whatever cycle the locale resolves to,
  // which is what made the old hand-rolled '24' → '00' normalisation necessary.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(slot)
      .map((part) => [part.type, part.value]),
  );

  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
}
