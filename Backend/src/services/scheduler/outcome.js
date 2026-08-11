import ScheduledJob from '../../models/ScheduledJob.js';
import { error as logError } from '../../utils/logger.js';
import { computeNextRun } from './nextRun.js';
import { AT_LEAST_ONCE } from './registry.js';

/**
 * How many consecutive failures an at-least-once schedule may accumulate
 * before it stops being retried on every tick and is advanced to its next slot
 * instead. Bounds a permanently broken handler without disabling a schedule
 * that may only be temporarily wrong.
 */
export const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Describes any thrown value usefully for logging and storage.
 * Error.message for Error instances, the value itself for strings,
 * JSON stringification for objects, and String() fallback for circulars.
 */
function describeError(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export async function recordSuccess(job, policy, now) {
  const update = {
    $set: { lastError: null, consecutiveFailures: 0, lastRunAt: now },
  };

  // Under at-most-once the claim already advanced nextRunAt. Advancing again
  // here would skip a slot.
  if (policy === AT_LEAST_ONCE) {
    update.$set.nextRunAt = computeNextRun(job.cron, job.timezone, now);
  }

  await ScheduledJob.updateOne({ _id: job._id }, update);
}

/**
 * The give-up advance itself calls computeNextRun, which throws for a
 * cron/timezone that no longer parses — a row written directly against the
 * collection, bypassing both upsertSchedule and the model validator. That
 * must not stop lastError/consecutiveFailures from being recorded, and must
 * not escape recordFailure: this is the row already failing every tick, and a
 * throw here previously took the rest of the tick down with it.
 */
function tryAdvancePastFailureLimit(job, now) {
  try {
    return computeNextRun(job.cron, job.timezone, now);
  } catch (err) {
    logError('Scheduler', 'Could not advance an unparseable schedule past its failure limit', {
      kind: job.kind,
      targetId: job.targetId,
      error: describeError(err),
    });
    return undefined;
  }
}

export async function recordFailure(job, policy, err, now) {
  const failures = (job.consecutiveFailures || 0) + 1;
  const errorDescription = describeError(err);
  const set = { lastError: errorDescription, consecutiveFailures: failures };

  // At-least-once normally leaves nextRunAt alone so the next tick retries the
  // same slot. Once it has failed this many times running, give up on the slot
  // rather than retrying it every minute indefinitely.
  if (policy === AT_LEAST_ONCE && failures >= MAX_CONSECUTIVE_FAILURES) {
    const advanced = tryAdvancePastFailureLimit(job, now);
    if (advanced) set.nextRunAt = advanced;
  }

  await ScheduledJob.updateOne({ _id: job._id }, { $set: set });

  logError('Scheduler', 'Dispatch failed', {
    kind: job.kind,
    targetId: job.targetId,
    policy,
    consecutiveFailures: failures,
    advanced: Boolean(set.nextRunAt),
    error: errorDescription,
  });
}
