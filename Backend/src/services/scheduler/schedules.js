import ScheduledJob from '../../models/ScheduledJob.js';
import { info } from '../../utils/logger.js';
import { computeNextRun, isValidSchedule } from './nextRun.js';
import { resolveTimezone } from './timezone.js';
import { assertMinimumInterval } from './intervalFloor.js';

/**
 * The only sanctioned way to create or change a schedule. Features call this
 * from their toggle; nothing writes ScheduledJob directly.
 *
 * `now` is a parameter rather than a Date.now() call so the behaviour is
 * testable without freezing the clock.
 */
export async function upsertSchedule({
  kind,
  targetId,
  workspaceId = null,
  cron,
  timezone,
  now = new Date(),
}) {
  const effectiveTimezone = await resolveTimezone({ workspaceId, timezone });

  if (!isValidSchedule(cron, effectiveTimezone)) {
    throw new Error(
      `Scheduler: invalid schedule for "${kind}" — cron "${cron}", timezone "${effectiveTimezone}"`,
    );
  }

  assertMinimumInterval({ kind, cron, timezone: effectiveTimezone, now });

  const job = await ScheduledJob.findOneAndUpdate(
    { kind, targetId },
    {
      $set: {
        workspaceId,
        cron,
        timezone: effectiveTimezone,
        enabled: true,
        nextRunAt: computeNextRun(cron, effectiveTimezone, now),
        lastError: null,
        consecutiveFailures: 0,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  info('Scheduler', 'Schedule upserted', {
    kind,
    targetId,
    cron,
    timezone: effectiveTimezone,
    nextRunAt: job.nextRunAt,
  });

  return job;
}

/** Disable rather than delete, so lastRunAt and missedRuns survive. */
export async function disableSchedule({ kind, targetId }) {
  const job = await ScheduledJob.findOneAndUpdate(
    { kind, targetId },
    { $set: { enabled: false } },
    { new: true },
  );

  if (job) {
    info('Scheduler', 'Schedule disabled', { kind, targetId });
  }

  return job;
}
