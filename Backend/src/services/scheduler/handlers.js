import { triggerManualSync } from '../sync.js';
import { getSchedulerAuthorization } from './auth.js';
import { register, AT_LEAST_ONCE } from './registry.js';

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
    handler: ({ targetId, workspaceId }) =>
      triggerManualSync(getSchedulerAuthorization(), workspaceId, targetId),
  });
}
