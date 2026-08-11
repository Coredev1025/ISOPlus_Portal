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

export async function recordFailure(job, policy, err, now) {
  const failures = (job.consecutiveFailures || 0) + 1;
  const update = {
    $set: { lastError: String(err?.message || err), consecutiveFailures: failures },
  };

  // At-least-once normally leaves nextRunAt alone so the next tick retries the
  // same slot. Once it has failed this many times running, give up on the slot
  // rather than retrying it every minute indefinitely.
  if (policy === AT_LEAST_ONCE && failures >= MAX_CONSECUTIVE_FAILURES) {
    update.$set.nextRunAt = computeNextRun(job.cron, job.timezone, now);
  }

  await ScheduledJob.updateOne({ _id: job._id }, update);

  logError('Scheduler', 'Dispatch failed', {
    kind: job.kind,
    targetId: job.targetId,
    policy,
    consecutiveFailures: failures,
    advanced: Boolean(update.$set.nextRunAt),
    error: String(err?.message || err),
  });
}
