import express from 'express';

import AutomationRun from '../models/AutomationRun.js';
import AutomationSettings from '../models/AutomationSettings.js';
import Business from '../models/Business.js';
import Board from '../models/Board.js';
import SchedulerHealth from '../models/SchedulerHealth.js';
import EmailEvent from '../models/EmailEvent.js';
import ScheduledJob from '../models/ScheduledJob.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireOwnerOrSupport } from '../middleware/requireOwnerOrSupport.js';
import { summariseRuns } from '../utils/automationRunMetrics.js';
import { xeroConnectionStatus } from '../utils/automationConnectionStatus.js';
import {
  KIND_FOR_BODY,
  buildManualDispatch,
  withForceJobIds,
  buildRetrySpec,
} from '../utils/systemHealthRunHelpers.js';
import { readQueueDepth } from '../services/automation/queueMetrics.js';
import { getAutomationQueue } from '../services/automation/queue.js';
import { KIND_INVOICE } from '../constants/automation.js';
import { recordQueuedRuns } from '../services/automation/runs.js';
import { emailsForRun } from '../services/automation/runEmails.js';
import {
  ERROR_RATE_WINDOW_HOURS,
  WEEK_WINDOW_HOURS,
  HISTORY_PAGE_SIZE,
  TRIGGER_MANUAL,
  RUN_FAILED,
  SES_BOUNCE_EVENT,
  SES_COMPLAINT_EVENT,
} from '../constants/systemHealth.js';
import { mongoEq } from '../utils/securityHelpers.js';
import { error as logError } from '../utils/logger.js';

const router = express.Router();

// Matches the local HOUR_MS in utils/automationRunMetrics.js, which is not
// exported — declared here rather than imported so that module's public
// surface stays untouched by this route's needs.
const HOUR_MS = 60 * 60 * 1000;

router.use(authenticateToken, requireOwnerOrSupport);

/** Workspaces with at least one automation block enabled. */
function enabledWorkspaceFilter() {
  return { $or: [{ 'invoice.enabled': true }, { 'statement.enabled': true }] };
}

router.get('/overview', async (req, res) => {
  try {
    const now = new Date();
    // One week back covers every figure summariseRuns computes, so the route
    // makes a single query rather than one per window. Must reach at least as
    // far back as WEEK_WINDOW_HOURS, the widest window summariseRuns reads —
    // otherwise runsThisWeek would silently truncate to whatever this query
    // happened to return.
    const from = new Date(now.getTime() - WEEK_WINDOW_HOURS * HOUR_MS);

    const [rows, activeAutomations, queue, health, deliveryIssues] = await Promise.all([
      AutomationRun.find({ startedAt: { $gte: from } }).select('status startedAt').lean(),
      AutomationSettings.countDocuments(enabledWorkspaceFilter()),
      readQueueDepth(),
      SchedulerHealth.findOne({}).select('lastTickAt').lean(),
      // Grouped in the database rather than counted twice: one pass over the
      // same window the run figures use, so the two cannot disagree about
      // which week they describe.
      EmailEvent.aggregate([
        { $match: { eventAt: { $gte: from }, eventType: { $in: [SES_BOUNCE_EVENT, SES_COMPLAINT_EVENT] } } },
        { $group: { _id: '$eventType', count: { $sum: 1 } } },
      ]),
    ]);

    const countFor = (type) => deliveryIssues.find((row) => row._id === type)?.count ?? 0;

    res.json({
      ...summariseRuns(rows, now),
      activeAutomations,
      queue,
      // A stopped clock is the failure every other figure here hides: with no
      // ticks, runsToday is legitimately 0 and the error rate is legitimately
      // 0, and the screen looks healthy. null means the scheduler has never
      // ticked in this environment, which is usually a missing EventBridge
      // rule — see docs/scheduling.md.
      lastTickAt: health?.lastTickAt ?? null,
      errorRateWindowHours: ERROR_RATE_WINDOW_HOURS,
      // Always present, always numeric — including when nothing bounced. The
      // screen previously rendered a paragraph saying delivery reporting did
      // not exist, which is indistinguishable to an operator from "it exists
      // and everything is fine". Zero says the second thing.
      delivery: {
        bounced: countFor(SES_BOUNCE_EVENT),
        complained: countFor(SES_COMPLAINT_EVENT),
        windowHours: WEEK_WINDOW_HOURS,
      },
    });
  } catch (err) {
    logError('SystemHealth', 'Overview failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not load system health' });
  }
});

router.get('/clients', async (req, res) => {
  try {
    const now = new Date();
    const settings = await AutomationSettings.find(enabledWorkspaceFilter())
      .select('workspaceId invoice.enabled statement.enabled')
      .lean();

    const businesses = await Business.find({
      workspaceId: { $in: settings.map((s) => s.workspaceId) },
    })
      .select('workspaceId name xeroIntegrated xeroTokens.refreshTokenExpiresAt')
      .lean();

    const byWorkspace = new Map(businesses.map((b) => [b.workspaceId, b]));

    res.json({
      clients: settings.map((s) => ({
        workspaceId: s.workspaceId,
        // Null, not the workspaceId, when there is no name: `name` is optional
        // on Business and a configured workspace may have no Business row at
        // all. Echoing the id back here would make a missing name look like a
        // client genuinely called `ws-...`, and leave the frontend no way to
        // tell the two apart. Deciding what to render instead is its job.
        name: byWorkspace.get(s.workspaceId)?.name || null,
        invoiceEnabled: Boolean(s.invoice?.enabled),
        statementEnabled: Boolean(s.statement?.enabled),
        provider: 'xero',
        connection: xeroConnectionStatus(byWorkspace.get(s.workspaceId), now),
      })),
    });
  } catch (err) {
    logError('SystemHealth', 'Client list failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not load clients' });
  }
});

/**
 * A 1-based page number, or null when the query string is unusable.
 *
 * Rejected rather than defaulted: `Number('abc')` is NaN, and NaN reaching
 * `.skip()` silently returns the first page, so a broken pager would look like
 * a working one.
 */
function parsePage(raw) {
  if (raw === undefined) return 1;
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1) return null;
  return page;
}

router.get('/workspace/:workspaceId', async (req, res) => {
  const page = parsePage(req.query.page);
  if (page === null) {
    res.status(400).json({ message: 'page must be a positive integer' });
    return;
  }

  try {
    const workspaceId = mongoEq(req.params.workspaceId);

    const [runs, total, schedules] = await Promise.all([
      AutomationRun.find({ workspaceId })
        // `_id` breaks the tie. One fan-out writes every row in a single
        // bulkWrite, so a workspace with more boards than a page can hold has
        // many rows sharing a startedAt to the millisecond. Sorting on that
        // alone leaves the order undefined between them, and an undefined
        // order across a skip/limit boundary silently repeats one run on page
        // two and drops another entirely.
        .sort({ startedAt: -1, _id: -1 })
        .skip((page - 1) * HISTORY_PAGE_SIZE)
        .limit(HISTORY_PAGE_SIZE)
        .lean(),
      AutomationRun.countDocuments({ workspaceId }),
      ScheduledJob.find({ targetId: workspaceId })
        .select('kind enabled nextRunAt lastRunAt lastError missedRuns consecutiveFailures timezone')
        .lean(),
    ]);

    res.json({
      workspaceId: req.params.workspaceId,
      schedules,
      runs,
      total,
      page,
      pageSize: HISTORY_PAGE_SIZE,
    });
  } catch (err) {
    logError('SystemHealth', 'Drill-down failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not load client detail' });
  }
});

router.post('/workspace/:workspaceId/run', async (req, res) => {
  const kind = KIND_FOR_BODY[req.body?.kind];
  if (!kind) {
    res.status(400).json({ message: 'kind must be "invoice" or "statement"' });
    return;
  }

  try {
    const workspaceId = mongoEq(req.params.workspaceId);
    const settings = await AutomationSettings.findOne({ workspaceId }).lean();
    const block = kind === KIND_INVOICE ? settings?.invoice : settings?.statement;

    if (!block?.enabled) {
      res.status(404).json({ message: 'No enabled automation for that kind' });
      return;
    }

    const boards = await Board.find({ workspaceId }).select('boardId').lean();
    const { specs, periodKey, existing } = await buildManualDispatch({
      kind,
      workspaceId: req.params.workspaceId,
      boards,
    });

    const force = req.query.force === '1';

    if (existing > 0 && !force) {
      const runs = await AutomationRun.find({ workspaceId, kind, periodKey }).lean();
      res.status(409).json({ error: 'already_run', periodKey, runs });
      return;
    }

    const toEnqueue = withForceJobIds({ specs, force, existing });
    await getAutomationQueue().addBulk(toEnqueue);
    await recordQueuedRuns({ specs: toEnqueue, trigger: TRIGGER_MANUAL });

    res.status(202).json({ enqueued: toEnqueue.length, periodKey });
  } catch (err) {
    logError('SystemHealth', 'Manual run failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not start the run' });
  }
});

/**
 * Every email one run produced, and what became of each.
 *
 * A separate request rather than part of the history page: 50 runs times their
 * messages would make the page that answers "what happened lately" pay for
 * detail an operator wants on one row at a time.
 */
router.get('/workspace/:workspaceId/runs/:runId/emails', async (req, res) => {
  try {
    const workspaceId = mongoEq(req.params.workspaceId);
    // Scoped by workspace as well as id, so a run id from another tenant is a
    // 404 rather than a read.
    const run = await AutomationRun.findOne({
      _id: mongoEq(req.params.runId),
      workspaceId,
    }).lean();

    if (!run) {
      res.status(404).json({ message: 'Run not found' });
      return;
    }

    res.json({ emails: await emailsForRun(run) });
  } catch (err) {
    logError('SystemHealth', 'Run emails failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not load the run\'s emails' });
  }
});

router.post('/workspace/:workspaceId/runs/:runId/retry', async (req, res) => {
  try {
    const run = await AutomationRun.findOne({
      _id: mongoEq(req.params.runId),
      workspaceId: mongoEq(req.params.workspaceId),
    }).lean();

    if (!run) {
      res.status(404).json({ message: 'No such run' });
      return;
    }

    // Retrying a success would bill twice; retrying a queued run would race
    // the worker already holding it.
    if (run.status !== RUN_FAILED) {
      res.status(409).json({ error: 'not_failed', status: run.status });
      return;
    }

    const spec = buildRetrySpec(run);
    // Enqueue first, then record: a run recorded for a job that never
    // reached the queue would sit `queued` forever with nothing to close it
    // (see services/scheduler/handlers.js for the same ordering).
    await getAutomationQueue().addBulk([spec]);
    await recordQueuedRuns({ specs: [spec], trigger: TRIGGER_MANUAL });

    res.status(202).json({ retried: String(run._id) });
  } catch (err) {
    logError('SystemHealth', 'Retry failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not retry the run' });
  }
});

export default router;
