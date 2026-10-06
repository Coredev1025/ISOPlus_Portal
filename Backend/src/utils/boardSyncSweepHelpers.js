import {
  BOARD_SYNC_CRON_DEFAULT,
  BOARD_SYNC_GAP_MS_DEFAULT,
  BOARD_SYNC_GAP_MS_MAX,
} from '../constants/scheduler.js';
import {
  SCHEDULED_SYNC_JOB_TYPE,
  SCHEDULED_SYNC_QUEUEABLE_STATUSES,
} from '../constants/sync.js';

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no']);

/**
 * Stable identifier for one claimed sweep slot, used in BullMQ jobIds.
 * Derived from the claimed slot in the schedule timezone, never Date.now().
 */
export function scheduledSyncPeriodKey({ slot, timezone }) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(slot)
      .map((part) => [part.type, part.value]),
  );

  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
}

export function resolveBoardSyncCron(env = process.env) {
  const raw = typeof env.BOARD_SYNC_CRON === 'string' ? env.BOARD_SYNC_CRON.trim() : '';
  return raw || BOARD_SYNC_CRON_DEFAULT;
}

/**
 * Master switch for the portal scheduled catch-up only. Unset/blank = on.
 * false / 0 / off / no (case-insensitive) = off. Per-board Sync, webhooks,
 * and manual Resync are unaffected. Gated at startBoardSyncCron / status meta
 * — see docs/scheduling.md.
 */
export function resolveBoardSyncEnabled(env = process.env) {
  const raw = typeof env.BOARD_SYNC_ENABLED === 'string' ? env.BOARD_SYNC_ENABLED.trim() : '';
  if (!raw) return true;
  return !DISABLED_VALUES.has(raw.toLowerCase());
}

/**
 * Minimum delay (ms) between starts of consecutive scheduled_sync jobs in one
 * sweep. Non-numeric or negative → default. Capped at BOARD_SYNC_GAP_MS_MAX.
 * See docs/scheduling.md.
 */
export function resolveBoardSyncGapMs(env = process.env) {
  const raw = typeof env.BOARD_SYNC_GAP_MS === 'string' ? env.BOARD_SYNC_GAP_MS.trim() : '';
  if (!raw) return BOARD_SYNC_GAP_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return BOARD_SYNC_GAP_MS_DEFAULT;
  return Math.min(Math.floor(n), BOARD_SYNC_GAP_MS_MAX);
}

export function isEligibleSyncBoard(board) {
  return Boolean(
    board?.syncData === true
    && typeof board.boardId === 'string'
    && board.boardId.trim()
    && typeof board.workspaceId === 'string'
    && board.workspaceId.trim(),
  );
}

export function buildScheduledSyncSpecs({
  boards,
  slot,
  timezone,
  authorization,
  gapMs = BOARD_SYNC_GAP_MS_DEFAULT,
}) {
  const periodKey = scheduledSyncPeriodKey({ slot, timezone });
  return boards.filter(isEligibleSyncBoard).map((board, index) => {
    const opts = {
      jobId: `sched:${board.boardId}:${periodKey}`,
      // Yields to manual Resync (priority 2): BullMQ runs LOWER numbers first
      // (0 = highest). Unprioritized jobs still beat both — see wait-list RPOP.
      priority: 10,
    };
    if (gapMs > 0) {
      opts.delay = index * gapMs;
    }
    return {
      name: SCHEDULED_SYNC_JOB_TYPE,
      data: {
        jobType: SCHEDULED_SYNC_JOB_TYPE,
        authorization,
        workspaceId: board.workspaceId,
        boardId: board.boardId,
      },
      opts,
    };
  });
}

/**
 * After addBulk: stamp syncJobId so status can show Queued while waiting.
 * Flip syncStatus to scheduled_sync only when the board is not mid first-time
 * validation/backlog (those keep their own status labels).
 */
export function buildScheduledSyncBoardWrites(specs) {
  return specs.map((spec) => {
    const boardId = spec.data.boardId;
    const syncJobId = String(spec.opts.jobId);
    return {
      updateOne: {
        filter: { boardId },
        update: [{
          $set: {
            syncJobId,
            syncStatus: {
              $cond: [
                { $in: ['$syncStatus', SCHEDULED_SYNC_QUEUEABLE_STATUSES] },
                SCHEDULED_SYNC_JOB_TYPE,
                '$syncStatus',
              ],
            },
          },
        }],
      },
    };
  });
}
