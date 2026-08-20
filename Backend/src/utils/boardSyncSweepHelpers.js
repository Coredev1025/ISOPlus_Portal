import { BOARD_SYNC_CRON_DEFAULT } from '../constants/scheduler.js';
import {
  SCHEDULED_SYNC_JOB_TYPE,
  SCHEDULED_SYNC_QUEUEABLE_STATUSES,
} from '../constants/sync.js';

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

export function isEligibleSyncBoard(board) {
  return Boolean(
    board?.syncData === true
    && typeof board.boardId === 'string'
    && board.boardId.trim()
    && typeof board.workspaceId === 'string'
    && board.workspaceId.trim(),
  );
}

export function buildScheduledSyncSpecs({ boards, slot, timezone, authorization }) {
  const periodKey = scheduledSyncPeriodKey({ slot, timezone });
  return boards.filter(isEligibleSyncBoard).map((board) => ({
    name: SCHEDULED_SYNC_JOB_TYPE,
    data: {
      jobType: SCHEDULED_SYNC_JOB_TYPE,
      authorization,
      workspaceId: board.workspaceId,
      boardId: board.boardId,
    },
    opts: { jobId: `sched:${board.boardId}:${periodKey}` },
  }));
}

/**
 * After addBulk: stamp syncJobId so status can show Queued while waiting.
 * Flip syncStatus to scheduled_sync only when the board is not mid first-time
 * validation/backlog (those keep their own status labels).
 */
export function buildScheduledSyncBoardWrites(specs) {
  return specs.flatMap((spec) => {
    const boardId = spec.data.boardId;
    const syncJobId = String(spec.opts.jobId);
    return [
      {
        updateOne: {
          filter: {
            boardId,
            syncStatus: { $in: SCHEDULED_SYNC_QUEUEABLE_STATUSES },
          },
          update: {
            $set: {
              syncStatus: SCHEDULED_SYNC_JOB_TYPE,
              syncJobId,
            },
          },
        },
      },
      {
        updateOne: {
          filter: {
            boardId,
            syncStatus: { $nin: SCHEDULED_SYNC_QUEUEABLE_STATUSES },
          },
          update: { $set: { syncJobId } },
        },
      },
    ];
  });
}
