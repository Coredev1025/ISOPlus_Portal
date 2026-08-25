import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Workspace from '../models/Workspace.js';
import Board from '../models/Board.js';
import AutomationSettings from '../models/AutomationSettings.js';
import PDFLink from '../models/PDFLink.js';
import ScheduledJob from '../models/ScheduledJob.js';
import { info, error, warn } from '../utils/logger.js';
import {
  parseAutomationSettingsBody,
  buildAutomationSettingsPayload,
  toScheduleInput,
  isScheduleClientError,
  automationScheduleBlocks,
  automationScheduleRejection,
} from '../utils/automationSettingsHelpers.js';
import { upsertSchedule, disableSchedule } from '../services/scheduler/schedules.js';
import { readQueueDepth } from '../services/automation/queueMetrics.js';
import { xeroConnectionStatus } from '../utils/automationConnectionStatus.js';
import { DELIVERY_STATE_GENERATED, KIND_INVOICE, KIND_STATEMENT } from '../constants/automation.js';
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
import { requireWorkspaceMember } from '../utils/workspaceAccessHelpers.js';
import {
  requireOwnerOrSupportAdmin,
  parseWorkspaceIdParam,
  buildFeatureTogglesPayload,
  parseInvoiceStatementAutomationBody,
  findBusinessByWorkspaceId,
  upsertInvoiceStatementAutomation,
  getInvoiceStatementAutomationFlag,
  isInvoiceStatementAutomationEnabled,
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
    if (!existing) {
      return res.status(404).json({
        message: 'Business not found. Configure the business profile first.',
      });
    }
    const previous = getInvoiceStatementAutomationFlag(existing);
    const business = await upsertInvoiceStatementAutomation(workspaceId, parsed.value);
    if (!business) {
      return res.status(404).json({
        message: 'Business not found. Configure the business profile first.',
      });
    }
    const payload = buildFeatureTogglesPayload(business);

    // Withdrawing the feature has to stop what it started. disableSchedule was
    // only ever called from the settings PUT, so a workspace whose toggle went
    // off kept its enabled ScheduledJob rows, and the next tick kept billing
    // for a feature the workspace was no longer on. Disabled, not deleted, so
    // turning the toggle back on still shows each block's history.
    if (parsed.value === false) {
      await disableAutomationSchedules(workspaceId);
    }

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

/**
 * The live ScheduledJob rows behind a workspace's automation, keyed by kind.
 *
 * `nextRun` is never stored on AutomationSettings: ScheduledJob.nextRunAt is
 * the single source of truth, because it is the value the scheduler tick
 * claims on. Reading anything else would let the UI and the scheduler
 * disagree about when a run is due.
 *
 * Disabled rows are excluded rather than returned with their stale
 * nextRunAt — a disabled job will not fire, so it has no next run.
 */
async function loadAutomationJobs(workspaceId) {
  // Disabled rows are loaded too: buildAutomationSettingsPayload hides their
  // nextRun but still surfaces lastRunAt/lastError, so a paused block's
  // status panel can show when it last ran.
  const jobs = await ScheduledJob.find({
    kind: { $in: [KIND_INVOICE, KIND_STATEMENT] },
    targetId: { $eq: workspaceId },
  })
    .select('kind enabled nextRunAt lastRunAt lastError consecutiveFailures timezone')
    .lean();

  return Object.fromEntries(jobs.map((job) => [job.kind, job]));
}

/**
 * The last automation-generated documents, for the client-facing status
 * panel. `periodKey` is what distinguishes an automation run's PDFLink rows
 * from the UI generators' (only recordPdfLinks and the statement generator
 * set it), and a multi-item invoice records one row per item, so rows dedupe
 * by pdfLink before the cap. The oversampled limit leaves room for that
 * dedupe without reading the whole collection.
 */
const RECENT_DOCUMENTS_LIMIT = 10;

/**
 * The two operational signals a client needs about their own automation, from
 * the same sources the admin System Health screen reads.
 *
 * `queueBacklogged` is a BOOLEAN on purpose. Queue depth is global across every
 * tenant, so returning the count here would tell one client how much work the
 * others are generating. The boolean carries the only part they can act on —
 * "your run may be late" — and discloses nothing about volume.
 *
 * `accounting` is this workspace's own Xero state. It matters most to the
 * client because they are the only party who can re-authorise it; before this
 * it was visible only to owner/support, on a screen a client cannot open.
 *
 * Never throws: `readQueueDepth` already answers `available: false` rather than
 * rejecting when Redis is down, and a missing Business row reads as
 * not_connected. A degraded signal must not fail the settings load, which is
 * the page's primary content.
 */
async function clientAutomationHealth(workspaceId) {
  const [queue, business] = await Promise.all([
    readQueueDepth(),
    // The same lookup the feature-toggle routes use, rather than a second
    // Business import in this file.
    findBusinessByWorkspaceId(workspaceId),
  ]);

  return {
    queueBacklogged: queue.backlogged === true,
    // Distinguishes "the queue is fine" from "we could not ask it" — a false
    // backlog reading and an unknown one are different things to a client
    // wondering why nothing arrived.
    queueAvailable: queue.available !== false,
    accounting: xeroConnectionStatus(business, new Date()),
  };
}

async function loadRecentAutomationDocuments(workspaceId) {
  // Dedupe in the database, not after a truncated read. The previous pipeline
  // took the newest 50 rows and deduped those, so a single 50-item invoice —
  // 50 rows sharing one pdfLink — collapsed to one document and hid the nine
  // older ones that should have filled the list. Grouping first makes the
  // limit a limit on documents rather than on rows.
  const rows = await PDFLink.aggregate([
    { $match: { workspaceId: { $eq: workspaceId }, periodKey: { $nin: [null, ''] } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$pdfLink',
        // The row that carries this document, so the panel can link to the
        // re-signing route rather than to the signature captured at generation
        // time. Any of the grouped rows will do: they share a pdfLink, which is
        // the same S3 object.
        pdfLinkId: { $first: '$_id' },
        type: { $first: '$type' },
        invoiceNumber: { $first: '$invoiceNumber' },
        // The client the document was raised for. Epic 5's status panel names
        // a recipient beside the sent time and this is the nearest thing
        // stored — under Recipient = Billing Contact the mail can go to that
        // profile's Billing Email instead, and no mailbox is recorded, so the
        // panel renders this as "For <name>" rather than as the address. The
        // field was already stored and already declared on the client type;
        // only the projection was missing.
        participant: { $first: { $ifNull: ['$participant', null] } },
        periodKey: { $first: '$periodKey' },
        createdAt: { $first: '$createdAt' },
        // What became of the email that carried this document. `$ifNull`
        // rather than a backfill migration: rows written before delivery
        // tracking existed have no `deliveryState`, and "generated" is exactly
        // what they are — the field is absent, not wrong.
        deliveryState: { $first: { $ifNull: ['$deliveryState', DELIVERY_STATE_GENERATED] } },
        deliveryDetail: { $first: { $ifNull: ['$deliveryDetail', null] } },
      },
    },
    // $group does not preserve the sort, so order the surviving documents
    // again before the cap.
    { $sort: { createdAt: -1 } },
    { $limit: RECENT_DOCUMENTS_LIMIT },
  ]);

  return rows.map((row) => ({
    type: row.type,
    invoiceNumber: row.invoiceNumber ?? null,
    // Always present, null when the row carries none, so the client can tell
    // "nobody was recorded" apart from "this build does not send the field".
    participant: row.participant ?? null,
    periodKey: row.periodKey,
    // A backend PATH, not the stored URL. The stored one is a presigned S3 link
    // captured when the document was generated, and seven days is the longest
    // signature AWS will issue — so the panel's links used to stop working a
    // week after the run, with nothing in the UI to say why. This one re-signs
    // per request. Relative because the API does not reliably know its own
    // public origin; the frontend prefixes NEXT_PUBLIC_BACKEND_URL, as it does
    // for every other call.
    pdfUrl: `/api/pdf-links/download/${row.pdfLinkId}`,
    createdAt: row.createdAt,
    deliveryState: row.deliveryState,
    // A sentence the client can act on, and only for the states that have
    // one. `deliveryMessageId` is deliberately not projected: it is internal
    // plumbing for the SES event lookup, not something a page needs.
    deliveryDetail: row.deliveryDetail ?? null,
  }));
}

/**
 * Bring both schedules in line with the settings the client just sent.
 *
 * `disableSchedule` sets `enabled: false` rather than deleting, so lastRunAt
 * and missedRuns survive a toggle; for a block that was never enabled it
 * matches nothing and is a harmless no-op.
 */
async function writeAutomationSchedules(workspaceId, value) {
  for (const { kind, block } of automationScheduleBlocks(value)) {
    if (block.enabled) {
      await upsertSchedule({
        kind,
        targetId: workspaceId,
        workspaceId,
        schedule: toScheduleInput(block),
      });
    } else {
      await disableSchedule({ kind, targetId: workspaceId });
    }
  }
}

/** Both automation schedules off, for a workspace losing the feature. */
async function disableAutomationSchedules(workspaceId) {
  await disableSchedule({ kind: KIND_INVOICE, targetId: workspaceId });
  await disableSchedule({ kind: KIND_STATEMENT, targetId: workspaceId });
}

router.get('/:workspaceId/automation-settings', authenticateToken, async (req, res) => {
  try {
    const workspaceId = parseWorkspaceIdParam(req.params.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    // Tenancy, and it belongs on the read as much as on the write: the payload
    // carries the workspace's schedules, its billing email addresses and
    // presigned S3 URLs to its generated invoices. authenticateToken only
    // establishes that an ISO+ session exists, never that it belongs to this
    // workspace — see utils/workspaceAccessHelpers.js.
    if (!(await requireWorkspaceMember(req, res, workspaceId))) return;

    const settings = await AutomationSettings.findOne({ workspaceId: { $eq: workspaceId } }).lean();
    const jobs = await loadAutomationJobs(workspaceId);
    const recentDocuments = await loadRecentAutomationDocuments(workspaceId);
    const health = await clientAutomationHealth(workspaceId);
    return res.status(200).json({
      ...buildAutomationSettingsPayload(settings, jobs),
      recentDocuments,
      health,
    });
  } catch (err) {
    error(
      'Workspace-Service',
      'Failed to fetch automation settings',
      sanitizeLogValue({ workspaceId: req.params.workspaceId, error: err.message }),
      req ?? null
    );
    return res.status(500).json({ message: 'Failed to fetch automation settings' });
  }
});

router.put('/:workspaceId/automation-settings', authenticateToken, async (req, res) => {
  try {
    const workspaceId = parseWorkspaceIdParam(req.params.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    // Membership before the feature flag, because the flag is a property of the
    // workspace and answering it for a workspace the caller cannot see is
    // already a disclosure.
    if (!(await requireWorkspaceMember(req, res, workspaceId))) return;

    // The feature flag, read on the write path so it is a gate and not a
    // label. GET stays open: a workspace that has lost the feature still needs
    // to see what it had.
    if (!(await isInvoiceStatementAutomationEnabled(workspaceId))) {
      return res.status(403).json({
        message: 'Invoice & Statement Automation is not enabled for this workspace.',
      });
    }

    const parsed = parseAutomationSettingsBody(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });

    // Both schedules are validated before either is written. writeAutomationSchedules
    // writes the invoice one and then the statement one, so without this a
    // rejected statement block left a live invoice schedule on the new cadence
    // while AutomationSettings still held the old values — the client sees a
    // 400 and the automation runs anyway.
    const scheduleRejection = automationScheduleRejection(parsed.value);
    if (scheduleRejection) return res.status(400).json({ message: scheduleRejection });

    // Schedules first, settings second, and the order is the whole safety
    // mechanism: Mongo transactions need a replica set and local dev runs a
    // standalone mongod, so these three writes cannot be made atomic. Writing
    // the schedules first means a failure here leaves the settings document
    // exactly as it was, and the UI keeps telling the truth. The other order
    // would leave it reading "enabled" for automation that can never fire —
    // the worst outcome available, because it looks fine.
    //
    // What survives that argument, honestly: if the database fails between the
    // two schedule writes, the first block is left on its new cadence with the
    // settings document unwritten. That is a 500, not a 400, and no
    // compensating write is attempted here — it would need the connection that
    // just failed. A retry converges, and the residual schedule is one the
    // client asked for.
    await writeAutomationSchedules(workspaceId, parsed.value);

    const settings = await AutomationSettings.findOneAndUpdate(
      { workspaceId: { $eq: workspaceId } },
      { $set: { workspaceId, ...parsed.value } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();

    // Read back rather than reuse what upsertSchedule returned, so the
    // response carries the same nextRun a subsequent GET would, and the UI
    // shows it immediately instead of after a reload.
    const jobs = await loadAutomationJobs(workspaceId);

    info(
      'Workspace-Service',
      'Automation settings updated',
      sanitizeLogValue({ workspaceId }),
      req ?? null
    );
    return res.status(200).json(buildAutomationSettingsPayload(settings, jobs));
  } catch (err) {
    // A rejected schedule is caused by the request body, so it is a client
    // error. Its message is the scheduler's own and safe to return; anything
    // else is a server fault, which stays a generic 500 with the detail only
    // in the log.
    if (isScheduleClientError(err)) {
      return res.status(400).json({ message: err.message });
    }

    // Every 500 out of this handler is by construction a partial write: the
    // schedules are written before the settings, so reaching here means the
    // schedules may already be on the new cadence while AutomationSettings
    // still holds the old values. Say so in the log — it is the only place
    // that state is visible.
    error(
      'Workspace-Service',
      'Failed to update automation settings',
      sanitizeLogValue({
        workspaceId: req.params.workspaceId,
        error: err.message,
        schedulesMayBePartiallyWritten: true,
      }),
      req ?? null
    );
    return res.status(500).json({ message: 'Failed to update automation settings' });
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