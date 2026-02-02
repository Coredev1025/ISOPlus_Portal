import syncQueue from './sync/queue.js';
import Board from '../models/Board.js';
import SyncExecution from '../models/SyncExecution.js';
import { unregisterBoardWebhooks } from './webhookService.js';
import { info, error, warn } from '../utils/logger.js';

export async function enableBoardSync(authorization, workspaceId, boardId) {
  try {
    info('Sync-Service', 'Enabling sync for board', { workspaceId, boardId });
    
    const board = await Board.findOne({ boardId }).select('syncStatus').lean();
    
    if (board && ['sync_enabled', 'board_validation', 'board_valid', 'data_backlog_sync', 'realtime_sync', 'manual_triggered_sync'].includes(board.syncStatus)) {
      return {
        success: false,
        message: `Sync already enabled for this board (current status: ${board.syncStatus})`,
        boardId,
        syncStatus: board.syncStatus
      };
    }

    const updatedBoard = await Board.findOneAndUpdate(
      { boardId },
      {
        $set: {
          workspaceId: workspaceId,
          syncData: true,
          syncStatus: 'sync_enabled',
          lastSyncError: null,
          validationErrors: []
        }
      },
      { upsert: true, new: true }
    );

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

export async function disableBoardSync(boardId, authorization = null) {
  try {
    info('Sync-Service', 'Disabling sync for board', { boardId });
    
    const board = await Board.findOne({ boardId }).select('syncJobId hookId workspaceId').lean();
    
    if (!board) {
      throw new Error('Board not found');
    }

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

    if (board.hookId) {
      if (authorization && board.workspaceId) {
        try {
          info('Sync-Service', 'Removing hook for board', { 
            boardId,
            workspaceId: board.workspaceId,
            hookId: board.hookId 
          });

          const hookResult = await unregisterBoardWebhooks(
            authorization, 
            board.workspaceId, 
            boardId, 
            board.hookId
          );

          if (hookResult.success) {
            info('Sync-Service', 'Hook removed successfully', { 
              boardId,
              hookId: board.hookId 
            });
          } else {
            warn('Sync-Service', 'Failed to remove hook', { 
              boardId,
              hookId: board.hookId,
              error: hookResult.error 
            });
          }
        } catch (hookErr) {
          warn('Sync-Service', 'Failed to remove hook', { 
            boardId,
            error: hookErr.message 
          });
        }
      } else {
        warn('Sync-Service', 'Cannot remove hook - no authorization token or workspace ID', { 
          boardId 
        });
      }
    }

    await Board.findOneAndUpdate(
      { boardId },
      {
        $set: {
          syncData: false,
          syncStatus: 'sync_stopped',
          syncJobId: null,
          hookId: null,
          hookSecret: null
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

export async function retrySyncAfterFailure(authorization, workspaceId, boardId) {
  try {
    info('Sync-Service', 'Retrying sync after failure', { workspaceId, boardId });
    
    // Query board with both boardId and workspaceId for accuracy
    const board = await Board.findOne({ 
      boardId,
      workspaceId 
    }).select('syncData syncStatus label syncStats workspaceId boardId name').lean();
    
    if (!board) {
      // Check if board exists but in different workspace
      const boardInOtherWorkspace = await Board.findOne({ boardId })
        .select('workspaceId boardId name')
        .lean();
      
      if (boardInOtherWorkspace) {
        throw new Error(`Board not found in workspace ${workspaceId}. Board exists in workspace ${boardInOtherWorkspace.workspaceId}`);
      }
      
      throw new Error(`Board not found: ${boardId}`);
    }

    if (!board.syncData) {
      return {
        success: false,
        message: 'Sync is not enabled for this board. Enable sync first.',
        boardId
      };
    }

    let jobType, jobName, message;
    
    if (board.syncStatus === 'failed' || board.syncStatus === 'board_invalid') {
      jobType = 'board_validation';
      jobName = `retry-validation-${boardId}-${Date.now()}`;
      message = 'Retrying board validation';
      
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

export async function triggerManualSync(authorization, workspaceId, boardId) {
  try {
    info('Sync-Service', 'Triggering manual sync for board', { workspaceId, boardId });
    
    // Query board with both boardId and workspaceId for accuracy
    const board = await Board.findOne({ 
      boardId,
      workspaceId 
    }).select('syncData syncStatus syncJobId hookId workspaceId boardId name').lean();
    
    if (!board) {
      // Check if board exists but in different workspace
      const boardInOtherWorkspace = await Board.findOne({ boardId })
        .select('workspaceId boardId name')
        .lean();
      
      if (boardInOtherWorkspace) {
        throw new Error(`Board not found in workspace ${workspaceId}. Board exists in workspace ${boardInOtherWorkspace.workspaceId}`);
      }
      
      throw new Error(`Board not found: ${boardId}`);
    }

    if (!board.syncData) {
      return {
        success: false,
        message: 'Sync is not enabled for this board',
        boardId
      };
    }

    const hasRunningSync = await SyncExecution.hasRunningSync(boardId);
    
    if (hasRunningSync) {
      info('Sync-Service', 'Manual sync already running for board', { 
        workspaceId, 
        boardId 
      });
      
      return {
        success: false,
        alreadyRunning: true,
        message: 'A manual sync is already running for this board. Please wait for it to complete.',
        boardId,
        syncStatus: board.syncStatus
      };
    }

    // Also check if there's an active job in the queue
    if (board.syncJobId && ['board_validation', 'data_backlog_sync', 'manual_triggered_sync'].includes(board.syncStatus)) {
      try {
        const existingJob = await syncQueue.getJob(board.syncJobId);
        if (existingJob) {
          const jobState = await existingJob.getState();
          // If job is still active or waiting, sync is already running
          if (['waiting', 'active', 'delayed'].includes(jobState)) {
            info('Sync-Service', 'Sync job already in progress', { 
              boardId, 
              jobId: board.syncJobId,
              jobState,
              syncStatus: board.syncStatus
            });
            
            return {
              success: false,
              alreadyRunning: true,
              message: `A sync is already ${jobState === 'active' ? 'running' : 'queued'} for this board. Please wait for it to complete.`,
              boardId,
              syncStatus: board.syncStatus,
              jobId: board.syncJobId,
              jobState
            };
          }
        }
      } catch (jobErr) {
        warn('Sync-Service', 'Failed to check existing job status', { 
          boardId, 
          jobId: board.syncJobId,
          error: jobErr.message 
        });
      }
    }

    // Create new manual sync job
    const job = await syncQueue.add('manual_sync', {
      jobType: 'manual_triggered_sync',
      authorization,
      workspaceId,
      boardId
    }, {
      jobId: `manual-sync-${boardId}-${Date.now()}`,
      priority: 2 // Higher priority than regular sync
    });

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

export async function cancelBoardSync(boardId, authorization = null) {
  try {
    info('Sync-Service', 'Cancelling sync for board', { boardId });
    
    const board = await Board.findOne({ boardId }).select('syncJobId hookId workspaceId').lean();
    
    if (!board) {
      throw new Error('Board not found');
    }

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

    if (board.hookId) {
      if (authorization && board.workspaceId) {
        try {
          info('Sync-Service', 'Removing hook for cancelled board', { 
            boardId,
            workspaceId: board.workspaceId,
            hookId: board.hookId 
          });

          const hookResult = await unregisterBoardWebhooks(
            authorization, 
            board.workspaceId, 
            boardId, 
            board.hookId
          );

          if (hookResult.success) {
            info('Sync-Service', 'Hook removed successfully', { 
              boardId,
              hookId: board.hookId 
            });
          } else {
            warn('Sync-Service', 'Failed to remove hook', { 
              boardId,
              hookId: board.hookId,
              error: hookResult.error 
            });
          }
        } catch (hookErr) {
          warn('Sync-Service', 'Failed to remove hook', { 
            boardId,
            error: hookErr.message 
          });
        }
      } else {
        warn('Sync-Service', 'Cannot remove hook - no authorization token or workspace ID', { 
          boardId 
        });
      }
    }

    await Board.findOneAndUpdate(
      { boardId },
      {
        $set: {
          syncStatus: 'sync_cancelled',
          syncJobId: null,
          lastSyncError: 'Sync cancelled by user',
          hookId: null,
          hookSecret: null
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

export async function startBacklogSync(authorization, workspaceId, boardId) {
  try {
    info('Sync-Service', 'Starting backlog sync for board', { workspaceId, boardId });
    
    const job = await syncQueue.add('backlog_sync', {
      jobType: 'data_backlog_sync',
      authorization,
      workspaceId,
      boardId
    }, {
      jobId: `backlog-${boardId}-${Date.now()}`,
      priority: 3
    });

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

export async function enableWorkspaceSync(authorization, workspaceId) {
  try {
    info('Sync-Service', 'Enabling sync for all boards in workspace', { workspaceId });
    
    const boards = await Board.find({ 
      syncStatus: { $in: ['disabled', 'sync_stopped', 'sync_cancelled', 'failed'] }
    })
      .select('boardId name')
      .lean();

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

export async function getBoardSyncStatus(boardId) {
  try {
    const board = await Board.findOne({ boardId }).select('boardId name syncData syncStatus lastSyncedAt lastSyncError validationErrors syncStats syncJobId currentSyncGUID').lean();
    
    if (!board) {
      throw new Error('Board not found');
    }

    let jobStatus = null;
    
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

    // Get active sync execution details
    let syncExecution = null;
    if (board.currentSyncGUID) {
      try {
        syncExecution = await SyncExecution.findOne({ 
          syncGUID: board.currentSyncGUID,
          status: { $in: ['started', 'in-progress'] }
        }).lean();
      } catch (syncErr) {
        warn('Sync-Service', 'Failed to get sync execution', { 
          boardId, 
          syncGUID: board.currentSyncGUID,
          error: syncErr.message 
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
      jobStatus,
      syncExecution
    };

  } catch (err) {
    error('Sync-Service', 'Failed to get board sync status', { 
      boardId, 
      error: err.message 
    });
    throw err;
  }
}
