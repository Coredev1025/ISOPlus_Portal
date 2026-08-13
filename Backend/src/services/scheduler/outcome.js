import ScheduledJob from '../../models/ScheduledJob.js';
import { error as logError } from '../../utils/logger.js';
import { computeNextRun } from './nextRun.js';
import {
  AT_LEAST_ONCE,
  AT_MOST_ONCE,
  MAX_CONSECUTIVE_FAILURES,
  LOG_SCOPE,
} from '../../constants/scheduler.js';

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
 * A schedule whose own next slot cannot be computed can never run again: the
 * cron/timezone that has to be parsed in order to advance it is the thing that
 * does not parse. Leaving such a row enabled means re-reading and re-failing it
 * on every tick, forever. Disable it — non-destructively, so lastRunAt,
 * missedRuns and lastError survive for whoever investigates — and let
 * upsertSchedule re-enable it if the schedule is corrected.
 */
async function disableUnrunnable(job, err) {
  await ScheduledJob.updateOne({ _id: job._id }, { $set: { enabled: false } });

  logError(LOG_SCOPE, 'Schedule disabled: its next run cannot be computed', {
    kind: job.kind,
    targetId: job.targetId,
    cron: job.cron,
    timezone: job.timezone,
    error: describeError(err),
  });
}

/**
 * At-least-once normally leaves nextRunAt alone so the next tick retries the
 * same slot. Once it has failed this many times running, give up on the slot
 * rather than retrying it every minute indefinitely.
 *
 * The advance is guarded on the slot it was read for, for the same reason the
 * failure itself is: a concurrent success may already have moved the schedule
 * on. cron/timezone come from the caller's copy rather than the re-read row,
 * because it is that copy the dispatch was made against.
 */
async function advancePastFailureLimit(job, failures, policy, now) {
  if (policy !== AT_LEAST_ONCE || failures < MAX_CONSECUTIVE_FAILURES) return false;

  let nextRunAt;
  try {
    nextRunAt = computeNextRun(job.cron, job.timezone, now);
  } catch (err) {
    await disableUnrunnable(job, err);
    return false;
  }

  const { modifiedCount } = await ScheduledJob.updateOne(
    { _id: job._id, nextRunAt: job.nextRunAt },
    { $set: { nextRunAt } },
  );
  return modifiedCount === 1;
}

/**
 * Compare-and-swap on the slot this dispatch was made for. Under at-least-once
 * two instances may dispatch the same slot — that is the guarantee, not a
 * fault — so one may fail after the other has already succeeded and advanced
 * the schedule. That late failure must not resurrect lastError, or a stale
 * failure count, on a row that has moved on.
 *
 * consecutiveFailures is $inc'd rather than derived from the copy read before
 * dispatch, for the same reason: two instances that both fail the same slot
 * both read the same number, and computing it in memory writes it twice.
 */
export async function recordFailure(job, policy, err, now) {
  const errorDescription = describeError(err);

  const applied = await ScheduledJob.findOneAndUpdate(
    { _id: job._id, nextRunAt: job.nextRunAt },
    { $set: { lastError: errorDescription }, $inc: { consecutiveFailures: 1 } },
    { new: true, lean: true },
  );

  if (!applied) {
    logError(LOG_SCOPE, 'Discarded a failure for a schedule that had already moved on', {
      kind: job.kind,
      targetId: job.targetId,
      policy,
      error: errorDescription,
    });
    return;
  }

  const advanced = await advancePastFailureLimit(
    job,
    applied.consecutiveFailures,
    policy,
    now,
  );

  logError(LOG_SCOPE, 'Dispatch failed', {
    kind: job.kind,
    targetId: job.targetId,
    policy,
    consecutiveFailures: applied.consecutiveFailures,
    advanced,
    error: errorDescription,
  });
}

/**
 * For a schedule the tick could not even claim, because computing its next
 * slot threw. Records the failure like any other, then takes it out of the
 * claim query so it stops being selected on every tick.
 */
export async function quarantineSchedule(job, err, now) {
  await recordFailure(job, AT_MOST_ONCE, err, now);
  await disableUnrunnable(job, err);
}
