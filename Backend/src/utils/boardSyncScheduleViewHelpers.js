const CATCH_UP_STATUSES = new Set(['scheduled_sync', 'manual_triggered_sync']);

function previousFrom({ lastCompleted, lastSyncedAt }) {
  if (lastCompleted?.endTime) {
    return {
      at: lastCompleted.endTime,
      status: lastCompleted.status,
      syncType: lastCompleted.syncType,
    };
  }
  if (lastSyncedAt) {
    return { at: lastSyncedAt, status: 'completed', syncType: null };
  }
  return null;
}

function currentFrom({ board, jobStatus, syncExecution }) {
  if (jobStatus?.state) {
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

export function buildBoardSyncScheduleView({
  board,
  jobStatus,
  syncExecution,
  lastCompleted,
  portalSchedule,
}) {
  return {
    cron: portalSchedule?.cron ?? null,
    timezone: portalSchedule?.timezone ?? null,
    previous: previousFrom({ lastCompleted, lastSyncedAt: board.lastSyncedAt }),
    current: currentFrom({ board, jobStatus, syncExecution }),
    upcoming: portalSchedule?.nextRunAt ? { at: portalSchedule.nextRunAt } : null,
  };
}
