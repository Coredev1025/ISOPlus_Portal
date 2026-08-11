import ScheduledJob from '../../models/ScheduledJob.js';
import { info, warn } from '../../utils/logger.js';
import { computeNextRun, countMissedSlots } from './nextRun.js';
import { resolve, AT_MOST_ONCE } from './registry.js';
import { recordSuccess, recordFailure } from './outcome.js';

export const BATCH_LIMIT = 100;

/**
 * Take the next due schedule, if any.
 *
 * Under at-most-once the claim is a compare-and-swap on the nextRunAt we just
 * read: if another instance got there first the value has changed, the update
 * matches nothing, and we move on. The claimed row's nextRunAt is now in the
 * future so it drops out of the query.
 *
 * Under at-least-once nextRunAt is deliberately left alone until the handler
 * succeeds, so the caller must exclude what it has already seen.
 */
async function claimNext(now, excludeIds) {
  for (;;) {
    const candidate = await ScheduledJob.findOne({
      enabled: true,
      nextRunAt: { $lte: now },
      _id: { $nin: excludeIds },
    })
      .sort({ nextRunAt: 1 })
      .lean();

    if (!candidate) return null;

    let policy = AT_MOST_ONCE;
    try {
      ({ policy } = resolve(candidate.kind));
    } catch {
      // Unknown kind: claim it anyway so it is counted and recorded, rather
      // than being selected again on every iteration of this loop.
    }

    if (policy !== AT_MOST_ONCE) {
      return { ...candidate, dueAt: candidate.nextRunAt };
    }

    const claimed = await ScheduledJob.findOneAndUpdate(
      { _id: candidate._id, nextRunAt: candidate.nextRunAt },
      {
        $set: {
          nextRunAt: computeNextRun(candidate.cron, candidate.timezone, now),
          lastRunAt: now,
        },
        $inc: {
          missedRuns: countMissedSlots(
            candidate.cron,
            candidate.timezone,
            candidate.nextRunAt,
            now,
          ),
        },
      },
      { new: true, lean: true },
    );

    if (claimed) return { ...claimed, dueAt: candidate.nextRunAt };

    // Another caller claimed it between the read and the update. Skip it for
    // the rest of this tick and try the next candidate — do NOT stop here, or
    // one lost race would abandon every remaining due schedule.
    excludeIds.push(candidate._id);
  }
}

/**
 * `job.dueAt` is the slot that came due, set by claimNext — under at-most-once
 * `job.nextRunAt` has already moved on to the following slot by this point, so
 * `dueAt` is what must reach the handler as `scheduledFor`. Under at-least-once
 * the two happen to be equal (nextRunAt is not advanced until after dispatch),
 * but the handler should not have to know that.
 */
async function dispatch(job, now) {
  const { handler, policy } = resolve(job.kind);
  await handler({
    kind: job.kind,
    targetId: job.targetId,
    workspaceId: job.workspaceId,
    scheduledFor: job.dueAt,
  });
  await recordSuccess(job, policy, now);
}

/** Claim every due schedule, up to `limit`, and dispatch each one. */
export async function runTick({ now = new Date(), limit = BATCH_LIMIT } = {}) {
  // Two lists, deliberately. `excludeIds` also collects rows we lost a race
  // for, which must not count towards the batch cap or the claimed total.
  const excludeIds = [];
  const claimedIds = [];
  let dispatched = 0;
  let failed = 0;

  while (claimedIds.length < limit) {
    const job = await claimNext(now, excludeIds);
    if (!job) break;

    claimedIds.push(job._id);
    excludeIds.push(job._id);

    try {
      await dispatch(job, now);
      dispatched += 1;
    } catch (err) {
      failed += 1;
      let policy = AT_MOST_ONCE;
      try {
        ({ policy } = resolve(job.kind));
      } catch {
        // Unknown kind — recorded against the row below with the default policy.
      }
      await recordFailure(job, policy, err, now);
    }
  }

  // Conservative: this is true when the cap was reached, even if nothing was
  // actually left over. Over-reporting a cap is safe; under-reporting one is
  // the silent truncation this design forbids.
  const capped = claimedIds.length >= limit;
  if (capped) {
    warn('Scheduler', 'Batch cap reached; remaining schedules wait for the next tick', {
      limit,
    });
  }

  const summary = { claimed: claimedIds.length, dispatched, failed, capped };
  info('Scheduler', 'Tick complete', summary);
  return summary;
}
