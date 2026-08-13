import { minIntervalMinutes } from './nextRun.js';
import { tryResolve } from './registry.js';
import { warn } from '../../utils/logger.js';
import {
  AT_MOST_ONCE,
  AT_LEAST_ONCE,
  AT_MOST_ONCE_MIN_INTERVAL_MINUTES,
  AT_LEAST_ONCE_MIN_INTERVAL_MINUTES,
  LOG_SCOPE,
} from '../../constants/scheduler.js';

function floorForPolicy(policy) {
  return policy === AT_MOST_ONCE
    ? AT_MOST_ONCE_MIN_INTERVAL_MINUTES
    : AT_LEAST_ONCE_MIN_INTERVAL_MINUTES;
}

/**
 * The policy for `kind`, or the lenient AT_LEAST_ONCE floor if no handler is
 * registered for it in this process. upsertSchedule can legitimately be
 * called for a kind that is not registered yet (a test, a script) — an
 * unregistered kind cannot be dispatched anyway, so refusing to create the
 * schedule over it buys nothing, while blocking on it would break those
 * legitimate callers.
 */
function resolvePolicyForFloor(kind) {
  const entry = tryResolve(kind);
  if (entry) return entry.policy;

  warn(
    LOG_SCOPE,
    'No registered handler for kind; applying the lenient minimum-interval floor',
    { kind },
  );
  return AT_LEAST_ONCE;
}

/**
 * Rejects a cron whose smallest gap between consecutive fires is under the
 * floor for `kind`'s delivery policy. Must be called before anything is
 * written — the caller (upsertSchedule) runs this ahead of the ScheduledJob
 * write, consistent with its existing cron/timezone validation.
 */
export function assertMinimumInterval({ kind, cron, timezone, now }) {
  const policy = resolvePolicyForFloor(kind);
  const floorMinutes = floorForPolicy(policy);
  const actualMinutes = minIntervalMinutes(cron, timezone, now);

  if (actualMinutes < floorMinutes) {
    throw new Error(
      `Scheduler: cron "${cron}" for "${kind}" has a minimum interval of ` +
        `${actualMinutes} minutes, below the ${floorMinutes}-minute floor for ` +
        `the "${policy}" policy`,
    );
  }
}
