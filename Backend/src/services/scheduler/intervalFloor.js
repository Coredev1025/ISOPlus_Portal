import { minIntervalMinutes } from './nextRun.js';
import { tryResolve, AT_MOST_ONCE, AT_LEAST_ONCE } from './registry.js';
import { warn } from '../../utils/logger.js';

/**
 * Nothing that issues a document to an NDIS participant has any business
 * running more often than hourly. Used for AT_MOST_ONCE handlers.
 */
export const AT_MOST_ONCE_MIN_INTERVAL_MINUTES = 60;

/**
 * Sync is idempotent and cheap; half-hourly is a legitimate cadence. Used
 * for AT_LEAST_ONCE handlers, and for any kind whose policy cannot be
 * determined — see resolvePolicyForFloor below.
 */
export const AT_LEAST_ONCE_MIN_INTERVAL_MINUTES = 5;

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
    'Scheduler',
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
