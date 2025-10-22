import syncQueue from './sync/queue.js';
import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { info, error, warn } from '../utils/logger.js';

/**
 * Enable sync for a board
 * This triggers the validation and sync process in the background
 * @param {string} authorization - ISO+ authorization token
 * @param {string} workspaceId - Workspace ID
 * @param {string} boardId - Board ID
 * @returns {Promise<Object>} Result
 */
export async function enableBoardSync(authorization, workspaceId, boardId) {
  try {
    info('Sync-Service', 'Enabling sync for board', { workspaceId, boardId });
    
    // Check if board exists
    const board = await Board.findOne({ boardId });
    
    // Prevent enabling sync if already enabled or in progress
    if (board && ['sync_enabled', 'board_validation', 'board_valid', 'data_backlog_sync', 'realtime_sync', 'manual_triggered_sync'].includes(board.syncStatus)) {
      return {
        success: false,
        message: `Sync already enabled for this board (current status: ${board.syncStatus})`,
        boardId,
        syncStatus: board.syncStatus
      };
    }

    // Update board to sync_enabled status
    const updatedBoard = await Board.findOneAndUpdate(
      { boardId },
      {
        $set: {
          syncData: true,
          syncStatus: 'sync_enabled',
          lastSyncError: null,
          validationErrors: []
        }
      },
      { upsert: true, new: true }
    );

    // Add validation job to queue
    const job = await syncQueue.add('board_validation', {
      jobType: 'board_validation',
      authorization,
      workspaceId,
      boardId,
      label: updatedBoard.label || 'Default'
    }, {
      jobId: `validation-${boardId}-${Date.now()}`,
      priority: 1
    });

    // Update board with job ID
    await Board.findOneAndUpdate(
      { boardId },
      { $set: { syncJobId: job.id } }
    );

    info('Sync-Service', 'Sync enabled and validation job queued', { 
      workspaceId, 
      boardId,
      jobId: job.id 
    });

    return {
      success: true,
      message: 'Sync enabled. Board validation in progress.',
      boardId,
      syncStatus: 'sync_enabled',
      jobId: job.id
    };

  } catch (err) {
    error('Sync-Service', 'Failed to enable board sync', { 
      workspaceId, 
      boardId, 
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

/**
 * Disable sync for a board
 * @param {string} boardId - Board ID
 * @returns {Promise<Object>} Result
 */
export async function disableBoardSync(boardId) {
  try {
    info('Sync-Service', 'Disabling sync for board', { boardId });
    
    const board = await Board.findOne({ boardId });
    
    if (!board) {
      throw new Error('Board not found');
    }

    // Cancel any pending jobs
    if (board.syncJobId) {
      try {
        const job = await syncQueue.getJob(board.syncJobId);
        if (job) {
          await job.remove();
          info('Sync-Service', 'Cancelled pending sync job', { 
            boardId, 
            jobId: board.syncJobId 
          });
        }
      } catch (jobErr) {
        warn('Sync-Service', 'Failed to cancel job', { 
          boardId, 
          jobId: board.syncJobId,
          error: jobErr.message 
        });
      }
    }

    // Update board status
    await Board.findOneAndUpdate(
      { boardId },
      {
        $set: {
          syncData: false,
          syncStatus: 'sync_stopped',
          syncJobId: null
        }
      }
    );

    info('Sync-Service', 'Sync disabled for board', { boardId });

    return {
      success: true,
      message: 'Sync disabled successfully',
      boardId
    };

  } catch (err) {
    error('Sync-Service', 'Failed to disable board sync', { 
      boardId, 
      error: err.message 
    });
    throw err;
  }
}

/**
 * Retry sync for a board that failed
 * This handles restarting sync from failed/crashed states
 * @param {string} authorization - ISO+ authorization token
 * @param {string} workspaceId - Workspace ID
 * @param {string} boardId - Board ID
 * @returns {Promise<Object>} Result
 */
export async function retrySyncAfterFailure(authorization, workspaceId, boardId) {
  try {
    info('Sync-Service', 'Retrying sync after failure', { workspaceId, boardId });
    
    const board = await Board.findOne({ boardId });
    
    if (!board) {
      throw new Error('Board not found');
    }

    // Check if sync is enabled
    if (!board.syncData) {
      return {
        success: false,
        message: 'Sync is not enabled for this board. Enable sync first.',
        boardId
      };
    }

    // Determine what to retry based on current status
    let jobType, jobName, message;
    
    if (board.syncStatus === 'failed' || board.syncStatus === 'board_invalid') {
      // If validation or general sync failed, retry validation
      jobType = 'board_validation';
      jobName = `retry-validation-${boardId}-${Date.now()}`;
      message = 'Retrying board validation';
      
      // Reset status to sync_enabled
      await Board.findOneAndUpdate(
        { boardId },
        {
          $set: {
            syncStatus: 'sync_enabled',
            lastSyncError: null,
            validationErrors: []
          }
        }
      );
    } else if (['sync_stopped', 'sync_cancelled'].includes(board.syncStatus)) {
      // If sync was stopped/cancelled, restart from validation
      jobType = 'board_validation';
      jobName = `restart-validation-${boardId}-${Date.now()}`;
      message = 'Restarting sync from validation';
      
      await Board.findOneAndUpdate(
        { boardId },
        {
          $set: {
            syncStatus: 'sync_enabled',
            lastSyncError: null,
            validationErrors: []
          }
        }
      );
    } else {
      return {
        success: false,
        message: `Cannot retry from current status: ${board.syncStatus}`,
        boardId,
        syncStatus: board.syncStatus
      };
    }

    // Queue the retry job
    const job = await syncQueue.add(jobType, {
      jobType,
      authorization,
      workspaceId,
      boardId,
      label: board.label || 'Default',
      isRetry: true
    }, {
      jobId: jobName,
      priority: 1
    });

    // Update board with job ID
    await Board.findOneAndUpdate(
      { boardId },
      {
        $set: {
          syncJobId: job.id,
          'syncStats.retryCount': (board.syncStats?.retryCount || 0) + 1
        }
      }
    );

    info('Sync-Service', 'Retry job queued successfully', { 
      workspaceId, 
      boardId,
      jobId: job.id,
      jobType,
      retryCount: (board.syncStats?.retryCount || 0) + 1
    });

    return {
      success: true,
      message,
      boardId,
      syncStatus: 'sync_enabled',
      jobId: job.id,
      retryCount: (board.syncStats?.retryCount || 0) + 1
    };

  } catch (err) {
    error('Sync-Service', 'Failed to retry sync', { 
      workspaceId, 
      boardId, 
      error: err.message 
    });
    throw err;
  }
}

/**
 * Trigger manual sync for a board
 * This will re-sync all data (similar to backlog sync)
 * @param {string} authorization - ISO+ authorization token
 * @param {string} workspaceId - Workspace ID
 * @param {string} boardId - Board ID
 * @returns {Promise<Object>} Result
 */
export async function triggerManualSync(authorization, workspaceId, boardId) {
  try {
    info('Sync-Service', 'Triggering manual sync for board', { workspaceId, boardId });
    
    const board = await Board.findOne({ boardId });
    
    if (!board) {
      throw new Error('Board not found');
    }

    // Check if sync is enabled
    if (!board.syncData) {
      return {
        success: false,
        message: 'Sync is not enabled for this board',
        boardId
      };
    }

    // Check if already syncing
    if (['board_validation', 'data_backlog_sync', 'manual_triggered_sync'].includes(board.syncStatus)) {
      return {
        success: false,
        message: `Sync already in progress (current status: ${board.syncStatus})`,
        boardId,
        syncStatus: board.syncStatus
      };
    }

    // Add manual sync job to queue
    const job = await syncQueue.add('manual_sync', {
      jobType: 'manual_triggered_sync',
      authorization,
      workspaceId,
      boardId
    }, {
      jobId: `manual-sync-${boardId}-${Date.now()}`,
      priority: 2 // Higher priority than regular sync
    });

    // Update board status
    await Board.findOneAndUpdate(
      { boardId },
      {
        $set: {
          syncStatus: 'manual_triggered_sync',
          syncJobId: job.id,
          lastSyncError: null
        }
      }
    );

    info('Sync-Service', 'Manual sync job queued', { 
      workspaceId, 
      boardId,
      jobId: job.id 
    });

    return {
      success: true,
      message: 'Manual sync triggered successfully',
      boardId,
      syncStatus: 'manual_triggered_sync',
      jobId: job.id
    };

  } catch (err) {
    error('Sync-Service', 'Failed to trigger manual sync', { 
      workspaceId, 
      boardId, 
      error: err.message 
    });
    throw err;
  }
}

/**
 * Cancel sync for a board
 * This cancels any running sync jobs and sets status to cancelled
 * @param {string} boardId - Board ID
 * @returns {Promise<Object>} Result
 */
export async function cancelBoardSync(boardId) {
  try {
    info('Sync-Service', 'Cancelling sync for board', { boardId });
    
    const board = await Board.findOne({ boardId });
    
    if (!board) {
      throw new Error('Board not found');
    }

    // Cancel any pending jobs
    if (board.syncJobId) {
      try {
        const job = await syncQueue.getJob(board.syncJobId);
        if (job) {
          await job.remove();
          info('Sync-Service', 'Cancelled sync job', { 
            boardId, 
            jobId: board.syncJobId 
          });
        }
      } catch (jobErr) {
        warn('Sync-Service', 'Failed to cancel job', { 
          boardId, 
          jobId: board.syncJobId,
          error: jobErr.message 
        });
      }
    }

    // Update board status to cancelled
    await Board.findOneAndUpdate(
      { boardId },
      {
        $set: {
          syncStatus: 'sync_cancelled',
          syncJobId: null,
          lastSyncError: 'Sync cancelled by user'
        }
      }
    );

    info('Sync-Service', 'Sync cancelled for board', { boardId });

    return {
      success: true,
      message: 'Sync cancelled successfully',
      boardId,
      syncStatus: 'sync_cancelled'
    };

  } catch (err) {
    error('Sync-Service', 'Failed to cancel board sync', { 
      boardId, 
      error: err.message 
    });
    throw err;
  }
}

/**
 * Start backlog sync after successful validation
 * This is called automatically by the worker after validation succeeds
 * @param {string} authorization - ISO+ authorization token
 * @param {string} workspaceId - Workspace ID
 * @param {string} boardId - Board ID
 * @returns {Promise<Object>} Result
 */
export async function startBacklogSync(authorization, workspaceId, boardId) {
  try {
    info('Sync-Service', 'Starting backlog sync for board', { workspaceId, boardId });
    
    // Add backlog sync job to queue
    const job = await syncQueue.add('backlog_sync', {
      jobType: 'data_backlog_sync',
      authorization,
      workspaceId,
      boardId
    }, {
      jobId: `backlog-${boardId}-${Date.now()}`,
      priority: 3
    });

    // Update board with job ID
    await Board.findOneAndUpdate(
      { boardId },
      { $set: { syncJobId: job.id } }
    );

    info('Sync-Service', 'Backlog sync job queued', { 
      workspaceId, 
      boardId,
      jobId: job.id 
    });

    return {
      success: true,
      jobId: job.id
    };

  } catch (err) {
    error('Sync-Service', 'Failed to start backlog sync', { 
      workspaceId, 
      boardId, 
      error: err.message 
    });
    throw err;
  }
}

/**
 * Enable sync for all boards in a workspace
 * @param {string} authorization - ISO+ authorization token
 * @param {string} workspaceId - Workspace ID
 * @returns {Promise<Object>} Result
 */
export async function enableWorkspaceSync(authorization, workspaceId) {
  try {
    info('Sync-Service', 'Enabling sync for all boards in workspace', { workspaceId });
    
    // Find all boards that can be synced (disabled or stopped)
    const boards = await Board.find({ 
      syncStatus: { $in: ['disabled', 'sync_stopped', 'sync_cancelled', 'failed'] }
    });

    if (boards.length === 0) {
      return {
        success: true,
        message: 'No boards available to sync',
        enabledBoards: 0,
        boards: []
      };
    }

    const results = [];
    let enabledCount = 0;

    for (const board of boards) {
      try {
        const result = await enableBoardSync(authorization, workspaceId, board.boardId);
        
        results.push({
          boardId: board.boardId,
          boardName: board.name,
          enabled: result.success,
          jobId: result.jobId,
          message: result.message
        });
        
        if (result.success) {
          enabledCount++;
        }
      } catch (err) {
        results.push({
          boardId: board.boardId,
          boardName: board.name,
          enabled: false,
          error: err.message
        });
        
        error('Sync-Service', 'Failed to enable sync for board', { 
          boardId: board.boardId, 
          error: err.message 
        });
      }
    }

    info('Sync-Service', 'Workspace sync enable completed', { 
      workspaceId, 
      totalBoards: boards.length,
      enabledCount
    });

    return {
      success: true,
      message: `Enabled sync for ${enabledCount} out of ${boards.length} boards`,
      enabledBoards: enabledCount,
      totalBoards: boards.length,
      boards: results
    };

  } catch (err) {
    error('Sync-Service', 'Failed to enable workspace sync', { 
      workspaceId, 
      error: err.message 
    });
    throw err;
  }
}

/**
 * Get sync status for a board including job progress
 * @param {string} boardId - Board ID
 * @returns {Promise<Object>} Status
 */
export async function getBoardSyncStatus(boardId) {
  try {
    const board = await Board.findOne({ boardId });
    
    if (!board) {
      throw new Error('Board not found');
    }

    let jobStatus = null;
    
    // Get job status if there's an active job
    if (board.syncJobId) {
      try {
        const job = await syncQueue.getJob(board.syncJobId);
        if (job) {
          const state = await job.getState();
          const progress = job.progress;
          
          jobStatus = {
            jobId: job.id,
            state,
            progress,
            attemptsMade: job.attemptsMade,
            processedOn: job.processedOn,
            finishedOn: job.finishedOn
          };
        }
      } catch (jobErr) {
        warn('Sync-Service', 'Failed to get job status', { 
          boardId, 
          jobId: board.syncJobId,
          error: jobErr.message 
        });
      }
    }

    return {
      boardId: board.boardId,
      boardName: board.name,
      syncData: board.syncData,
      syncStatus: board.syncStatus,
      lastSyncedAt: board.lastSyncedAt,
      lastSyncError: board.lastSyncError,
      validationErrors: board.validationErrors,
      syncStats: board.syncStats,
      jobStatus
    };

  } catch (err) {
    error('Sync-Service', 'Failed to get board sync status', { 
      boardId, 
      error: err.message 
    });
    throw err;
  }
}
