import Board from '../models/Board.js';
import { info, warn, error } from '../utils/logger.js';
import { logAuditTrail } from '../utils/auditLogger.js';
import { enableBoardSync, disableBoardSync } from '../services/sync.js';

export async function handleBoardSyncEnable({ req, workspaceId, boardId }) {
  info('Board-Service', 'Sync enabled in board configuration, triggering sync job', {
    boardId,
    workspaceId,
  }, req ?? null);

  const syncResult = await enableBoardSync(req.session.Authorization, workspaceId, boardId);

  if (syncResult.success) {
    info('Board-Service', 'Sync job queued successfully', {
      boardId,
      workspaceId,
      jobId: syncResult.jobId,
    }, req ?? null);

    await logAuditTrail({
      workspaceId,
      boardId,
      action: 'Enabled Board Sync',
      detail: `Board sync enabled and validation job queued (Job ID: ${syncResult.jobId})`,
      req,
      category: 'Sync',
      entityType: 'Board',
      entityId: boardId,
      success: true,
    });
    return { syncResult };
  }

  warn('Board-Service', 'Sync job queue failed', {
    boardId,
    workspaceId,
    reason: syncResult.message,
  }, req ?? null);
  return { syncResult };
}

export async function handleBoardSyncDisable({ req, workspaceId, boardId }) {
  info('Board-Service', 'Sync disabled in board configuration', {
    boardId,
    workspaceId,
  }, req ?? null);

  try {
    const syncResult = await disableBoardSync(boardId);
    info('Board-Service', 'Sync disabled successfully', { boardId, workspaceId }, req ?? null);
    await logAuditTrail({
      workspaceId,
      boardId,
      action: 'Disabled Board Sync',
      detail: 'Board sync disabled and pending jobs cancelled',
      req,
      category: 'Sync',
      entityType: 'Board',
      entityId: boardId,
      success: true,
    });
    return { syncResult };
  } catch (syncErr) {
    error('Board-Service', 'Failed to disable sync', {
      boardId,
      workspaceId,
      error: syncErr.message,
      stack: syncErr.stack,
    }, req ?? null);
    return { syncResult: null, error: syncErr };
  }
}

export async function revertBoardSyncFlag(boardId) {
  await Board.updateOne({ boardId: { $eq: String(boardId) } }, { $set: { syncData: false } });
}

export function parseSyncToggle(body, existingBoard) {
  const wasSyncEnabled = existingBoard?.syncData || false;
  const willSyncBeEnabled = body.syncData === true || body.syncData === 'true';
  return { wasSyncEnabled, willSyncBeEnabled };
}
