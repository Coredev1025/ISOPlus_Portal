import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { getBoard, iterateBoardItems } from '../services/isoplus.js';
import Board from '../models/Board.js';
import Item from '../models/Item.js';
import SyncExecution from '../models/SyncExecution.js';
import { validateBoard } from '../services/sync/validator.js';
import { registerBoardWebhooks, unregisterBoardWebhooks, getBoardHooks } from '../services/webhookService.js';
import { info, error, warn } from '../utils/logger.js';
import { syncQueue } from '../services/sync/queue.js';
import { invalidateCacheForBoard } from '../utils/transformCache.js';
import { transformItemData } from '../utils/itemTransform.js';

const SYNC_TIMEOUT_MS = 20 * 60 * 1000;
const BULK_BATCH_SIZE = 100;
const API_TIMEOUT_MS = 30 * 1000;
const MAX_RETRIES = 3;

// Redis connection configuration for ElastiCache
// Supports both regular Redis and Redis Cluster mode
const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = parseInt(process.env.REDIS_PORT) || 6379;
const useCluster = process.env.REDIS_CLUSTER === 'true';

let redisConnection;

if (useCluster) {
  // AWS ElastiCache Serverless uses Redis Cluster mode
  // Match the working sample configuration exactly
  redisConnection = new Redis.Cluster(
    [{ host: redisHost, port: redisPort }],
    {
      dnsLookup: (address, callback) => callback(null, address),
      redisOptions: {
        ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
        maxRetriesPerRequest: null, // Recommended for production
        tls: {}, // AWS ElastiCache Serverless requires TLS
        connectTimeout: 30000, // 30 seconds for cluster discovery
        retryStrategy: (times) => {
          const delay = Math.min(times * 100, 3000);
          return delay;
        },
      },
      clusterRetryStrategy: (times) => {
        const delay = Math.min(times * 100, 3000);
        info('Sync-Worker', 'Cluster retry', { times, delay });
        return delay;
      },
      enableOfflineQueue: false, // Disable offline queue for cluster
      maxRetriesPerRequest: null,
      lazyConnect: false, // Connect immediately
    }
  );
} else {
  // Regular Redis connection (for local development or non-cluster Redis)
  redisConnection = new Redis({
    host: redisHost,
    port: redisPort,
    ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
    maxRetriesPerRequest: null, // Recommended for production
    ...(process.env.REDIS_TLS === 'true' && {
      tls: {
        rejectUnauthorized: false
      }
    }),
  });
}

// Add connection event listeners for debugging
redisConnection.on('connect', () => {
  info('Sync-Worker', 'Redis connection established');
});

redisConnection.on('ready', () => {
  info('Sync-Worker', 'Redis connection ready');
});

redisConnection.on('error', (err) => {
  error('Sync-Worker', 'Redis connection error', { error: err.message, stack: err.stack });
});

redisConnection.on('close', () => {
  warn('Sync-Worker', 'Redis connection closed');
});

redisConnection.on('reconnecting', (delay) => {
  info('Sync-Worker', 'Redis reconnecting', { delay });
});

// Cluster-specific event listeners
if (useCluster) {
  redisConnection.on('+node', (node) => {
    info('Sync-Worker', 'Cluster node added', { node: node.options?.host || node.options?.address });
  });
  
  redisConnection.on('-node', (node) => {
    warn('Sync-Worker', 'Cluster node removed', { node: node.options?.host || node.options?.address });
  });
  
  redisConnection.on('node error', (err, node) => {
    error('Sync-Worker', 'Cluster node error', { 
      error: err.message, 
      node: node?.options?.host || node?.options?.address 
    });
  });
  
  redisConnection.on('refresh', () => {
    info('Sync-Worker', 'Cluster slots refreshed');
  });
}

function generateSyncGUID() {
  return uuidv4();
}

async function waitWithBackoff(retryCount) {
  const delay = Math.min(1000 * Math.pow(2, retryCount), 30000); // Max 30 seconds
  await new Promise(resolve => setTimeout(resolve, delay));
}

async function disableWebhooksForBoard(authorization, workspaceId, boardId) {
  try {
    if (!authorization) {
      warn('Sync-Worker', 'Cannot disable webhooks: no authorization token', { boardId });
      return;
    }

    // First, get all hooks from the API to ensure we delete all of them
    const hooksResult = await getBoardHooks(authorization, workspaceId, boardId);
    
    if (hooksResult.success && hooksResult.hooks && hooksResult.hooks.length > 0) {
      info('Sync-Worker', 'Found hooks to delete before sync', { 
        boardId, 
        hookCount: hooksResult.hooks.length 
      });

      // Delete all hooks from API
      for (const hook of hooksResult.hooks) {
        if (hook.id) {
          try {
            await unregisterBoardWebhooks(authorization, workspaceId, boardId, hook.id);
            info('Sync-Worker', 'Deleted hook before sync', { 
              boardId, 
              hookId: hook.id 
            });
          } catch (hookErr) {
            warn('Sync-Worker', 'Failed to delete hook', { 
              boardId, 
              hookId: hook.id,
              error: hookErr.message 
            });
          }
        }
      }
    }

    // Also check database for hookId and delete it
    const board = await Board.findOne({ boardId }).select('hookId').lean();
    if (board?.hookId) {
      info('Sync-Worker', 'Deleting hook from database record', { 
        boardId, 
        hookId: board.hookId 
      });
      
      // Try to delete the hook from API (in case it wasn't in the list)
      try {
        await unregisterBoardWebhooks(authorization, workspaceId, boardId, board.hookId);
      } catch (hookErr) {
        // Ignore errors - hook might already be deleted
        warn('Sync-Worker', 'Hook from database not found in API (may already be deleted)', { 
          boardId, 
          hookId: board.hookId 
        });
      }
      
      // Clear hook from database
      await Board.findOneAndUpdate(
        { boardId },
        { $set: { hookId: null, hookSecret: null } }
      );
    }

    info('Sync-Worker', 'Webhooks disabled successfully', { boardId });

  } catch (err) {
    warn('Sync-Worker', 'Failed to disable webhooks', { boardId, error: err.message });
  }
}

async function reEnableWebhooksForBoard(authorization, workspaceId, boardId) {
  try {
    if (!authorization) {
      warn('Sync-Worker', 'Cannot re-enable webhooks: no authorization token', { boardId });
      return;
    }
    
    info('Sync-Worker', 'Re-enabling webhooks after sync', { boardId });
    
    try {
      const hooksResult = await getBoardHooks(authorization, workspaceId, boardId);
      
      if (hooksResult.success && hooksResult.hooks && hooksResult.hooks.length > 0) {
        info('Sync-Worker', 'Cleaning up existing hooks before re-enabling', { 
          boardId, 
          hookCount: hooksResult.hooks.length 
        });
        
        for (const hook of hooksResult.hooks) {
          if (hook.id) {
            try {
              await unregisterBoardWebhooks(authorization, workspaceId, boardId, hook.id);
            } catch (hookErr) {
              warn('Sync-Worker', 'Failed to delete existing hook during re-enable', { 
                boardId, 
                hookId: hook.id,
                error: hookErr.message 
              });
            }
          }
        }
      }
    } catch (cleanupErr) {
      warn('Sync-Worker', 'Error during hook cleanup before re-enable', { 
        boardId, 
        error: cleanupErr.message 
      });
      // Continue with registration anyway
    }
    
    const hookResult = await registerBoardWebhooks(authorization, workspaceId, boardId);
    
    if (hookResult.success) {
      await Board.findOneAndUpdate(
        { boardId },
        { $set: { hookId: hookResult.hookId, hookSecret: hookResult.secret } }
      );
      info('Sync-Worker', 'Webhooks re-enabled successfully', { 
        boardId, 
        hookId: hookResult.hookId 
      });
    } else {
      error('Sync-Worker', 'Failed to re-enable webhooks', { 
        boardId, 
        error: hookResult.error,
        errorDetails: hookResult.errorDetails 
      });
    }
  } catch (err) {
    error('Sync-Worker', 'Exception re-enabling webhooks', { 
      boardId, 
      error: err.message,
      stack: err.stack 
    });
  }
}

function checkSyncTimeout(startTime) {
  return Date.now() - startTime > SYNC_TIMEOUT_MS;
}

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
  const startTime = Date.now();
  const syncGUID = generateSyncGUID();
  
  info('Sync-Worker', 'Starting data backlog sync', { 
    jobId: job.id, 
    workspaceId, 
    boardId,
    syncGUID 
  });
  
  let syncExecution;
  try {
    syncExecution = await SyncExecution.createSyncExecution({
      syncGUID,
      boardId,
      workspaceId,
      syncType: job.data.jobType || 'data_backlog_sync',
      triggeredBy: job.data.triggeredBy || 'system',
      jobId: job.id
    });
    
    info('Sync-Worker', 'Sync execution record created', { 
      jobId: job.id, 
      syncGUID,
      syncExecutionId: syncExecution._id 
    });
  } catch (err) {
    warn('Sync-Worker', 'Failed to create sync execution record', { 
      jobId: job.id, 
      error: err.message 
    });
  }
  
  try {
    // Step 1: Check timeout
    if (checkSyncTimeout(startTime)) {
      throw new Error('SYNC_TIMEOUT');
    }
    
    // Step 2: Disable webhooks for the board
    await disableWebhooksForBoard(authorization, workspaceId, boardId);
    
    // Step 3: Update status based on job type (preserve manual_triggered_sync)
    const syncStatus = job.data.jobType || 'data_backlog_sync';
    await Board.findOneAndUpdate(
      { boardId },
      { 
        $set: { 
          syncStatus: syncStatus,
          syncJobId: job.id,
          currentSyncGUID: syncGUID
        } 
      }
    );
    
    // Update sync execution status to in-progress
    if (syncExecution) {
      await SyncExecution.updateProgress(syncGUID, {}, {});
    }
    
    // Step 4: Get board data from ISO+
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

    // Step 5: Fetch board items directly without folder filtering
    info('Sync-Worker', 'Fetching board items without folder filter', {
      jobId: job.id,
      workspaceId,
      boardId
    });

    // Initialize counters
    let totalItemsProcessed = 0;
    let totalItemsInserted = 0;
    let totalItemsUpdated = 0;
    let pageNumber = 0;
    let bulkOps = [];
    const uniqueFolderIds = new Set();
    let retryCount = 0;
    const itemIterator = iterateBoardItems(workspaceId, boardId);

    // Step 6: Process all board items page by page
    while (true) {
      try {
        // Check timeout before each page
        if (checkSyncTimeout(startTime)) {
          throw new Error('SYNC_TIMEOUT');
        }

        const { value: itemsPage, done } = await itemIterator.next();

        if (done) {
          break;
        }

        pageNumber++;
        retryCount = 0;

        info('Sync-Worker', 'Processing board items page', {
          jobId: job.id,
          workspaceId,
          boardId,
          pageNumber,
          pageSize: itemsPage.length
        });

        // Step 7: Build bulk operations for this page with transformed data
        for (const item of itemsPage) {
          const itemIdStr = item.id.toString();
          const itemFolderId = item.folder_id ? item.folder_id.toString() : '';

          if (itemFolderId) {
            uniqueFolderIds.add(itemFolderId);
          }

          // Transform the item data to flat format
          const transformedData = transformItemData(item);

          bulkOps.push({
            updateOne: {
              filter: { itemId: itemIdStr },
              update: {
                $set: {
                  workspaceId: workspaceId,
                  boardId: boardId,
                  folderId: itemFolderId,
                  itemId: itemIdStr,
                  isoPlusItemId: itemIdStr,
                  syncGUID: syncGUID,
                  data: transformedData,
                  updatedAt: new Date()
                },
                $setOnInsert: {
                  createdAt: new Date()
                }
              },
              upsert: true
            }
          });
        }

        totalItemsProcessed += itemsPage.length;

        // Step 8: Execute bulk write when batch size is reached (100)
        if (bulkOps.length >= BULK_BATCH_SIZE) {
          try {
            const bulkResult = await Item.bulkWrite(bulkOps, {
              ordered: false,
              wtimeout: 10000
            });

            totalItemsInserted += bulkResult.upsertedCount || 0;
            totalItemsUpdated += bulkResult.modifiedCount || 0;

            info('Sync-Worker', 'Bulk write completed', {
              jobId: job.id,
              syncGUID,
              batchSize: bulkOps.length,
              upserted: bulkResult.upsertedCount,
              modified: bulkResult.modifiedCount
            });

            await job.updateProgress({
              stage: 'syncing_items',
              currentPage: pageNumber,
              itemsProcessed: totalItemsProcessed,
              syncGUID
            });

            // Update sync execution progress
            if (syncExecution) {
              await SyncExecution.updateProgress(syncGUID, {
                currentPage: pageNumber
              }, {
                itemsProcessed: totalItemsProcessed,
                itemsInserted: totalItemsInserted,
                itemsUpdated: totalItemsUpdated
              });
            }

            // Clear the bulk operations array
            bulkOps = [];

            // Small delay to prevent memory buildup
            await new Promise(resolve => setTimeout(resolve, 50));
          } catch (bulkErr) {
            error('Sync-Worker', 'Bulk write failed', {
              jobId: job.id,
              syncGUID,
              batchSize: bulkOps.length,
              error: bulkErr.message
            });

            // Clear failed batch to continue with next batch
            bulkOps = [];
          }
        }
      } catch (pageErr) {
        if (pageErr.message === 'SYNC_TIMEOUT') {
          throw pageErr;
        }

        retryCount++;
        if (retryCount < MAX_RETRIES) {
          warn('Sync-Worker', 'Page fetch failed, retrying', {
            jobId: job.id,
            retryCount,
            error: pageErr.message
          });
          await waitWithBackoff(retryCount);
          continue;
        }

        error('Sync-Worker', 'Page fetch failed after max retries', {
          jobId: job.id,
          error: pageErr.message
        });
        throw pageErr;
      }
    }

    // Execute any remaining bulk operations
    if (bulkOps.length > 0) {
      try {
        const bulkResult = await Item.bulkWrite(bulkOps, {
          ordered: false,
          wtimeout: 10000
        });

        totalItemsInserted += bulkResult.upsertedCount || 0;
        totalItemsUpdated += bulkResult.modifiedCount || 0;

        info('Sync-Worker', 'Final bulk write completed', {
          jobId: job.id,
          syncGUID,
          batchSize: bulkOps.length,
          upserted: bulkResult.upsertedCount,
          modified: bulkResult.modifiedCount
        });

        await job.updateProgress({
          stage: 'syncing_items',
          currentPage: pageNumber,
          itemsProcessed: totalItemsProcessed,
          syncGUID
        });

        bulkOps = [];
      } catch (bulkErr) {
        error('Sync-Worker', 'Final bulk write failed', {
          jobId: job.id,
          syncGUID,
          error: bulkErr.message
        });
        bulkOps = [];
      }
    }
    
    info('Sync-Worker', 'Board item processing completed', {
      jobId: job.id,
      boardId,
      pageCount: pageNumber,
      itemsProcessed: totalItemsProcessed
    });
    
    // Step 9: Delete old records (items not in current sync)
    info('Sync-Worker', 'Deleting old records not in current sync', {
      jobId: job.id,
      syncGUID,
      boardId
    });
    
    let deletedCount = 0;
    try {
      const deleteResult = await Item.deleteMany({
        boardId: boardId,
        syncGUID: { $ne: syncGUID }
      });
      deletedCount = deleteResult.deletedCount || 0;
      
      info('Sync-Worker', 'Old records deleted', {
        jobId: job.id,
        syncGUID,
        deletedCount
      });
    } catch (deleteErr) {
      warn('Sync-Worker', 'Failed to delete old records', {
        jobId: job.id,
        syncGUID,
        error: deleteErr.message
      });
    }
    
    // Step 10: Update board with success status and stats
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    await Board.findOneAndUpdate(
      { boardId },
      {
        $set: {
          syncStatus: 'realtime_sync',
          lastSyncedAt: new Date(),
          lastSyncError: null,
          validationErrors: [],
          currentSyncGUID: syncGUID,
          'syncStats.foldersProcessed': uniqueFolderIds.size,
          'syncStats.itemsSynced': totalItemsProcessed,
          'syncStats.itemsCreated': totalItemsInserted,
          'syncStats.itemsUpdated': totalItemsUpdated,
          'syncStats.itemsDeleted': deletedCount,
          'syncStats.lastBacklogSyncAt': new Date(),
          'syncStats.syncDuration': duration,
          'syncStats.retryCount': 0
        }
      }
    );

    // Update sync execution as completed
    if (syncExecution) {
      await SyncExecution.markCompleted(syncGUID, {
        itemsProcessed: totalItemsProcessed,
        itemsInserted: totalItemsInserted,
        itemsUpdated: totalItemsUpdated,
        itemsDeleted: deletedCount
      });
    }

    // Invalidate transformation cache for the board
    invalidateCacheForBoard(workspaceId, boardId);
    info('Sync-Worker', 'Invalidated transformation cache for board', {
      jobId: job.id,
      workspaceId,
      boardId
    });

    info('Sync-Worker', 'Data backlog sync completed successfully', { 
      jobId: job.id,
      workspaceId, 
      boardId,
      syncGUID,
      duration,
      stats: {
        folders: uniqueFolderIds.size,
        itemsProcessed: totalItemsProcessed,
        itemsInserted: totalItemsInserted,
        itemsUpdated: totalItemsUpdated,
        itemsDeleted: deletedCount
      }
    });

    // Step 11: Re-enable webhooks
    await reEnableWebhooksForBoard(authorization, workspaceId, boardId);

    return {
      success: true,
      nextStep: 'realtime_sync',
      syncGUID,
      stats: {
        foldersProcessed: uniqueFolderIds.size,
        itemsProcessed: totalItemsProcessed,
        itemsInserted: totalItemsInserted,
        itemsUpdated: totalItemsUpdated,
        itemsDeleted: deletedCount,
        duration
      }
    };

  } catch (err) {
    const isTimeout = err.message === 'SYNC_TIMEOUT';
    
    error('Sync-Worker', isTimeout ? 'Data backlog sync timed out' : 'Data backlog sync failed', { 
      jobId: job.id,
      workspaceId, 
      boardId,
      syncGUID,
      error: err.message,
      stack: err.stack
    });
    
    // Update sync execution as failed/timeout
    if (syncExecution) {
      if (isTimeout) {
        await SyncExecution.markTimeout(syncGUID);
      } else {
        await SyncExecution.markFailed(syncGUID, {
          message: err.message,
          stack: err.stack
        });
      }
    }
    
    // Update board with failed status
    await Board.findOneAndUpdate(
      { boardId },
      {
        $set: {
          syncStatus: 'failed',
          lastSyncError: isTimeout ? 'Sync timed out after 20 minutes' : err.message,
          lastSyncedAt: isTimeout ? null : new Date()
        },
        $inc: {
          'syncStats.retryCount': 1
        }
      }
    );
    
    // Re-enable webhooks even on failure
    await reEnableWebhooksForBoard(authorization, workspaceId, boardId);
    
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
    
    // Note: We no longer delete all items before manual sync
    // Instead, the backlog sync will update existing items and delete old ones using syncGUID
    
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
 * Check and retry failed jobs if no active/waiting jobs exist
 * Maximum 3 retries per job
 */
async function checkAndRetryFailedJobs() {
  try {
    // Get queue counts
    const [waiting, active, failed] = await Promise.all([
      syncQueue.getWaitingCount(),
      syncQueue.getActiveCount(),
      syncQueue.getFailedCount()
    ]);

    info('Sync-Worker', 'Checking queue status for retry', {
      waiting,
      active,
      failed
    });

    // Only retry if there are no waiting or active jobs, and there are failed jobs
    if (waiting === 0 && active === 0 && failed > 0) {
      info('Sync-Worker', 'No active/waiting jobs, checking failed jobs for retry', {
        failedCount: failed
      });

      // Get failed jobs (limit to reasonable number to avoid memory issues)
      const failedJobs = await syncQueue.getFailed(0, Math.min(failed, 100));
      
      let retriedCount = 0;
      let skippedCount = 0;

      for (const failedJob of failedJobs) {
        try {
          // Get retry count from job data (tracked separately from BullMQ attempts)
          const retryCount = failedJob.data?.retryCount || 0;

          // Skip if already manually retried 3 times (BullMQ attempts are separate)
          if (retryCount >= 3) {
            skippedCount++;
            warn('Sync-Worker', 'Skipping retry - max retries reached', {
              jobId: failedJob.id,
              retryCount,
              jobType: failedJob.data?.jobType
            });
            continue;
          }

          // Determine job name based on jobType
          const jobType = failedJob.data?.jobType;
          let jobName = 'retry';
          if (jobType === 'board_validation') {
            jobName = 'board_validation';
          } else if (jobType === 'data_backlog_sync') {
            jobName = 'backlog_sync';
          } else if (jobType === 'manual_triggered_sync') {
            jobName = 'manual_sync';
          } else if (failedJob.name) {
            jobName = failedJob.name;
          }

          // Retry the job with updated retry count
          const jobData = {
            ...failedJob.data,
            retryCount: retryCount + 1
          };

          // Remove the failed job and add it back to the queue
          await failedJob.remove();
          
          const retryJob = await syncQueue.add(
            jobName,
            jobData,
            {
              jobId: `${failedJob.id}-retry-${Date.now()}`,
              priority: failedJob.opts?.priority || 0,
              attempts: 1, // Single attempt per retry
              backoff: {
                type: 'exponential',
                delay: 5000
              }
            }
          );

          retriedCount++;
          info('Sync-Worker', 'Retrying failed job', {
            originalJobId: failedJob.id,
            retryJobId: retryJob.id,
            retryCount: retryCount + 1,
            jobType: jobType,
            jobName: jobName
          });
        } catch (retryErr) {
          error('Sync-Worker', 'Failed to retry job', {
            jobId: failedJob.id,
            error: retryErr.message,
            stack: retryErr.stack
          });
        }
      }

      info('Sync-Worker', 'Failed jobs retry check completed', {
        retried: retriedCount,
        skipped: skippedCount,
        totalFailed: failedJobs.length
      });
    }
  } catch (err) {
    error('Sync-Worker', 'Error checking and retrying failed jobs', {
      error: err.message,
      stack: err.stack
    });
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
// For Redis Cluster, use hash tags to ensure all keys are in the same hash slot
// Must match the queue name used in queue.js
const queueName = useCluster ? '{board-sync}' : 'board-sync';
export const syncWorker = new Worker(queueName, processJob, {
  connection: redisConnection,
  concurrency: 2,
  limiter: {
    max: 10, // Max 10 jobs
    duration: 1000 // per second
  }
});

// Worker event handlers
syncWorker.on('completed', async (job, result) => {
  info('Sync-Worker', 'Job completed', { 
    jobId: job.id, 
    jobType: job.data.jobType,
    result 
  });
  
  // Check and retry failed jobs if no active/waiting jobs
  await checkAndRetryFailedJobs();
});

syncWorker.on('failed', async (job, err) => {
  error('Sync-Worker', 'Job failed', { 
    jobId: job?.id, 
    jobType: job?.data?.jobType,
    error: err.message,
    attemptsMade: job?.attemptsMade,
    attemptsTotal: job?.opts?.attempts
  });
  
  // Check and retry failed jobs if no active/waiting jobs
  await checkAndRetryFailedJobs();
});

syncWorker.on('error', (err) => {
  error('Sync-Worker', 'Worker error', { error: err.message });
});

info('Sync-Worker', 'Sync worker initialized and ready', {
  concurrency: 2,
  queueName: queueName
});

// Export the retry function for use on server startup
export { checkAndRetryFailedJobs };

// Check and retry failed jobs when worker is ready
// This handles cases where worker restarts but server is still running
syncWorker.on('ready', async () => {
  info('Sync-Worker', 'Worker ready, checking for failed jobs to retry');
  // Add a small delay to ensure queue is fully initialized
  setTimeout(async () => {
    await checkAndRetryFailedJobs();
  }, 2000);
});

export default syncWorker;
