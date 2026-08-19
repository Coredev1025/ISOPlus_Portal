/**
 * How many board-sync jobs may run at once. 1 is the traffic cap for
 * scheduled catch-up, manual Resync, and backlog sharing this worker.
 * Touchpoints: workers/syncWorker.js.
 */
export const SYNC_WORKER_CONCURRENCY = 1;

/**
 * BullMQ jobType / Board.syncStatus / SyncExecution.syncType for a
 * scheduled catch-up. Same work as manual_triggered_sync, distinct label.
 * Touchpoints: boardSyncSweepHelpers.js, syncWorker.js, models/Board.js,
 * models/SyncExecution.js.
 */
export const SCHEDULED_SYNC_JOB_TYPE = 'scheduled_sync';
