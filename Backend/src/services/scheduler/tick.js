import ScheduledJob from '../../models/ScheduledJob.js';
import { info, warn } from '../../utils/logger.js';
import { advanceSchedule } from './advance.js';
import { missedSlotsFor } from './missedSlots.js';
import { resolve } from './registry.js';
import { recordSuccess, recordFailure, quarantineSchedule } from './outcome.js';
import { recordHeartbeat } from './heartbeat.js';
import { isAutomationEnabled } from '../../utils/automationEnabled.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../../constants/automation.js';
import { AT_MOST_ONCE, BATCH_LIMIT, LOG_SCOPE } from '../../constants/scheduler.js';

const AUTOMATION_KINDS = [KIND_INVOICE, KIND_STATEMENT];

/**
 * The kinds this tick may claim, once the AUTOMATION_ENABLED kill switch has
 * had its say, plus the kinds it withheld.
 *
 * The switch used to be read only inside the automation handler, which returned
 * without fanning out — and returning is success, so recordSuccess advanced
 * nextRunAt past the slot. A deployment that spent three months switched off
 * consumed three billing periods and generated nothing for any of them, with no
 * error and no trace that the periods had existed. Holding the kinds back
 * BEFORE the claim leaves each slot due, so it is billed when the switch comes
 * on; only the oldest fires then, because recordSuccess advances straight past
 * the rest and counts them in missedRuns.
 *
 * It NARROWS an existing scope rather than replacing it: a per-kind EventBridge
 * rule's tick must not start claiming another rule's kinds because the switch
 * went off.
 */
export function tickKindScope(requestedKinds) {
  if (isAutomationEnabled()) return { kinds: requestedKinds, heldKinds: [] };

  const held = requestedKinds
    ? requestedKinds.filter((kind) => AUTOMATION_KINDS.includes(kind))
    : AUTOMATION_KINDS;
  const allowed = requestedKinds
    ? requestedKinds.filter((kind) => !AUTOMATION_KINDS.includes(kind))
    // null means "every kind", and there is no list of every kind to subtract
    // from — so express the exclusion as a negative filter instead.
    : null;

  return { kinds: allowed, heldKinds: held, excludeKinds: allowed === null ? AUTOMATION_KINDS : [] };
}


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
async function claimNext(now, excludeIds, stats, scope) {
  const { kinds, excludeKinds = [] } = scope;
  for (;;) {
    const candidate = await ScheduledJob.findOne({
      enabled: true,
      nextRunAt: { $lte: now },
      _id: { $nin: excludeIds },
      // A scoped tick (a per-kind EventBridge rule's credential) claims only
      // its own kinds; everything else stays due for its own rule. An unscoped
      // tick with the automation kill switch off carries the exclusion instead.
      ...(kinds ? { kind: { $in: kinds } } : {}),
      ...(excludeKinds.length > 0 ? { kind: { $nin: excludeKinds } } : {}),
    })
      .sort({ nextRunAt: 1 })
      .lean();

    if (!candidate) return null;

    // Resolved once, here, and carried on the returned job. Dispatch and the
    // failure path both need it, and re-resolving in each of them was three
    // lookups per job behind two copies of this same default.
    let policy = AT_MOST_ONCE;
    try {
      ({ policy } = resolve(candidate.kind));
    } catch {
      // Unknown kind: claim it anyway so it is counted and recorded, rather
      // than being selected again on every iteration of this loop.
    }

    if (policy !== AT_MOST_ONCE) {
      return { ...candidate, dueAt: candidate.nextRunAt, policy };
    }

    const claimed = await claimAtMostOnce(candidate, now, excludeIds, stats);
    if (claimed) return { ...claimed, policy };
    // claimAtMostOnce already excluded the candidate — either it lost the CAS
    // race to another instance, or its cron/timezone would not parse. Either
    // way, do NOT stop here: one bad row must not abandon every remaining due
    // schedule, this tick or any future one.
  }
}

/**
 * The compare-and-swap for an at-most-once claim. A cron/timezone that no
 * longer parses — a row written directly against the collection, bypassing
 * both upsertSchedule and the model validator — must be recorded and skipped
 * rather than throwing out of the tick: that throw is what previously took
 * every other schedule down with it, every minute, forever.
 *
 * Skipping alone is not enough, though. The claim advances nextRunAt, and
 * advancing is precisely what cannot be done for a row whose cron will not
 * parse — so it stays due, and the next tick selects it again, and every tick
 * after that. It is quarantined instead, and counted as a failure so that a
 * row which can never run is visible in the summary rather than silently
 * absent from it.
 *
 * advanceSchedule, not computeNextRun: a picker schedule carries no cron, and
 * cron-parser reads that null as '* * * * *' rather than failing, so the row
 * would advance by one minute per tick and fire ~1440 times a day.
 */
async function claimAtMostOnce(candidate, now, excludeIds, stats) {
  let update;
  try {
    update = {
      $set: {
        nextRunAt: advanceSchedule(candidate, now),
        lastRunAt: now,
      },
      $inc: {
        missedRuns: missedSlotsFor(candidate, now),
      },
    };
  } catch (err) {
    await quarantineSchedule(candidate, err, now);
    excludeIds.push(candidate._id);
    stats.failed += 1;
    return null;
  }

  const claimed = await ScheduledJob.findOneAndUpdate(
    { _id: candidate._id, nextRunAt: candidate.nextRunAt },
    update,
    { new: true, lean: true },
  );

  if (claimed) return { ...claimed, dueAt: candidate.nextRunAt };

  // Another caller claimed it between the read and the update.
  excludeIds.push(candidate._id);
  return null;
}

/**
 * `job.dueAt` is the slot that came due, set by claimNext — under at-most-once
 * `job.nextRunAt` has already moved on to the following slot by this point, so
 * `dueAt` is what must reach the handler as `scheduledFor`. Under at-least-once
 * the two happen to be equal (nextRunAt is not advanced until after dispatch),
 * but the handler should not have to know that.
 *
 * `timezone` and `schedule` travel with the slot because a handler that
 * derives an idempotency key or a billing window from them — the automation
 * fan-out does — must use the claimed row, not leftover Invoice Generator
 * filters and not the server's zone.
 */
async function dispatch(job, now) {
  const { handler } = resolve(job.kind);
  await handler({
    kind: job.kind,
    targetId: job.targetId,
    workspaceId: job.workspaceId,
    timezone: job.timezone,
    scheduledFor: job.dueAt,
    schedule: job.schedule,
  });
  await recordSuccess(job, job.policy, now);
}

/**
 * How many schedules the kill switch is holding back right now.
 *
 * A backlog count, not an inventory: it counts only what is DUE, so a healthy
 * deployment with the switch off and nothing due reports zero. It is the
 * operator-facing half of the change — without it a switched-off deployment
 * looks identical to one with no automation configured at all.
 */
async function countHeldBack(now, heldKinds) {
  if (heldKinds.length === 0) return 0;

  const heldBack = await ScheduledJob.countDocuments({
    enabled: true,
    nextRunAt: { $lte: now },
    kind: { $in: heldKinds },
  });
  if (heldBack > 0) {
    warn(LOG_SCOPE, 'Automation schedules are due but AUTOMATION_ENABLED is off; their slots are held, not skipped', {
      heldBack,
      kinds: heldKinds,
    });
  }
  return heldBack;
}

/**
 * Claim every due schedule, up to `limit`, and dispatch each one. `kinds`
 * (an array, or null for all) scopes the claim to those kinds only.
 */
export async function runTick({ now = new Date(), limit = BATCH_LIMIT, kinds = null } = {}) {
  // Two lists, deliberately. `excludeIds` also collects rows we lost a race
  // for, which must not count towards the batch cap or the claimed total.
  const excludeIds = [];
  const claimedIds = [];
  // Mutable because claimNext also records failures — a row it could not claim
  // at all is still a schedule that did not run, and must show in the summary.
  const stats = { dispatched: 0, failed: 0 };

  const scope = tickKindScope(kinds);
  const heldBack = await countHeldBack(now, scope.heldKinds);

  while (claimedIds.length < limit) {
    const job = await claimNext(now, excludeIds, stats, scope);
    if (!job) break;

    claimedIds.push(job._id);
    excludeIds.push(job._id);

    try {
      await dispatch(job, now);
      stats.dispatched += 1;
    } catch (err) {
      stats.failed += 1;
      await recordFailure(job, job.policy, err, now);
    }
  }

  // Conservative: this is true when the cap was reached, even if nothing was
  // actually left over. Over-reporting a cap is safe; under-reporting one is
  // the silent truncation this design forbids.
  const capped = claimedIds.length >= limit;
  if (capped) {
    warn(LOG_SCOPE, 'Batch cap reached; remaining schedules wait for the next tick', {
      limit,
    });
  }

  const summary = { claimed: claimedIds.length, ...stats, heldBack, capped };
  info(LOG_SCOPE, 'Tick complete', summary);
  await recordHeartbeat(now);
  return summary;
}
