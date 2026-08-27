const CATCH_UP_STATUSES = new Set(['scheduled_sync', 'manual_triggered_sync']);

/** BullMQ states this queue actually produces while a catch-up is live. */
const LIVE_JOB_STATES = new Set(['waiting', 'active', 'delayed']);

/** cancelSync stamps this — not a failure for Previous status. */
const CANCELLED_SYNC_ERROR = 'Sync cancelled by user';

function currentFrom({ board, jobStatus, syncExecution }) {
  if (jobStatus?.state && LIVE_JOB_STATES.has(jobStatus.state)) {
    return { state: jobStatus.state, syncType: board.syncStatus };
  }
  if (syncExecution?.status) {
    return {
      state: syncExecution.status,
      syncType: syncExecution.syncType || board.syncStatus,
    };
  }
  if (CATCH_UP_STATUSES.has(board.syncStatus)) {
    return { state: 'in-progress', syncType: board.syncStatus };
  }
  return null;
}

/**
 * Last completed catch-up instant + outcome for Board Configuration / generators.
 * Sticky lastSyncError (until the next success clears it) marks Failed; a user
 * cancel message does not.
 */
export function previousFromBoard(board) {
  if (!board?.lastSyncedAt) return null;
  const error = board.lastSyncError;
  const failed = Boolean(error) && error !== CANCELLED_SYNC_ERROR;
  return {
    at: board.lastSyncedAt,
    status: failed ? 'failed' : 'completed',
  };
}

export function buildBoardSyncScheduleView({
  board,
  jobStatus,
  syncExecution,
  portalSchedule,
}) {
  return {
    cron: portalSchedule?.cron ?? null,
    timezone: portalSchedule?.timezone ?? null,
    previous: previousFromBoard(board),
    current: currentFrom({ board, jobStatus, syncExecution }),
    upcoming: portalSchedule?.nextRunAt ? { at: portalSchedule.nextRunAt } : null,
  };
}
