import { BOARD_SYNC_CRON_DEFAULT } from '../constants/scheduler.js';
import { SCHEDULED_SYNC_JOB_TYPE } from '../constants/sync.js';

/**
 * Stable identifier for one claimed sweep slot, used in BullMQ jobIds.
 * Derived from the claimed slot in the schedule timezone, never Date.now().
 */
function scheduledSyncPeriodKey({ slot, timezone }) {
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
