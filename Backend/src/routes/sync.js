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

const router = express.Router();

/**
 * Enable sync for a specific board
 * This triggers validation and then backlog sync
 * POST /api/sync/board/enable
 */
router.post('/board/enable', authenticateToken, async (req, res) => {
  try {
    const { workspaceId, boardId } = req.body;
    
    if (!workspaceId || !boardId) {
      return res.status(400).json({ 
        message: 'workspaceId and boardId are required' 
      });
    }

    const result = await enableBoardSync(req.session.Authorization, workspaceId, boardId);
    
    info('Sync-Route', 'Board sync enable requested', { 
      workspaceId, 
      boardId,
      success: result.success
    }, extractContextFromReq(req));
    
    const statusCode = result.success ? 202 : 409; // 202 Accepted, 409 Conflict
    res.status(statusCode).json(result);
  } catch (err) {
    error('Sync-Route', 'Failed to enable board sync', { 
      error: err.message
    }, extractContextFromReq(req));
    res.status(500).json({ 
      message: 'Failed to enable sync', 
      error: err.message 
    });
  }
});

/**
 * Disable sync for a specific board
 * POST /api/sync/board/disable
 */
router.post('/board/disable', authenticateToken, async (req, res) => {
  try {
    const { boardId } = req.body;
    
    if (!boardId) {
      return res.status(400).json({ 
        message: 'boardId is required' 
      });
    }

    const result = await disableBoardSync(boardId);
    
    info('Sync-Route', 'Board sync disabled', { 
      boardId
    }, extractContextFromReq(req));
    
    res.status(200).json(result);
  } catch (err) {
    error('Sync-Route', 'Failed to disable board sync', { 
      error: err.message
    }, extractContextFromReq(req));
    res.status(500).json({ 
      message: 'Failed to disable sync', 
      error: err.message 
    });
  }
});

/**
 * Trigger manual sync for a specific board
 * POST /api/sync/board/manual
 */
router.post('/board/manual', authenticateToken, async (req, res) => {
  try {
    const { workspaceId, boardId } = req.body;
    
    if (!workspaceId || !boardId) {
      return res.status(400).json({ 
        message: 'workspaceId and boardId are required' 
      });
    }

    const result = await triggerManualSync(req.session.Authorization, workspaceId, boardId);
    
    info('Sync-Route', 'Manual sync triggered', { 
      workspaceId, 
      boardId,
      success: result.success
    }, extractContextFromReq(req));
    
    const statusCode = result.success ? 202 : 409;
    res.status(statusCode).json(result);
  } catch (err) {
    error('Sync-Route', 'Failed to trigger manual sync', { 
      error: err.message
    }, extractContextFromReq(req));
    res.status(500).json({ 
      message: 'Failed to trigger manual sync', 
      error: err.message 
    });
  }
});

/**
 * Retry sync after failure
 * POST /api/sync/board/retry
 */
router.post('/board/retry', authenticateToken, async (req, res) => {
  try {
    const { workspaceId, boardId } = req.body;
    
    if (!workspaceId || !boardId) {
      return res.status(400).json({ 
        message: 'workspaceId and boardId are required' 
      });
    }

    const result = await retrySyncAfterFailure(req.session.Authorization, workspaceId, boardId);
    
    info('Sync-Route', 'Sync retry triggered', { 
      workspaceId, 
      boardId,
      success: result.success,
      retryCount: result.retryCount
    }, extractContextFromReq(req));
    
    const statusCode = result.success ? 202 : 409;
    res.status(statusCode).json(result);
  } catch (err) {
    error('Sync-Route', 'Failed to retry sync', { 
      error: err.message
    }, extractContextFromReq(req));
    res.status(500).json({ 
      message: 'Failed to retry sync', 
      error: err.message 
    });
  }
});

/**
 * Cancel sync for a board
 * POST /api/sync/board/cancel
 */
router.post('/board/cancel', authenticateToken, async (req, res) => {
  try {
    const { boardId } = req.body;
    
    if (!boardId) {
      return res.status(400).json({ 
        message: 'boardId is required' 
      });
    }

    const result = await cancelBoardSync(boardId);
    
    info('Sync-Route', 'Sync cancelled', { 
      boardId
    }, extractContextFromReq(req));
    
    res.status(200).json(result);
  } catch (err) {
    error('Sync-Route', 'Failed to cancel sync', { 
      error: err.message
    }, extractContextFromReq(req));
    res.status(500).json({ 
      message: 'Failed to cancel sync', 
      error: err.message 
    });
  }
});

/**
 * Enable sync for all boards in a workspace
 * POST /api/sync/workspace/enable
 */
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
    error('Sync-Route', 'Failed to enable workspace sync', { 
      error: err.message
    }, extractContextFromReq(req));
    res.status(500).json({ 
      message: 'Failed to enable workspace sync', 
      error: err.message 
    });
  }
});

/**
 * Get sync status for a specific board
 * GET /api/sync/board/status/:boardId
 */
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
    
    error('Sync-Route', 'Failed to get board sync status', { 
      boardId: req.params.boardId,
      error: err.message
    }, extractContextFromReq(req));
    res.status(500).json({ 
      message: 'Failed to get sync status', 
      error: err.message 
    });
  }
});

/**
 * Get sync status for all boards with sync enabled in workspace
 * GET /api/sync/workspace/status/:workspaceId
 */
router.get('/workspace/status/:workspaceId', authenticateToken, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    
    if (!workspaceId) {
      return res.status(400).json({ 
        message: 'workspaceId is required' 
      });
    }

    const boards = await Board.find({ syncData: true });
    
    const boardsStatus = await Promise.all(
      boards.map(async (board) => {
        try {
          return await getBoardSyncStatus(board.boardId);
        } catch (err) {
          error('Sync-Route', 'Failed to get status for board', { 
            boardId: board.boardId,
            error: err.message 
          }, {});
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
    error('Sync-Route', 'Failed to get workspace sync status', { 
      workspaceId: req.params.workspaceId,
      error: err.message
    }, extractContextFromReq(req));
    res.status(500).json({ 
      message: 'Failed to get sync status', 
      error: err.message 
    });
  }
});

export default router;
