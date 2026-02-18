import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { 
  enableBoardSync, 
  disableBoardSync, 
  triggerManualSync,
  retrySyncAfterFailure,
  cancelBoardSync,
  enableWorkspaceSync,
  getBoardSyncStatus 
} from '../services/sync.js';
import Board from '../models/Board.js';
import { info, error, extractContextFromReq } from '../utils/logger.js';
import { syncQueue } from '../services/sync/queue.js';

const router = express.Router();

router.post('/board/enable', authenticateToken, async (req, res) => {
  try {
    const { workspaceId, boardId } = req.body;
    
    // Enhanced validation to handle edge cases
    const isValidWorkspaceId = workspaceId && 
      typeof workspaceId === 'string' && 
      workspaceId.trim() !== '' && 
      workspaceId !== 'undefined' && 
      workspaceId !== 'null';
    
    const isValidBoardId = boardId && 
      typeof boardId === 'string' && 
      boardId.trim() !== '' && 
      boardId !== 'undefined' && 
      boardId !== 'null';
    
    if (!isValidWorkspaceId || !isValidBoardId) {
      const context = extractContextFromReq(req);
      error('Sync-Route', 'Invalid request parameters for board sync enable', { 
        workspaceId: workspaceId || 'missing',
        boardId: boardId || 'missing',
        workspaceIdType: typeof workspaceId,
        boardIdType: typeof boardId
      }, context);
      
      return res.status(400).json({ 
        message: 'workspaceId and boardId are required and must be valid non-empty strings',
        received: {
          workspaceId: workspaceId || null,
          boardId: boardId || null
        }
      });
    }

    const result = await enableBoardSync(req.session.Authorization, workspaceId.trim(), boardId.trim());
    
    info('Sync-Route', 'Board sync enable requested', { 
      workspaceId, 
      boardId,
      success: result.success
    }, extractContextFromReq(req));
    
    const statusCode = result.success ? 202 : 409; // 202 Accepted, 409 Conflict
    res.status(statusCode).json(result);
  } catch (err) {
    error('Sync-Route', 'Failed to enable board sync', { err }, req);
    
    // Return appropriate status code based on error type
    if (err.message === 'Board not found' || err.message.includes('Board not found')) {
      return res.status(404).json({ 
        message: 'Board not found',
        error: err.message 
      });
    }
    
    res.status(500).json({ 
      message: 'Failed to enable sync', 
      error: err.message 
    });
  }
});

router.post('/board/disable', authenticateToken, async (req, res) => {
  try {
    const { boardId } = req.body;
    
    if (!boardId) {
      return res.status(400).json({ 
        message: 'boardId is required' 
      });
    }

    const result = await disableBoardSync(boardId, req.session.Authorization);
    
    info('Sync-Route', 'Board sync disabled', { 
      boardId
    }, extractContextFromReq(req));
    
    res.status(200).json(result);
  } catch (err) {
    error('Sync-Route', 'Failed to disable board sync', { err }, req);
    res.status(500).json({ 
      message: 'Failed to disable sync', 
      error: err.message 
    });
  }
});

router.post('/board/manual', authenticateToken, async (req, res) => {
  try {
    const { workspaceId, boardId } = req.body;
    
    // Enhanced validation to handle edge cases
    const isValidWorkspaceId = workspaceId && 
      typeof workspaceId === 'string' && 
      workspaceId.trim() !== '' && 
      workspaceId !== 'undefined' && 
      workspaceId !== 'null';
    
    const isValidBoardId = boardId && 
      typeof boardId === 'string' && 
      boardId.trim() !== '' && 
      boardId !== 'undefined' && 
      boardId !== 'null';
    
    if (!isValidWorkspaceId || !isValidBoardId) {
      const context = extractContextFromReq(req);
      error('Sync-Route', 'Invalid request parameters for manual sync', { 
        workspaceId: workspaceId || 'missing',
        boardId: boardId || 'missing',
        workspaceIdType: typeof workspaceId,
        boardIdType: typeof boardId
      }, context);
      
      return res.status(400).json({ 
        message: 'workspaceId and boardId are required and must be valid non-empty strings',
        received: {
          workspaceId: workspaceId || null,
          boardId: boardId || null
        }
      });
    }

    const result = await triggerManualSync(req.session.Authorization, workspaceId.trim(), boardId.trim());
    
    info('Sync-Route', 'Manual sync triggered', { 
      workspaceId, 
      boardId,
      success: result.success
    }, extractContextFromReq(req));
    
    const statusCode = result.success ? 202 : 409;
    res.status(statusCode).json(result);
  } catch (err) {
    error('Sync-Route', 'Failed to trigger manual sync', { err }, req);
    
    // Return appropriate status code based on error type
    if (err.message === 'Board not found' || err.message.includes('Board not found')) {
      return res.status(404).json({ 
        message: 'Board not found',
        error: err.message 
      });
    }
    
    res.status(500).json({ 
      message: 'Failed to trigger manual sync', 
      error: err.message 
    });
  }
});

router.post('/board/retry', authenticateToken, async (req, res) => {
  try {
    const { workspaceId, boardId } = req.body;
    
    // Enhanced validation to handle edge cases
    const isValidWorkspaceId = workspaceId && 
      typeof workspaceId === 'string' && 
      workspaceId.trim() !== '' && 
      workspaceId !== 'undefined' && 
      workspaceId !== 'null';
    
    const isValidBoardId = boardId && 
      typeof boardId === 'string' && 
      boardId.trim() !== '' && 
      boardId !== 'undefined' && 
      boardId !== 'null';
    
    if (!isValidWorkspaceId || !isValidBoardId) {
      const context = extractContextFromReq(req);
      error('Sync-Route', 'Invalid request parameters for sync retry', { 
        workspaceId: workspaceId || 'missing',
        boardId: boardId || 'missing',
        workspaceIdType: typeof workspaceId,
        boardIdType: typeof boardId
      }, context);
      
      return res.status(400).json({ 
        message: 'workspaceId and boardId are required and must be valid non-empty strings',
        received: {
          workspaceId: workspaceId || null,
          boardId: boardId || null
        }
      });
    }

    const result = await retrySyncAfterFailure(req.session.Authorization, workspaceId.trim(), boardId.trim());
    
    info('Sync-Route', 'Sync retry triggered', { 
      workspaceId, 
      boardId,
      success: result.success,
      retryCount: result.retryCount
    }, extractContextFromReq(req));
    
    const statusCode = result.success ? 202 : 409;
    res.status(statusCode).json(result);
  } catch (err) {
    error('Sync-Route', 'Failed to retry sync', { err }, req);
    
    // Return appropriate status code based on error type
    if (err.message === 'Board not found' || err.message.includes('Board not found')) {
      return res.status(404).json({ 
        message: 'Board not found',
        error: err.message 
      });
    }
    
    res.status(500).json({ 
      message: 'Failed to retry sync', 
      error: err.message 
    });
  }
});

router.post('/board/cancel', authenticateToken, async (req, res) => {
  try {
    const { boardId } = req.body;
    
    if (!boardId) {
      return res.status(400).json({ 
        message: 'boardId is required' 
      });
    }

    const result = await cancelBoardSync(boardId, req.session.Authorization);
    
    info('Sync-Route', 'Sync cancelled', { 
      boardId
    }, extractContextFromReq(req));
    
    res.status(200).json(result);
  } catch (err) {
    error('Sync-Route', 'Failed to cancel sync', { err }, req);
    res.status(500).json({ 
      message: 'Failed to cancel sync', 
      error: err.message 
    });
  }
});

router.post('/workspace/enable', authenticateToken, async (req, res) => {
  try {
    const { workspaceId } = req.body;
    
    if (!workspaceId) {
      return res.status(400).json({ 
        message: 'workspaceId is required' 
      });
    }

    const result = await enableWorkspaceSync(req.session.Authorization, workspaceId);
    
    info('Sync-Route', 'Workspace sync enable requested', { 
      workspaceId,
      enabledBoards: result.enabledBoards
    }, extractContextFromReq(req));
    
    res.status(202).json(result);
  } catch (err) {
    error('Sync-Route', 'Failed to enable workspace sync', { err }, req);
    res.status(500).json({ 
      message: 'Failed to enable workspace sync', 
      error: err.message 
    });
  }
});

router.get('/board/status/:boardId', authenticateToken, async (req, res) => {
  try {
    const { boardId } = req.params;
    
    if (!boardId) {
      return res.status(400).json({ 
        message: 'boardId is required' 
      });
    }

    const status = await getBoardSyncStatus(boardId);
    
    res.status(200).json(status);
  } catch (err) {
    if (err.message === 'Board not found') {
      return res.status(404).json({ 
        message: 'Board not found' 
      });
    }
    
    error('Sync-Route', 'Failed to get board sync status', { err, boardId: req.params.boardId }, req);
    res.status(500).json({ 
      message: 'Failed to get sync status', 
      error: err.message 
    });
  }
});

router.get('/workspace/status/:workspaceId', authenticateToken, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    
    if (!workspaceId) {
      return res.status(400).json({ 
        message: 'workspaceId is required' 
      });
    }

    const boards = await Board.find({ workspaceId, syncData: true })
      .select('boardId')
      .lean();
    
    const boardsStatus = await Promise.all(
      boards.map(async (board) => {
        try {
          return await getBoardSyncStatus(board.boardId);
        } catch (err) {
          error('Sync-Route', 'Failed to get status for board', { err, boardId: board.boardId }, req);
          return {
            boardId: board.boardId,
            boardName: board.name,
            error: err.message
          };
        }
      })
    );

    res.status(200).json({
      workspaceId,
      totalBoards: boards.length,
      boards: boardsStatus
    });
  } catch (err) {
    error('Sync-Route', 'Failed to get workspace sync status', { err, workspaceId: req.params.workspaceId }, req);
    res.status(500).json({ 
      message: 'Failed to get sync status', 
      error: err.message 
    });
  }
});

/**
 * Get queue analysis and statistics
 * Returns comprehensive queue metrics and job statistics
 */
router.get('/queue/analysis', authenticateToken, async (req, res) => {
  try {
    // Get queue counts
    const waiting = await syncQueue.getWaitingCount();
    const active = await syncQueue.getActiveCount();
    const completed = await syncQueue.getCompletedCount();
    const failed = await syncQueue.getFailedCount();
    const delayed = await syncQueue.getDelayedCount();
    const paused = await syncQueue.getPausedCount();

    // Get recent jobs (last 50)
    const [waitingJobs, activeJobs, completedJobs, failedJobs, delayedJobs] = await Promise.all([
      syncQueue.getWaiting(0, 50),
      syncQueue.getActive(0, 50),
      syncQueue.getCompleted(0, 50),
      syncQueue.getFailed(0, 50),
      syncQueue.getDelayed(0, 50),
    ]);

    // Process jobs to extract relevant information
    const processJobs = async (jobs) => {
      return Promise.all(
        jobs.map(async (job) => {
          const state = await job.getState();
          return {
            id: job.id,
            name: job.name,
            data: job.data,
            state,
            progress: job.progress,
            attemptsMade: job.attemptsMade,
            timestamp: job.timestamp,
            processedOn: job.processedOn,
            finishedOn: job.finishedOn,
            failedReason: job.failedReason,
            delay: job.opts?.delay || 0,
            priority: job.opts?.priority || 0,
          };
        })
      );
    };

    const [processedWaiting, processedActive, processedCompleted, processedFailed, processedDelayed] = await Promise.all([
      processJobs(waitingJobs),
      processJobs(activeJobs),
      processJobs(completedJobs),
      processJobs(failedJobs),
      processJobs(delayedJobs),
    ]);

    // Calculate statistics
    const totalJobs = waiting + active + completed + failed + delayed;
    const successRate = totalJobs > 0 ? ((completed / (completed + failed)) * 100).toFixed(2) : 0;
    
    // Get job type distribution
    const jobTypeStats = {};
    [...processedCompleted, ...processedFailed, ...processedActive, ...processedWaiting, ...processedDelayed].forEach(job => {
      const jobType = job.data?.jobType || 'unknown';
      if (!jobTypeStats[jobType]) {
        jobTypeStats[jobType] = {
          total: 0,
          completed: 0,
          failed: 0,
          active: 0,
          waiting: 0,
          delayed: 0,
        };
      }
      jobTypeStats[jobType].total++;
      if (job.state === 'completed') jobTypeStats[jobType].completed++;
      else if (job.state === 'failed') jobTypeStats[jobType].failed++;
      else if (job.state === 'active') jobTypeStats[jobType].active++;
      else if (job.state === 'waiting') jobTypeStats[jobType].waiting++;
      else if (job.state === 'delayed') jobTypeStats[jobType].delayed++;
    });

    // Calculate average processing time from completed jobs
    const completedWithTime = processedCompleted.filter(job => job.processedOn && job.finishedOn);
    const avgProcessingTime = completedWithTime.length > 0
      ? completedWithTime.reduce((sum, job) => sum + (job.finishedOn - job.processedOn), 0) / completedWithTime.length
      : 0;

    const analysis = {
      queue: {
        name: syncQueue.name,
        counts: {
          waiting,
          active,
          completed,
          failed,
          delayed,
          paused,
          total: totalJobs,
        },
        metrics: {
          successRate: parseFloat(successRate),
          averageProcessingTime: Math.round(avgProcessingTime),
          totalProcessed: completed + failed,
        },
      },
      jobTypes: jobTypeStats,
      recentJobs: {
        waiting: processedWaiting.slice(0, 20),
        active: processedActive.slice(0, 20),
        completed: processedCompleted.slice(0, 20),
        failed: processedFailed.slice(0, 20),
        delayed: processedDelayed.slice(0, 20),
      },
      timestamp: new Date().toISOString(),
    };

    info('Sync-Route', 'Queue analysis requested', {
      totalJobs,
      active,
      waiting,
      completed,
      failed,
    }, extractContextFromReq(req));

    res.status(200).json(analysis);
  } catch (err) {
    error('Sync-Route', 'Failed to get queue analysis', { err }, req);
    res.status(500).json({
      message: 'Failed to get queue analysis',
      error: err.message,
    });
  }
});

export default router;
