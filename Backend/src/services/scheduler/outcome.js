import ScheduledJob from '../../models/ScheduledJob.js';
import { error as logError } from '../../utils/logger.js';
import { advanceSchedule } from './advance.js';
import { missedSlotsFor } from './missedSlots.js';
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
  //
  // advanceSchedule, not computeNextRun: a picker schedule carries no cron,
  // and cron-parser reads that null as '* * * * *' rather than failing — so
  // this line used to move a picker job on by one minute, and the automation
  // kinds that use it would have re-fired every 60 seconds.
  if (policy === AT_LEAST_ONCE) {
    update.$set.nextRunAt = advanceSchedule(job, now);

    // That advance jumps straight past every slot between the due one and
    // now, so this is the only place they can be counted. The claim counts
    // them for at-most-once; nothing counted them here, which left missedRuns
    // permanently zero for every at-least-once schedule — both automation
    // kinds and board_sync — so anything alerting on it could never fire.
    const missed = missedSlotsFor(job, now);
    if (missed > 0) update.$inc = { missedRuns: missed };
  }

  // Deliberately NOT compare-and-swapped on `job.nextRunAt`, unlike
  // recordFailure below. Under at-least-once two instances may dispatch the
  // same slot and both succeed, so both reach this line with the same
  // `nextRunAt` and the `$inc` above applies twice.
  //
  // That is accepted rather than overlooked. Everything in `$set` is
  // idempotent — the second write stores the same cleared error, the same zero
  // failure count and a marginally later lastRunAt — and both instances
  // compute the same `nextRunAt`, so the schedule lands on the same slot
  // either way. Only `missedRuns` double-counts, and it is a health signal
  // ("at least this many slots were skipped"), not an accounting record; the
  // alert fires on non-zero, which an over-count cannot suppress. A CAS here
  // would instead drop the loser's clearing of `lastError`, which is the one
  // field an operator reads to decide whether a schedule is healthy.
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
 *
 * advanceSchedule, not computeNextRun: a picker schedule carries no cron, and
 * cron-parser reads that null as '* * * * *' rather than failing — so this
 * gave up on a slot by moving the schedule on by one minute, and the
 * automation kinds that use it would then have re-fired every 60 seconds.
 * advanceSchedule also throws for a row carrying neither or both schedule
 * representations, which disableUnrunnable below is the right answer to.
 */
async function advancePastFailureLimit(job, failures, policy, now) {
  if (policy !== AT_LEAST_ONCE || failures < MAX_CONSECUTIVE_FAILURES) return false;

  let nextRunAt;
  try {
    nextRunAt = advanceSchedule(job, now);
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
