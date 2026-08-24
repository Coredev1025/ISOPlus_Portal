const CATCH_UP_STATUSES = new Set(['scheduled_sync', 'manual_triggered_sync']);

/** BullMQ states this queue actually produces while a catch-up is live. */
const LIVE_JOB_STATES = new Set(['waiting', 'active', 'delayed']);

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

export function buildBoardSyncScheduleView({
  board,
  jobStatus,
  syncExecution,
  portalSchedule,
}) {
  return {
    cron: portalSchedule?.cron ?? null,
    timezone: portalSchedule?.timezone ?? null,
    previous: board.lastSyncedAt ? { at: board.lastSyncedAt } : null,
    current: currentFrom({ board, jobStatus, syncExecution }),
    upcoming: portalSchedule?.nextRunAt ? { at: portalSchedule.nextRunAt } : null,
  };
}
