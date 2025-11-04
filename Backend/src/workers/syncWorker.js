import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { getBoard, getFolder, getItem } from '../services/isoplus.js';
import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { validateBoard } from '../services/sync/validator.js';
import { registerBoardWebhooks } from '../services/webhookService.js';
import { info, error, warn } from '../utils/logger.js';

// Redis connection configuration for ElastiCache
// Replace with your ElastiCache Redis endpoint and port
const redisConnection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379, // Default Redis port
  ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
  maxRetriesPerRequest: null, // Recommended for production
});

/**
 * Process board validation
 */
async function processBoardValidation(job) {
  const { authorization, workspaceId, boardId, label } = job.data;
  
  info('Sync-Worker', 'Processing board validation', { jobId: job.id, workspaceId, boardId });
  
  try {
    // Update status to validating
    await Board.findOneAndUpdate(
      { boardId },
      { 
        $set: { 
          syncStatus: 'board_validation',
          syncJobId: job.id
        } 
      }
    );
    
    // Perform validation
    const validationResult = await validateBoard(workspaceId, boardId, label);
    
    if (validationResult.isValid) {
      // Board is valid, move to board_valid state
      await Board.findOneAndUpdate(
        { boardId },
        { 
          $set: { 
            syncStatus: 'board_valid',
            validationErrors: [],
            lastSyncError: null
          } 
        }
      );
      
      info('Sync-Worker', 'Board validation successful', { jobId: job.id, boardId });
      
      // Automatically queue backlog sync job
      const { default: syncQueue } = await import('../services/sync/queue.js');
      const backlogJob = await syncQueue.add('backlog_sync', {
        jobType: 'data_backlog_sync',
        authorization,
        workspaceId,
        boardId
      }, {
        jobId: `backlog-${boardId}-${Date.now()}`,
        priority: 3
      });
      
      // Update board with new job ID
      await Board.findOneAndUpdate(
        { boardId },
        { $set: { syncJobId: backlogJob.id } }
      );
      
      info('Sync-Worker', 'Backlog sync job automatically queued after validation', { 
        jobId: job.id, 
        boardId,
        backlogJobId: backlogJob.id 
      });
      
      // Return data to trigger next job (backlog sync)
      return {
        success: true,
        nextStep: 'data_backlog_sync',
        backlogJobId: backlogJob.id,
        validationResult
      };
    } else {
      // Board validation failed
      await Board.findOneAndUpdate(
        { boardId },
        { 
          $set: { 
            syncStatus: 'board_invalid',
            validationErrors: validationResult.errors,
            lastSyncError: `Board validation failed: ${validationResult.errors.join(', ')}`
          } 
        }
      );
      
      throw new Error(`Board validation failed: ${validationResult.errors.join(', ')}`);
    }
  } catch (err) {
    error('Sync-Worker', 'Board validation failed', { 
      jobId: job.id, 
      boardId, 
      error: err.message 
    });
    throw err;
  }
}

/**
 * Process data backlog sync (initial sync of all data)
 */
async function processDataBacklogSync(job) {
  const { authorization, workspaceId, boardId } = job.data;
  
  info('Sync-Worker', 'Processing data backlog sync', { jobId: job.id, workspaceId, boardId });
  
  try {
    // Update status to data_backlog_sync
    await Board.findOneAndUpdate(
      { boardId },
      { 
        $set: { 
          syncStatus: 'data_backlog_sync',
          syncJobId: job.id
        } 
      }
    );
    
    // Get board data from ISO+
    const boardResponse = await getBoard(authorization, workspaceId);
    if (boardResponse.status !== 200) {
      throw new Error('Failed to fetch board data from ISO+');
    }

    const board = boardResponse.board.find(b => b.id.toString() === boardId);
    if (!board) {
      throw new Error('Board not found in ISO+');
    }

    // Update board metadata
    await Board.findOneAndUpdate(
      { boardId },
      {
        $set: {
          name: board.name,
          color: board.color || '',
          description: board.description || '',
          og_image: board.og_image || ''
        }
      }
    );

    // Get all folders
    info('Sync-Worker', 'Fetching folders for board', { jobId: job.id, workspaceId, boardId });
    const foldersResponse = await getFolder(workspaceId, boardId);
    
    if (foldersResponse.status !== 200) {
      throw new Error('Failed to fetch folders from ISO+');
    }

    const folders = foldersResponse.folder || [];
    info('Sync-Worker', 'Found folders', { 
      jobId: job.id, 
      workspaceId, 
      boardId, 
      folderCount: folders.length 
    });

    let totalItemsSynced = 0;
    let totalItemsUpdated = 0;
    let totalItemsCreated = 0;

    // Process each folder
    for (const folder of folders) {
      try {
        // Update job progress
        await job.updateProgress({
          stage: 'syncing_folders',
          currentFolder: folder.name,
          foldersProcessed: folders.indexOf(folder) + 1,
          totalFolders: folders.length
        });

        info('Sync-Worker', 'Fetching items for folder', { 
          jobId: job.id,
          workspaceId, 
          boardId, 
          folderId: folder.id,
          folderName: folder.name 
        });

        const itemsResponse = await getItem(workspaceId, boardId, folder.id.toString());
        
        if (itemsResponse.status !== 200) {
          warn('Sync-Worker', 'Failed to fetch items for folder', { 
            jobId: job.id,
            workspaceId, 
            boardId, 
            folderId: folder.id 
          });
          continue;
        }

        const items = itemsResponse.item || [];
        info('Sync-Worker', 'Found items in folder', { 
          jobId: job.id,
          workspaceId, 
          boardId, 
          folderId: folder.id,
          itemCount: items.length 
        });

        // Save each item
        for (const item of items) {
          try {
            const result = await Item.findOneAndUpdate(
              { itemId: item.id.toString() },
              {
                $set: {
                  workspaceId: workspaceId,
                  boardId: boardId,
                  folderId: folder.id.toString(),
                  itemId: item.id.toString(),
                  data: item,
                  updatedAt: new Date()
                },
                $setOnInsert: {
                  createdAt: new Date()
                }
              },
              { upsert: true, new: true }
            );

            totalItemsSynced++;
            if (result.createdAt.getTime() === result.updatedAt.getTime()) {
              totalItemsCreated++;
            } else {
              totalItemsUpdated++;
            }
          } catch (itemErr) {
            error('Sync-Worker', 'Failed to save item', { 
              jobId: job.id,
              workspaceId, 
              boardId, 
              folderId: folder.id,
              itemId: item.id,
              error: itemErr.message 
            });
          }
        }
      } catch (folderErr) {
        error('Sync-Worker', 'Failed to process folder', { 
          jobId: job.id,
          workspaceId, 
          boardId, 
          folderId: folder.id,
          error: folderErr.message 
        });
      }
    }

    // Update board with success status and stats
    await Board.findOneAndUpdate(
      { boardId },
      {
        $set: {
          syncStatus: 'realtime_sync',
          lastSyncedAt: new Date(),
          lastSyncError: null,
          validationErrors: [],
          'syncStats.foldersProcessed': folders.length,
          'syncStats.itemsSynced': totalItemsSynced,
          'syncStats.itemsCreated': totalItemsCreated,
          'syncStats.itemsUpdated': totalItemsUpdated,
          'syncStats.lastBacklogSyncAt': new Date(),
          'syncStats.retryCount': 0
        }
      }
    );

    info('Sync-Worker', 'Data backlog sync completed successfully', { 
      jobId: job.id,
      workspaceId, 
      boardId,
      stats: {
        folders: folders.length,
        itemsSynced: totalItemsSynced,
        itemsCreated: totalItemsCreated,
        itemsUpdated: totalItemsUpdated
      }
    });

    // Register webhook hook for realtime updates after successful backlog sync
    info('Sync-Worker', 'Preparing to register hook for realtime sync', { 
      jobId: job.id,
      workspaceId, 
      boardId,
      authorization: authorization ? 'present' : 'missing'
    });

    try {
      if (!authorization) {
        error('Sync-Worker', 'Cannot register hook: authorization token missing', {
          jobId: job.id,
          workspaceId,
          boardId
        });
      } else {
        info('Sync-Worker', 'Calling registerBoardWebhooks', {
          jobId: job.id,
          workspaceId,
          boardId
        });

        const hookResult = await registerBoardWebhooks(authorization, workspaceId, boardId);
        
        info('Sync-Worker', 'Hook registration result received', {
          jobId: job.id,
          workspaceId,
          boardId,
          success: hookResult.success,
          hookId: hookResult.hookId,
          error: hookResult.error
        });

        if (hookResult.success) {
          await Board.findOneAndUpdate(
            { boardId },
            {
              $set: {
                hookId: hookResult.hookId || null,
                hookSecret: hookResult.secret || null
              }
            }
          );

          info('Sync-Worker', 'Hook registered and board updated successfully', { 
            jobId: job.id,
            workspaceId, 
            boardId,
            hookId: hookResult.hookId,
            events: hookResult.events
          });
        } else {
          error('Sync-Worker', 'Hook registration failed', { 
            jobId: job.id,
            workspaceId, 
            boardId,
            error: hookResult.error,
            errorDetails: hookResult.errorDetails
          });
        }
      }
    } catch (hookErr) {
      error('Sync-Worker', 'Exception during hook registration', { 
        jobId: job.id,
        workspaceId, 
        boardId,
        error: hookErr.message,
        stack: hookErr.stack
      });
    }

    return {
      success: true,
      nextStep: 'realtime_sync',
      stats: {
        foldersProcessed: folders.length,
        itemsSynced: totalItemsSynced,
        itemsCreated: totalItemsCreated,
        itemsUpdated: totalItemsUpdated
      }
    };

  } catch (err) {
    error('Sync-Worker', 'Data backlog sync failed', { 
      jobId: job.id,
      workspaceId, 
      boardId, 
      error: err.message,
      stack: err.stack
    });
    
    // Update board with failed status
    await Board.findOneAndUpdate(
      { boardId },
      {
        $set: {
          syncStatus: 'failed',
          lastSyncError: err.message,
          lastSyncedAt: new Date()
        },
        $inc: {
          'syncStats.retryCount': 1
        }
      }
    );
    
    throw err;
  }
}

/**
 * Process manual triggered sync
 * Similar to backlog sync but sets status back to realtime_sync after completion
 */
async function processManualTriggeredSync(job) {
  const { authorization, workspaceId, boardId } = job.data;
  
  info('Sync-Worker', 'Processing manual triggered sync', { jobId: job.id, workspaceId, boardId });
  
  try {
    // Update status
    await Board.findOneAndUpdate(
      { boardId },
      { 
        $set: { 
          syncStatus: 'manual_triggered_sync',
          syncJobId: job.id
        } 
      }
    );
    
    // Process the same way as backlog sync
    const result = await processDataBacklogSync(job);
    
    return result;
  } catch (err) {
    error('Sync-Worker', 'Manual triggered sync failed', { 
      jobId: job.id,
      workspaceId, 
      boardId, 
      error: err.message 
    });
    throw err;
  }
}

/**
 * Main job processor
 */
async function processJob(job) {
  const { jobType } = job.data;
  
  info('Sync-Worker', 'Processing job', { 
    jobId: job.id, 
    jobType,
    data: job.data 
  });
  
  try {
    let result;
    
    switch (jobType) {
      case 'board_validation':
        result = await processBoardValidation(job);
        break;
      case 'data_backlog_sync':
        result = await processDataBacklogSync(job);
        break;
      case 'manual_triggered_sync':
        result = await processManualTriggeredSync(job);
        break;
      default:
        throw new Error(`Unknown job type: ${jobType}`);
    }
    
    info('Sync-Worker', 'Job completed successfully', { 
      jobId: job.id, 
      jobType,
      result 
    });
    
    return result;
  } catch (err) {
    error('Sync-Worker', 'Job failed', { 
      jobId: job.id, 
      jobType,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

// Create worker
export const syncWorker = new Worker('board-sync', processJob, {
  connection: redisConnection,
  concurrency: 5, // Process up to 5 jobs concurrently
  limiter: {
    max: 10, // Max 10 jobs
    duration: 1000 // per second
  }
});

// Worker event handlers
syncWorker.on('completed', (job, result) => {
  info('Sync-Worker', 'Job completed', { 
    jobId: job.id, 
    jobType: job.data.jobType,
    result 
  });
});

syncWorker.on('failed', (job, err) => {
  error('Sync-Worker', 'Job failed', { 
    jobId: job?.id, 
    jobType: job?.data?.jobType,
    error: err.message,
    attemptsMade: job?.attemptsMade,
    attemptsTotal: job?.opts?.attempts
  });
});

syncWorker.on('error', (err) => {
  error('Sync-Worker', 'Worker error', { error: err.message });
});

info('Sync-Worker', 'Sync worker initialized and ready', {
  concurrency: 5,
  queueName: 'board-sync'
});

export default syncWorker;

