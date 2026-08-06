import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Workspace from '../models/Workspace.js';
import Board from '../models/Board.js';
import { info, error, warn } from '../utils/logger.js';
import { getWorkspace, getBoard, getWorkspacePage, getBoardPage, getMemberRole } from '../services/isoplus.js';
import DynamicLinkingService from '../services/dynamicLinking.js';
import { logAuditTrail } from '../utils/auditLogger.js';
import { collectBoardPages } from '../utils/workspaceBoardHelpers.js';
import { sanitizeApiPathSegment } from '../utils/securityHelpers.js';
import {
  handleWorkspacesListRequest,
  buildWorkspaceMetaById,
  mapWorkspaceWithRole,
  collectWorkspacePages,
  enrichWorkspaceDetails,
} from '../utils/workspaceListHelpers.js';
import {
  isOfflineMode,
  announceOfflineMode,
  getWorkspacePageOffline,
  getBoardPageOffline,
  getMemberRoleOffline,
} from '../services/offlineIsoplus.js';
import {
  requireOwnerOrSupportAdmin,
  parseWorkspaceIdParam,
  buildFeatureTogglesPayload,
  parseInvoiceStatementAutomationBody,
  findBusinessByWorkspaceId,
  upsertInvoiceStatementAutomation,
  getInvoiceStatementAutomationFlag,
  auditFeatureToggleUpdate,
} from '../utils/workspaceFeatureToggleHelpers.js';

const router = express.Router();

/**
 * Which ISO+ collection provider to use for this request.
 *
 * Resolved per request rather than at import time so a test can flip
 * ISOPLUS_OFFLINE without re-importing the module. The offline provider returns
 * the same shapes, so the request handler below is identical either way.
 */
function isoplusCollectionProvider() {
  if (!isOfflineMode()) {
    return { getWorkspacePage, getBoardPage, getMemberRole };
  }
  announceOfflineMode();
  return {
    getWorkspacePage: getWorkspacePageOffline,
    getBoardPage: getBoardPageOffline,
    getMemberRole: getMemberRoleOffline,
  };
}

function sanitizeLogValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.replace(/[\r\n]+/g, ' ').trim();
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, sanitizeLogValue(val)])
    );
  }
  return value;
}

function normalizeQuery(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

const ISOPLUS_MAX_LIMIT = 100;

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await mapper(items[i], i);
    }
  };

  const poolSize = Math.min(Math.max(concurrency, 1), items.length || 1);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}

function workspaceMatchesQuery(w, q) {
  if (!q) return true;
  const id = (w?.id?.toString?.() ?? w?.id ?? '').toString().toLowerCase();
  const name = (w?.name ?? '').toString().toLowerCase();
  return id.includes(q) || name.includes(q);
}

function boardMatchesQuery(b, q) {
  if (!q) return true;
  const id = (b?.id?.toString?.() ?? b?.id ?? '').toString().toLowerCase();
  const name = (b?.name ?? '').toString().toLowerCase();
  const label = (b?.label ?? '').toString().toLowerCase();
  return id.includes(q) || name.includes(q) || label.includes(q);
}

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
    const provider = isoplusCollectionProvider();
    return await handleWorkspacesListRequest(req, res, {
      warn,
      error,
      clampInt,
      normalizeQuery,
      ISOPLUS_MAX_LIMIT,
      withTimeout,
      ...provider,
      mapWithConcurrency,
      workspaceMatchesQuery,
      buildWorkspaceMetaById,
      mapWorkspaceWithRole,
      collectWorkspacePages,
      enrichWorkspaceDetails,
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
    let workspaceId;
    try {
      workspaceId = sanitizeApiPathSegment(req.query.workspaceId, 'workspaceId');
    } catch {
      return res.status(400).json({ message: 'workspaceId query param is required' });
    }

    const limit = clampInt(req.query?.limit || '200', 1, 200, 200);
    const after = req.query?.after ? String(req.query.after) : null;
    const q = normalizeQuery(req.query?.q);
    const maxScanPages = clampInt(process.env.ISOPLUS_SEARCH_SCAN_MAX_PAGES || '20', 1, 200, 20);

    const timeoutMs = process.env.BOARD_FETCH_TIMEOUT_MS || process.env.ISOPLUS_HTTP_TIMEOUT_MS || '30000';

    const collectionResult = await collectBoardPages({
      authorization: req.session.Authorization,
      workspaceId,
      limit,
      after,
      q,
      maxScanPages,
      timeoutMs,
      getBoardPage: isoplusCollectionProvider().getBoardPage,
      withTimeout,
      boardMatchesQuery,
      persistBoardsInBackground,
      req,
      Board,
    });

    if (collectionResult.error) {
      return res.status(500).json({ message: collectionResult.error });
    }

    const { collected, nextAfter, scanHasMore } = collectionResult;
    const sortedBoard = [...collected].sort((a, b) => (a?.name || '').localeCompare(b?.name || ''));

    res.status(200).json({
      board: sortedBoard,
      nextAfter,
      hasMore: Boolean(scanHasMore),
    });
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

router.get('/:workspaceId/feature-toggles', authenticateToken, async (req, res) => {
  try {
    if (!requireOwnerOrSupportAdmin(req, res)) return;

    const workspaceId = parseWorkspaceIdParam(req.params.workspaceId);
    if (!workspaceId) {
      return res.status(400).json({ message: 'Invalid workspaceId' });
    }

    const business = await findBusinessByWorkspaceId(workspaceId);
    info(
      'Workspace-Service',
      'Fetched feature toggles',
      sanitizeLogValue({ workspaceId }),
      req ?? null
    );
    return res.status(200).json(buildFeatureTogglesPayload(business));
  } catch (err) {
    error(
      'Workspace-Service',
      'Failed to fetch feature toggles',
      sanitizeLogValue({
        workspaceId: req.params.workspaceId,
        error: err.message,
        stack: err.stack,
      }),
      req ?? null
    );
    return res.status(500).json({ message: 'Failed to fetch feature toggles' });
  }
});

router.put('/:workspaceId/feature-toggles', authenticateToken, async (req, res) => {
  try {
    if (!requireOwnerOrSupportAdmin(req, res)) return;

    const workspaceId = parseWorkspaceIdParam(req.params.workspaceId);
    if (!workspaceId) {
      return res.status(400).json({ message: 'Invalid workspaceId' });
    }

    const parsed = parseInvoiceStatementAutomationBody(req.body);
    if (parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }

    const existing = await findBusinessByWorkspaceId(workspaceId);
    const previous = getInvoiceStatementAutomationFlag(existing);
    const business = await upsertInvoiceStatementAutomation(workspaceId, parsed.value);
    const payload = buildFeatureTogglesPayload(business);

    await auditFeatureToggleUpdate({
      workspaceId,
      enabled: parsed.value,
      previous,
      req,
    });

    info(
      'Workspace-Service',
      'Updated feature toggles',
      sanitizeLogValue({ workspaceId, ...payload }),
      req ?? null
    );
    return res.status(200).json(payload);
  } catch (err) {
    error(
      'Workspace-Service',
      'Failed to update feature toggles',
      sanitizeLogValue({
        workspaceId: req.params.workspaceId,
        error: err.message,
        stack: err.stack,
      }),
      req ?? null
    );
    return res.status(500).json({ message: 'Failed to update feature toggles' });
  }
});

// Dynamic Linking routes
router.post('/:workspaceId/check-links', authenticateToken, async (req, res) => {
  try {
    let workspaceId;
    try {
      workspaceId = sanitizeApiPathSegment(req.params.workspaceId, 'workspaceId');
    } catch {
      return res.status(400).json({ message: 'Invalid workspaceId' });
    }
    const host = 'https://app.isoplus.online';
    
    // Check if user has permission (owner or support_admin)
    if (req.user.role !== 'owner' && req.user.role !== 'support_admin') {
      return res.status(403).json({ message: 'Access denied. Owner or Support Admin permission required.' });
    }

    const dynamicLinkingService = new DynamicLinkingService(req.session.Authorization, host);
    info('Workspace-Service', 'Checking links', sanitizeLogValue({ workspaceId }), req ?? null);
    const results = await dynamicLinkingService.main(workspaceId, false);

    info('Workspace-Service', 'Links checked', sanitizeLogValue({ workspaceId, results }), req ?? null);
    res.status(200).json(results);
  } catch (err) {
    error('Workspace-Service', 'Failed to check links', sanitizeLogValue({ workspaceId: req.params.workspaceId, error: err.message, stack: err.stack }), req ?? null);
    res.status(500).json({ message: 'Failed to check links', error: err.message });
  }
});

router.post('/:workspaceId/create-links', authenticateToken, async (req, res) => {
  try {
    let workspaceId;
    try {
      workspaceId = sanitizeApiPathSegment(req.params.workspaceId, 'workspaceId');
    } catch {
      return res.status(400).json({ message: 'Invalid workspaceId' });
    }
    const host = 'https://app.isoplus.online';
    
    // Check if user has permission (owner or support_admin)
    if (req.user.role !== 'owner' && req.user.role !== 'support_admin') {
      return res.status(403).json({ message: 'Access denied. Owner or Support Admin permission required.' });
    }

    const dynamicLinkingService = new DynamicLinkingService(req.session.Authorization, host);
    info('Workspace-Service', 'Creating links', sanitizeLogValue({ workspaceId }), req ?? null);
    const results = await dynamicLinkingService.main(workspaceId, true);

    info('Workspace-Service', 'Links created', sanitizeLogValue({ workspaceId, results }), req ?? null);
    res.status(200).json(results);
  } catch (err) {
    error('Workspace-Service', 'Failed to create links', sanitizeLogValue({ workspaceId: req.params.workspaceId, error: err.message, stack: err.stack }), req ?? null);
    res.status(500).json({ message: 'Failed to create links', error: err.message });
  }
});

export default router;