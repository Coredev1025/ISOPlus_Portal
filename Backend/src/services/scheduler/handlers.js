import Board from '../../models/Board.js';
import AutomationSettings from '../../models/AutomationSettings.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { info, warn } from '../../utils/logger.js';
import { getAutomationQueue } from '../automation/queue.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../../constants/automation.js';
import { buildFanOutSpecs } from '../automation/fanOut.js';
import { recordQueuedRuns } from '../automation/runs.js';
import { isOfflineMode } from '../offlineIsoplus.js';
import { getSchedulerAuthorization } from './auth.js';
import { register } from './registry.js';
import { isAutomationEnabled } from '../../utils/automationEnabled.js';
import {
  AT_LEAST_ONCE,
  BOARD_SYNC_KIND,
  BOARD_SYNC_SPAN_WARN_MS,
  DEFAULT_TIMEZONE,
  LOG_SCOPE,
} from '../../constants/scheduler.js';
import { TRIGGER_SCHEDULE } from '../../constants/systemHealth.js';
import { buildScheduledSyncSpecs, buildScheduledSyncBoardWrites, resolveBoardSyncGapMs } from '../../utils/boardSyncSweepHelpers.js';
import syncQueue from '../sync/queue.js';

const BLOCK_FOR_KIND = { [KIND_INVOICE]: 'invoice', [KIND_STATEMENT]: 'statement' };

export async function runBoardSyncSweep({ slot, timezone = DEFAULT_TIMEZONE } = {}) {
  if (isOfflineMode()) {
    warn(LOG_SCOPE, 'board_sync skipped: backend is in offline mode', {
      kind: BOARD_SYNC_KIND,
    });
    return;
  }

  if (!slot) {
    throw new Error('board_sync: dispatched without a slot; refusing to fan out');
  }

  const boards = await Board.find({ syncData: true })
    .select('boardId workspaceId syncData')
    .lean();

  const gapMs = resolveBoardSyncGapMs();
  const specs = buildScheduledSyncSpecs({
    boards,
    slot,
    timezone,
    authorization: getSchedulerAuthorization(),
    gapMs,
  });

  if (specs.length === 0) {
    info(LOG_SCOPE, 'board_sync sweep: no sync-enabled boards', { count: 0 });
    return;
  }

  // index * gap can outrun the next cron slot; different periodKeys then do not
  // collapse, so boards stay Queued across overlapping sweeps. Warn only — do
  // not silently shrink the operator's gap.
  const spanMs = specs.length > 1 ? (specs.length - 1) * gapMs : 0;
  if (spanMs > BOARD_SYNC_SPAN_WARN_MS) {
    warn(LOG_SCOPE, 'board_sync sweep span exceeds the cron interval', {
      spanMs,
      boards: specs.length,
      gapMs,
    });
  }

  await syncQueue.addBulk(specs);
  const writes = buildScheduledSyncBoardWrites(specs);
  if (writes.length > 0) {
    await Board.bulkWrite(writes, { ordered: false });
  }
  info(LOG_SCOPE, 'board_sync sweep enqueued', { count: specs.length });
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
  const { targetId, workspaceId, timezone, schedule, bypassEmail = null } = job;

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
    bypassEmail,
  });
  await getAutomationQueue().addBulk(specs);

  // After the enqueue, not before: a run recorded for a job that never reached
  // the queue would show as a permanently queued run nothing will ever close.
  // recordQueuedRuns is keyed on the same jobId BullMQ dedupes on, so a
  // redispatch of this slot updates nothing rather than duplicating.
  const recorded = await recordQueuedRuns({ specs, trigger: TRIGGER_SCHEDULE });

  info('Automation', 'Enqueued automation jobs', {
    kind,
    targetId,
    count: specs.length,
    runsRecorded: recorded,
  });
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
 *
 * Portal board catch-up is driven by `startBoardSyncCron` (in-process
 * setTimeout + cron-parser), not by the EventBridge tick — do not register
 * `board_sync` here.
 */
export function registerSchedulerHandlers() {
  registerAutomationHandlers();
}
