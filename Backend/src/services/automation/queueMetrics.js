import { getAutomationQueue } from './queue.js';
import { QUEUE_DEPTH_WARN } from '../../constants/systemHealth.js';
import { warn } from '../../utils/logger.js';

const EMPTY = { waiting: 0, active: 0, delayed: 0, failed: 0 };

/**
 * Outstanding work on the automation queue.
 *
 * `total` counts waiting + active + delayed — the jobs still owed a worker.
 * Failed jobs are reported but excluded from depth: a failed job is not
 * waiting for anything, and folding it in makes a backlog alarm that never
 * clears.
 *
 * Never throws. Redis being unreachable should grey out one tile, not take the
 * whole System Health overview down with it, so the failure is logged and
 * reported as `available: false`.
 */
export async function readQueueDepth() {
  let counts = EMPTY;
  let available = true;

  try {
    const raw = await getAutomationQueue().getJobCounts();
    // Shape-checked, not just spread: a non-object answer (a string, null)
    // spreads to nothing and would otherwise be reported as a genuine zero
    // queue rather than as "could not read it".
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError(`getJobCounts returned ${typeof raw}`);
    }
    counts = { ...EMPTY, ...raw };
  } catch (err) {
    available = false;
    warn('SystemHealth', 'Could not read automation queue depth', { error: err?.message });
  }

  const total = counts.waiting + counts.active + counts.delayed;

  return {
    waiting: counts.waiting,
    active: counts.active,
    delayed: counts.delayed,
    failed: counts.failed,
    total,
    backlogged: total >= QUEUE_DEPTH_WARN,
    available,
  };
}
