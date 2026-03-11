import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Workspace from '../models/Workspace.js';
import Board from '../models/Board.js';
import { info, error, warn } from '../utils/logger.js';
import { getWorkspace, getBoard, getWorkspacePage, getBoardPage } from '../services/isoplus.js';
import DynamicLinkingService from '../services/dynamicLinking.js';
import { logAuditTrail } from '../utils/auditLogger.js';

const router = express.Router();

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

function withTimeout(promise, timeoutMs, message) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new TimeoutError(message)), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function persistBoardsInBackground(boards, req) {
  try {
    const operations = boards
      .map((board) => {
        const boardId = board.id?.toString();
        if (!boardId || !board.name) {
          warn('Workspace-Service', 'Skipping board with missing id or name', { board }, req ?? null);
          return null;
        }

        return {
          updateOne: {
            filter: { boardId },
            update: {
              $setOnInsert: {
                boardId,
                name: board.name,
                color: board.color || '',
                description: board.description || '',
                og_image: board.og_image || '',
                label: 'No Label',
                createdAt: new Date(),
              },
            },
            upsert: true,
          },
        };
      })
      .filter(Boolean);

    if (!operations.length) return;

    const result = await Board.bulkWrite(operations, { ordered: false });
    info('Workspace-Service', 'Auto-stored boards in database', {
      total: boards.length,
      inserted: result?.upsertedCount || 0,
      matched: result?.matchedCount || 0,
      modified: result?.modifiedCount || 0,
    }, req ?? null);
  } catch (err) {
    error('Workspace-Service', 'Failed to persist boards in background', {
      error: err.message,
      stack: err.stack,
    }, req ?? null);
  }
}

router.get('/', authenticateToken, async (req, res) => {
  try {
    const authorization = req.session?.Authorization;
    if (!authorization) {
      warn(
        'Workspace-Service',
        'Missing OAuth authorization in session',
        { hasSession: Boolean(req.session), hasToken: Boolean(req.session?.token) },
        req ?? null
      );
      return res.status(401).json({
        message: 'Authentication session is missing OAuth credentials. Please login again.',
        error_type: 'oauth',
      });
    }

    const limit = Math.min(Math.max(parseInt(req.query?.limit || '50', 10), 1), 200);
    const after = req.query?.after ? String(req.query.after) : null;

    const workspaceMetaById = Array.isArray(req.user?.workspace)
      ? req.user.workspace.reduce((acc, workspace) => {
          const id = workspace?.id?.toString();
          if (!id) return acc;
          acc[id] = {
            user_role: workspace?.user_role || 'restricted_member',
            board: Array.isArray(workspace?.board) ? workspace.board : undefined,
          };
          return acc;
        }, {})
      : null;

    const timeoutMs = process.env.WORKSPACE_FETCH_TIMEOUT_MS || process.env.ISOPLUS_HTTP_TIMEOUT_MS || '30000';
    const page = await withTimeout(
      getWorkspacePage(authorization, { limit, after }),
      timeoutMs,
      'Workspace fetch timed out'
    );

    if (page.status === 200 && Array.isArray(page.workspace)) {
      const mapped = page.workspace.map((w) => {
        const id = w?.id?.toString?.() ?? w?.id;
        const metaFromToken = workspaceMetaById && id ? workspaceMetaById[id] : null;
        const roleFromToken = metaFromToken?.user_role || null;
        const user_role =
          roleFromToken ||
          (req.user?.role === 'owner' ? 'owner' : null) ||
          (req.user?.role === 'support_admin' ? 'admin' : null) ||
          'restricted_member';

        return {
          ...w,
          user_role,
          // Keep board ID allowlist from JWT (used for admin board filtering)
          ...(metaFromToken?.board ? { board: metaFromToken.board } : {}),
        };
      });

      const sortedWorkspace = [...mapped].sort((a, b) => (a?.name || '').localeCompare(b?.name || ''));
      return res.status(200).json({
        workspace: sortedWorkspace,
        nextAfter: page.after,
        hasMore: Boolean(page.has_more),
      });
    }

    const rawMessage = page.message || 'Failed to fetch workspaces';
    const normalized = String(rawMessage).toLowerCase();
    const mappedStatus =
      normalized.includes('status code 401') || normalized.includes('unauthorized') ? 401 :
      normalized.includes('status code 403') || normalized.includes('forbidden') ? 403 :
      500;

    warn('Workspace-Service', 'Failed to fetch workspaces', { status: page.status, message: rawMessage }, req ?? null);
    return res.status(mappedStatus).json({
      message: rawMessage,
      ...(mappedStatus === 401 ? { error_type: 'oauth' } : {}),
    });
  } catch (err) {
    const status = err?.name === 'TimeoutError' ? 504 : 500;
    error(
      'Workspace-Service',
      'Unhandled error in workspaces endpoint',
      { message: err?.message, stack: err?.stack, status },
      req ?? null
    );
    return res.status(status).json({ message: status === 504 ? 'Workspace fetch timed out' : 'Server error' });
  }
});

router.get('/boards', authenticateToken, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId?.toString();
    if (!workspaceId) {
      return res.status(400).json({ message: 'workspaceId query param is required' });
    }

    const limit = Math.min(Math.max(parseInt(req.query?.limit || '200', 10), 1), 200);
    const after = req.query?.after ? String(req.query.after) : null;

    const timeoutMs = process.env.BOARD_FETCH_TIMEOUT_MS || process.env.ISOPLUS_HTTP_TIMEOUT_MS || '30000';
    const page = await withTimeout(
      getBoardPage(req.session.Authorization, workspaceId, { limit, after }),
      timeoutMs,
      'Board fetch timed out'
    );

    if (page.status === 200 && Array.isArray(page.board)) {
      const boardIds = page.board
        .map((b) => b?.id?.toString?.() ?? b?.id)
        .filter(Boolean)
        .map((id) => String(id));

      const dbBoards = boardIds.length
        ? await Board.find({ boardId: { $in: boardIds }, workspaceId: workspaceId.toString() })
            .select('boardId label')
            .lean()
        : [];

      const labelById = new Map(dbBoards.map((b) => [String(b.boardId), b.label]));

      const enriched = page.board.map((b) => {
        const id = b?.id?.toString?.() ?? b?.id;
        const label = id ? labelById.get(String(id)) : undefined;
        return { ...b, label: label || b?.label || 'No Label' };
      });

      const sortedBoard = [...enriched].sort((a, b) => (a?.name || '').localeCompare(b?.name || ''));

      res.status(200).json({
        board: sortedBoard,
        nextAfter: page.after,
        hasMore: Boolean(page.has_more),
      });

      setImmediate(() => {
        persistBoardsInBackground(page.board, req);
      });
    } else {
      res.status(500).json({ message: page.message || 'Failed to fetch boards' });
    }
  } catch (err) {
    error('Workspace-Service', 'Error in boards endpoint', { message: err.message, stack: err.stack }, req ?? null);
    const status = err?.name === 'TimeoutError' ? 504 : 500;
    res.status(status).json({ message: status === 504 ? 'Board fetch timed out' : 'Server error' });
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
    info('Workspace-Service', 'New Workspace created', { workspaceId: workspace._id }, req ?? null);
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
    error('Workspace-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
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
    info('Workspace-Service', 'Checking links', { workspaceId }, req ?? null);
    const results = await dynamicLinkingService.main(workspaceId, false);

    info('Workspace-Service', 'Links checked', { workspaceId, results }, req ?? null);
    res.status(200).json(results);
  } catch (err) {
    error('Workspace-Service', 'Failed to check links', { workspaceId: req.params.workspaceId, error: err.message, stack: err.stack }, req ?? null);
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
    info('Workspace-Service', 'Creating links', { workspaceId }, req ?? null);
    const results = await dynamicLinkingService.main(workspaceId, true);

    info('Workspace-Service', 'Links created', { workspaceId, results }, req ?? null);
    res.status(200).json(results);
  } catch (err) {
    error('Workspace-Service', 'Failed to create links', { workspaceId: req.params.workspaceId, error: err.message, stack: err.stack }, req ?? null);
    res.status(500).json({ message: 'Failed to create links', error: err.message });
  }
});

export default router;