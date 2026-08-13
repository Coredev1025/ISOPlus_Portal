import SchedulerHealth, { SCHEDULER_HEALTH_KEY } from '../../models/SchedulerHealth.js';
import { warn } from '../../utils/logger.js';

/**
 * Records that the scheduler ticked. Called on every tick, including one
 * that claims nothing — a `claimed: 0` heartbeat is the normal, healthy
 * state and is exactly what proves the clock is still alive. Recording only
 * when work happened would make an idle-but-healthy scheduler indistinguishable
 * from a dead one.
 *
 * Upserts a single document keyed on SCHEDULER_HEALTH_KEY, so the first tick
 * creates it and every later tick updates the same row.
 *
 * A failure here is a monitoring gap, not a tick failure: it must never
 * surface to the caller, so it is caught and logged rather than thrown.
 */
export async function recordHeartbeat(now) {
  try {
    await SchedulerHealth.findOneAndUpdate(
      { key: SCHEDULER_HEALTH_KEY },
      { $set: { lastTickAt: now } },
      { upsert: true },
    );
  } catch (err) {
    warn('Scheduler', 'Failed to record scheduler heartbeat', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
