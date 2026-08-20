import Board from '../../models/Board.js';
import AutomationSettings from '../../models/AutomationSettings.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { info, warn } from '../../utils/logger.js';
import { getAutomationQueue } from '../automation/queue.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../../constants/automation.js';
import { buildFanOutSpecs } from '../automation/fanOut.js';
import { triggerManualSync } from '../sync.js';
import { isOfflineMode } from '../offlineIsoplus.js';
import { getSchedulerAuthorization } from './auth.js';
import { register } from './registry.js';
import { isAutomationEnabled } from '../../utils/automationEnabled.js';
import { AT_LEAST_ONCE } from '../../constants/scheduler.js';

const BLOCK_FOR_KIND = { [KIND_INVOICE]: 'invoice', [KIND_STATEMENT]: 'statement' };

/**
 * triggerManualSync does not throw for every failure — some outcomes come back
 * as `{ success: false }`. `alreadyRunning` is idempotency doing its job and
 * must resolve normally; anything else must throw, or the tick records a clean
 * success and the schedule goes quiet forever with no signal to alert on.
 */
function assertSyncDispatched(result) {
  if (result.success === false && !result.alreadyRunning) {
    throw new Error(`board_sync: ${result.message} (board ${result.boardId})`);
  }
}

/**
 * The instant the schedule came due, which the period key — and therefore the
 * idempotency guarantee — derives from. tick.js dispatches it as
 * `scheduledFor`; `nextRunAt` is the same instant off a raw ScheduledJob row.
 *
 * The throw matters: Intl silently formats *now* for undefined, so a missing
 * slot would mint a fresh jobId per retry and duplicate-bill every board.
 */
function requireSlot({ scheduledFor, nextRunAt }) {
  const slot = scheduledFor ?? nextRunAt;
  if (!slot) {
    throw new Error('automation: dispatched without a slot; refusing to fan out');
  }
  return slot;
}

/**
 * Exported for tests. A stale schedule whose settings are gone or disabled
 * must not throw: under AT_LEAST_ONCE a throw means no advance, so the same
 * dead schedule would be retried on every tick, forever.
 */
export async function runAutomationKind(kind, job) {
  const { targetId, workspaceId, timezone, schedule } = job;

  // Defence in depth. The tick now holds automation kinds back before claiming
  // them (services/scheduler/tick.js), so this is not the path a disabled
  // deployment normally takes — but runAutomationKind is also reachable
  // directly, and returning here still beats fanning out.
  //
  // Returning rather than throwing, and refusing HERE rather than in
  // workers/automationWorker.js: refusing in the worker would still mint a
  // Redis job per board per slot, those jobs would complete successfully doing
  // nothing, and their retained jobIds (see queue.js) would dedupe away the
  // first real run — turning the disabled period into an unbillable hole.
  if (!isAutomationEnabled()) {
    warn('Automation', 'Automation is configured but disabled (AUTOMATION_ENABLED); nothing generated or sent', {
      kind, targetId, workspaceId,
    });
    return;
  }

  const settings = await AutomationSettings.findOne({ workspaceId: mongoEq(targetId) }).lean();
  const block = settings?.[BLOCK_FOR_KIND[kind]];

  if (!block?.enabled) {
    warn('Automation', 'Schedule fired with no enabled settings; skipping', { kind, targetId });
    return;
  }

  const boards = await Board.find({ workspaceId: mongoEq(targetId) }).select('boardId').lean();

  // Zero boards is success, not failure. Treating it as failure would climb
  // consecutiveFailures on a workspace that is merely configured and idle, and
  // a later epic alerts on that field.
  if (boards.length === 0) {
    info('Automation', 'No boards to bill for workspace', { kind, targetId, count: 0 });
    return;
  }

  const specs = buildFanOutSpecs({
    kind,
    workspaceId: workspaceId ?? targetId,
    boards,
    slot: requireSlot(job),
    timezone,
    schedule,
  });
  await getAutomationQueue().addBulk(specs);

  info('Automation', 'Enqueued automation jobs', { kind, targetId, count: specs.length });
}

export function registerAutomationHandlers() {
  for (const kind of [KIND_INVOICE, KIND_STATEMENT]) {
    // AT_LEAST_ONCE even though a duplicate invoice is worse than a late one:
    // under at-most-once a crash mid-fan-out advances the schedule with some
    // boards never enqueued, a silently skipped billing month. The safety comes
    // from the per-board jobId in buildFanOutSpecs, which collapses a repeat of
    // the same slot, not from the policy.
    register(kind, { policy: AT_LEAST_ONCE, handler: (job) => runAutomationKind(kind, job) });
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
      // Local dev has no ISO+ credentials, so a schedule dispatched by
      // `npm run tick` must not reach the live platform. A skip, not a throw:
      // under AT_LEAST_ONCE a throw retries the same row on every tick forever.
      if (isOfflineMode()) {
        warn('Scheduler', 'board_sync skipped: backend is in offline mode', {
          kind: 'board_sync',
          targetId,
          workspaceId,
        });
        return;
      }

      const result = await triggerManualSync(
        getSchedulerAuthorization(),
        workspaceId,
        targetId,
      );
      assertSyncDispatched(result);
    },
  });

  registerAutomationHandlers();
}
