import syncQueue from './sync/queue.js';
import { unregisterBoardWebhooks } from './webhookService.js';
import { info, warn } from '../utils/logger.js';

export async function cancelPendingSyncJob(boardId, syncJobId) {
  if (!syncJobId) return;
  try {
    const job = await syncQueue.getJob(syncJobId);
    if (job) {
      await job.remove();
      info('Sync-Service', 'Cancelled pending sync job', { boardId, jobId: syncJobId });
    }
  } catch (jobErr) {
    warn('Sync-Service', 'Failed to cancel job', {
      boardId,
      jobId: syncJobId,
      error: jobErr.message,
    });
  }
}

export async function unregisterBoardHook(board, authorization, logContext) {
  if (!board?.hookId) return;
  if (!authorization || !board.workspaceId) {
    warn('Sync-Service', 'Cannot remove hook - no authorization token or workspace ID', {
      boardId: board.boardId,
    });
    return;
  }

  try {
    info('Sync-Service', logContext, {
      boardId: board.boardId,
      workspaceId: board.workspaceId,
      hookId: board.hookId,
    });

    const hookResult = await unregisterBoardWebhooks(
      authorization,
      board.workspaceId,
      board.boardId,
      board.hookId,
    );

    if (hookResult.success) {
      info('Sync-Service', 'Hook removed successfully', {
        boardId: board.boardId,
        hookId: board.hookId,
      });
    } else {
      warn('Sync-Service', 'Failed to remove hook', {
        boardId: board.boardId,
        hookId: board.hookId,
        error: hookResult.error,
      });
    }
  } catch (hookErr) {
    warn('Sync-Service', 'Failed to remove hook', {
      boardId: board.boardId,
      error: hookErr.message,
    });
  }
}

export async function checkActiveQueueJob(boardId, syncJobId, syncStatus) {
  if (!syncJobId || !['board_validation', 'data_backlog_sync', 'manual_triggered_sync'].includes(syncStatus)) {
    return null;
  }

  try {
    const existingJob = await syncQueue.getJob(syncJobId);
    if (!existingJob) return null;

    const jobState = await existingJob.getState();
    if (!['waiting', 'active', 'delayed'].includes(jobState)) return null;

    info('Sync-Service', 'Sync job already in progress', {
      boardId,
      jobId: syncJobId,
      jobState,
      syncStatus,
    });

    return {
      success: false,
      alreadyRunning: true,
      message: `A sync is already ${jobState === 'active' ? 'running' : 'queued'} for this board. Please wait for it to complete.`,
      boardId,
      syncStatus,
      jobId: syncJobId,
      jobState,
    };
  } catch (jobErr) {
    warn('Sync-Service', 'Failed to check existing job status', {
      boardId,
      jobId: syncJobId,
      error: jobErr.message,
    });
    return null;
  }
}
