import ScheduledJob from '../../models/ScheduledJob.js';
import { info } from '../../utils/logger.js';
import { computeNextRun, isValidSchedule } from './nextRun.js';
import { resolveTimezone } from './timezone.js';
import { assertMinimumInterval } from './intervalFloor.js';

const DUPLICATE_KEY = 11000;

const UPSERT_OPTIONS = { upsert: true, new: true, setDefaultsOnInsert: true };

/**
 * An upsert is not atomic against a unique index. Two callers for the same
 * {kind,targetId} — a toggle double-clicked, two tabs, a retried request — can
 * both find nothing, both attempt the insert, and the loser gets E11000 from
 * the unique {kind,targetId} index rather than converging on the winner's row.
 *
 * Retrying is the documented remedy: by then the row exists, the filter
 * matches it, and the second call updates rather than inserts. Once only — a
 * duplicate that survives the retry is not this race and must surface.
 */
async function upsertConverging(filter, update) {
  try {
    return await ScheduledJob.findOneAndUpdate(filter, update, UPSERT_OPTIONS);
  } catch (err) {
    if (err?.code !== DUPLICATE_KEY) throw err;
    return ScheduledJob.findOneAndUpdate(filter, update, UPSERT_OPTIONS);
  }
}

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

  const job = await upsertConverging(
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
