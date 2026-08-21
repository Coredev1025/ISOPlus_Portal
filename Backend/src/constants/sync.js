/**
 * BullMQ jobType / Board.syncStatus / SyncExecution.syncType for a
 * scheduled catch-up. Same work as manual_triggered_sync, distinct label.
 * Touchpoints: boardSyncSweepHelpers.js, syncWorker.js, models/Board.js,
 * models/SyncExecution.js.
 */
export const SCHEDULED_SYNC_JOB_TYPE = 'scheduled_sync';

/**
 * Board.syncStatus values that mean sync is already on — enableBoardSync
 * must refuse rather than reset and re-queue.
 * Touchpoints: services/sync.js.
 */
export const SYNC_ALREADY_ENABLED_STATUSES = [
  'sync_enabled',
  'board_validation',
  'board_valid',
  'data_backlog_sync',
  'realtime_sync',
  'manual_triggered_sync',
  SCHEDULED_SYNC_JOB_TYPE,
];

/**
 * Statuses safe to flip to scheduled_sync when a catch-up job is enqueued
 * (so Configuration can show Queued). First-time / validation paths keep
 * their status; only syncJobId is stamped for those.
 * Touchpoints: boardSyncSweepHelpers.js, services/scheduler/handlers.js.
 */
export const SCHEDULED_SYNC_QUEUEABLE_STATUSES = [
  'sync_enabled',
  'realtime_sync',
  SCHEDULED_SYNC_JOB_TYPE,
];
