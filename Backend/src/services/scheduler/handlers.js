import { triggerManualSync } from '../sync.js';
import { getSchedulerAuthorization } from './auth.js';
import { register } from './registry.js';
import { AT_LEAST_ONCE } from '../../constants/scheduler.js';

/**
 * triggerManualSync does not throw for every failure — two of its non-dispatch
 * outcomes come back as `{ success: false, ... }`. `alreadyRunning` is
 * idempotency doing its job (a duplicate at-least-once dispatch absorbed, as
 * intended) and must resolve normally. Anything else under `success: false` —
 * today, sync disabled on the board — must throw per handler rule 4, or the
 * tick records a clean success and the schedule goes quiet forever with no
 * signal for docs/scheduling.md's "what to alert on" to catch.
 */
function assertSyncDispatched(result) {
  if (result.success === false && !result.alreadyRunning) {
    throw new Error(`board_sync: ${result.message} (board ${result.boardId})`);
  }
}

/**
 * Imported for its side effects at boot. Each feature registers one handler.
 *
 * A handler enqueues and returns — it must never await the work itself, or a
 * tick stops being bounded.
 */
export function registerSchedulerHandlers() {
  // At-least-once: triggerManualSync is idempotent (SyncExecution.hasRunningSync
  // and checkActiveQueueJob both refuse a second concurrent sync on a board),
  // so a repeat is harmless while a silent skip only makes data staler.
  register('board_sync', {
    policy: AT_LEAST_ONCE,
    handler: async ({ targetId, workspaceId }) => {
      const result = await triggerManualSync(
        getSchedulerAuthorization(),
        workspaceId,
        targetId,
      );
      assertSyncDispatched(result);
    },
  });
}
