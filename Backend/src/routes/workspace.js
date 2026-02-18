import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Workspace from '../models/Workspace.js';
import Board from '../models/Board.js';
import { info, error, warn, extractContextFromReq } from '../utils/logger.js';
import { getWorkspace, getBoard } from '../services/isoplus.js';
import DynamicLinkingService from '../services/dynamicLinking.js';
import { logAuditTrail } from '../utils/auditLogger.js';

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  const response = await getWorkspace(req.session.Authorization, req.user.email);

  if (response.status === 200 && Array.isArray(response.workspace)) {
    const sortedWorkspace = [...response.workspace].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    res.status(200).json({ workspace: sortedWorkspace });
  } else {
    res.status(500).json({ message: response.message || 'Failed to fetch workspaces' });
  }
});

router.get('/boards', authenticateToken, async (req, res) => {
  try {
    const response = await getBoard(req.session.Authorization, req.query.workspaceId);

    if (response.status === 200 && Array.isArray(response.board)) {
      // Store boards in database if they don't exist (parallel processing)
      const boardPromises = response.board.map(async (board) => {
        try {
          const boardId = board.id?.toString();
          if (!boardId || !board.name) {
            warn('Workspace-Service', 'Skipping board with missing id or name', { board }, extractContextFromReq(req));
            return null;
          }

          // Use findOneAndUpdate with upsert to avoid race conditions
          await Board.findOneAndUpdate(
            { boardId },
            {
              $setOnInsert: {
                boardId: boardId,
                name: board.name,
                color: board.color || '',
                description: board.description || '',
                og_image: board.og_image || '',
                label: 'No Label',
                createdAt: new Date()
              }
            },
            { upsert: true, new: true }
          );

          return boardId;
        } catch (err) {
          error('Workspace-Service', 'Failed to save individual board', { 
            boardId: board.id, 
            error: err.message,
            stack: err.stack
          }, extractContextFromReq(req));
          return null;
        }
      });

      // Wait for all board operations to complete
      const results = await Promise.all(boardPromises);
      const successCount = results.filter(r => r !== null).length;
      
      if (successCount > 0) {
        info('Workspace-Service', 'Auto-stored boards in database', { 
          total: response.board.length, 
          processed: successCount 
        }, extractContextFromReq(req));
      }

      const sortedBoard = [...response.board].sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      res.status(200).json({ board: sortedBoard });
    } else {
      res.status(500).json({ message: response.message || 'Failed to fetch boards' });
    }
  } catch (err) {
    error('Workspace-Service', 'Error in boards endpoint', { message: err.message, stack: err.stack }, extractContextFromReq(req));
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, businessId } = req.body;
    const workspace = new Workspace({
      name,
      businessId,
      userId: req.user.userId
    });
    await workspace.save();
    info('Workspace-Service', 'New Workspace created', { workspaceId: workspace._id }, extractContextFromReq(req));
    const workspaceId = workspace._id?.toString();
    await logAuditTrail({
      workspaceId,
      action: 'Created new Workspace',
      detail: `New Workspace created: ${workspaceId}`,
      req,
      entityType: 'Workspace',
      entityId: workspaceId,
      success: true,
      statusCode: 201
    });
    res.status(201).json(workspace);
  } catch (err) {
    error('Workspace-Service', 'Server error', { message: err.message, stack: err.stack }, extractContextFromReq(req));
    res.status(500).json({ message: 'Server error' });
  }
});

// Dynamic Linking routes
router.post('/:workspaceId/check-links', authenticateToken, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const host = 'https://app.isoplus.online';
    
    // Check if user has permission (owner or support_admin)
    if (req.user.role !== 'owner' && req.user.role !== 'support_admin') {
      return res.status(403).json({ message: 'Access denied. Owner or Support Admin permission required.' });
    }

    const dynamicLinkingService = new DynamicLinkingService(req.session.Authorization, host);
    info('Workspace-Service', 'Checking links', { workspaceId }, extractContextFromReq(req));
    const results = await dynamicLinkingService.main(workspaceId, false);

    info('Workspace-Service', 'Links checked', { workspaceId, results }, extractContextFromReq(req));
    res.status(200).json(results);
  } catch (err) {
    error('Workspace-Service', 'Failed to check links', { workspaceId: req.params.workspaceId, error: err.message, stack: err.stack }, extractContextFromReq(req));
    res.status(500).json({ message: 'Failed to check links', error: err.message });
  }
});

router.post('/:workspaceId/create-links', authenticateToken, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const host = 'https://app.isoplus.online';
    
    // Check if user has permission (owner or support_admin)
    if (req.user.role !== 'owner' && req.user.role !== 'support_admin') {
      return res.status(403).json({ message: 'Access denied. Owner or Support Admin permission required.' });
    }

    const dynamicLinkingService = new DynamicLinkingService(req.session.Authorization, host);
    info('Workspace-Service', 'Creating links', { workspaceId }, extractContextFromReq(req));
    const results = await dynamicLinkingService.main(workspaceId, true);

    info('Workspace-Service', 'Links created', { workspaceId, results }, extractContextFromReq(req));
    res.status(200).json(results);
  } catch (err) {
    error('Workspace-Service', 'Failed to create links', { workspaceId: req.params.workspaceId, error: err.message, stack: err.stack }, extractContextFromReq(req));
    res.status(500).json({ message: 'Failed to create links', error: err.message });
  }
});

export default router;