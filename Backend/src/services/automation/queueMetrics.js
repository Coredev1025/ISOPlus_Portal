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
    // getJobCounts resolves an object or rejects; the rejection is the real
    // failure mode (Redis unreachable) and the catch below owns it.
    counts = { ...EMPTY, ...(await getAutomationQueue().getJobCounts()) };
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
