import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { getBoard, getFolder, getItem, iterateBoardItems } from '../services/isoplus.js';
import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { validateBoard } from '../services/sync/validator.js';
import { registerBoardWebhooks } from '../services/webhookService.js';
import { info, error, warn } from '../utils/logger.js';
import { syncQueue } from '../services/sync/queue.js';
import { invalidateCacheForBoard } from '../utils/transformCache.js';

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
    
    // Bulk write configuration
    const BULK_BATCH_SIZE = 20;

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

        let folderItemsProcessed = 0;
        let pageIndex = 0;
        let bulkOps = [];
        
        try {
          const itemIterator = iterateBoardItems(workspaceId, boardId, folder.id.toString());
          while (true) {
            const { value: itemsPage, done } = await itemIterator.next();
            if (done) {
              break;
            }
            pageIndex += 1;

            info('Sync-Worker', 'Processing items page for folder', {
              jobId: job.id,
              workspaceId,
              boardId,
              folderId: folder.id,
              pageIndex,
              pageSize: itemsPage.length,
              itemsProcessed: folderItemsProcessed + itemsPage.length
            });

            // Build bulk operations for this page
            for (const item of itemsPage) {
              const itemIdStr = item.id.toString();
              
              bulkOps.push({
                updateOne: {
                  filter: { itemId: itemIdStr },
                  update: {
                    $set: {
                      workspaceId: workspaceId,
                      boardId: boardId,
                      folderId: folder.id.toString(),
                      itemId: itemIdStr,
                      isoPlusItemId: itemIdStr,
                      data: item,
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
            
            folderItemsProcessed += itemsPage.length;
            
            // Execute bulk write when batch size is reached
            if (bulkOps.length >= BULK_BATCH_SIZE) {
              try {
                const bulkResult = await Item.bulkWrite(bulkOps, { ordered: false });
                
                totalItemsSynced += bulkOps.length;
                totalItemsCreated += bulkResult.upsertedCount || 0;
                totalItemsUpdated += bulkResult.modifiedCount || 0;
                
                info('Sync-Worker', 'Bulk write completed', {
                  jobId: job.id,
                  workspaceId,
                  boardId,
                  folderId: folder.id,
                  batchSize: bulkOps.length,
                  upserted: bulkResult.upsertedCount,
                  modified: bulkResult.modifiedCount,
                  matched: bulkResult.matchedCount
                });
                
                // Clear the bulk operations array
                bulkOps = [];
                
                // Small delay to prevent memory buildup
                await new Promise(resolve => setTimeout(resolve, 50));
              } catch (bulkErr) {
                error('Sync-Worker', 'Bulk write failed', {
                  jobId: job.id,
                  workspaceId,
                  boardId,
                  folderId: folder.id,
                  batchSize: bulkOps.length,
                  error: bulkErr.message
                });
                
                // Clear failed batch to continue with next batch
                bulkOps = [];
              }
            }
          }
          
          // Execute any remaining bulk operations for this folder
          if (bulkOps.length > 0) {
            try {
              const bulkResult = await Item.bulkWrite(bulkOps, { ordered: false });
              
              totalItemsSynced += bulkOps.length;
              totalItemsCreated += bulkResult.upsertedCount || 0;
              totalItemsUpdated += bulkResult.modifiedCount || 0;
              
              info('Sync-Worker', 'Final bulk write completed for folder', {
                jobId: job.id,
                workspaceId,
                boardId,
                folderId: folder.id,
                batchSize: bulkOps.length,
                upserted: bulkResult.upsertedCount,
                modified: bulkResult.modifiedCount,
                matched: bulkResult.matchedCount
              });
              
              bulkOps = [];
            } catch (bulkErr) {
              error('Sync-Worker', 'Final bulk write failed for folder', {
                jobId: job.id,
                workspaceId,
                boardId,
                folderId: folder.id,
                batchSize: bulkOps.length,
                error: bulkErr.message
              });
            }
          }
        } catch (itemsErr) {
          warn('Sync-Worker', 'Failed to fetch items for folder', {
            jobId: job.id,
            workspaceId,
            boardId,
            folderId: folder.id,
            error: itemsErr.message
          });
          continue;
        }

        if (folderItemsProcessed === 0) {
          info('Sync-Worker', 'No items found for folder', {
            jobId: job.id,
            workspaceId,
            boardId,
            folderId: folder.id
          });
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

    // Invalidate transformation cache for the board since items were synced/updated
    // This ensures fresh data is used for CSV export, PDF and Xero invoice generation
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
    
    // Delete all items for this board before manual sync
    info('Sync-Worker', 'Deleting all items before manual sync', { jobId: job.id, workspaceId, boardId });
    const deleteResult = await Item.deleteMany({ workspaceId, boardId });
    info('Sync-Worker', 'Items deleted before manual sync', { 
      jobId: job.id, 
      workspaceId, 
      boardId,
      deletedCount: deleteResult.deletedCount 
    });
    
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

