import express from 'express';

import AutomationRun from '../models/AutomationRun.js';
import AutomationSettings from '../models/AutomationSettings.js';
import Business from '../models/Business.js';
import SchedulerHealth from '../models/SchedulerHealth.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireOwnerOrSupport } from '../middleware/requireOwnerOrSupport.js';
import { summariseRuns } from '../utils/automationRunMetrics.js';
import { xeroConnectionStatus } from '../utils/automationConnectionStatus.js';
import { readQueueDepth } from '../services/automation/queueMetrics.js';
import { ERROR_RATE_WINDOW_HOURS } from '../constants/systemHealth.js';
import { error as logError } from '../utils/logger.js';

const router = express.Router();

router.use(authenticateToken, requireOwnerOrSupport);

/** Workspaces with at least one automation block enabled. */
function enabledWorkspaceFilter() {
  return { $or: [{ 'invoice.enabled': true }, { 'statement.enabled': true }] };
}

router.get('/overview', async (req, res) => {
  try {
    const now = new Date();
    // One week back covers every figure summariseRuns computes, so the route
    // makes a single query rather than one per window.
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [rows, activeAutomations, queue, health] = await Promise.all([
      AutomationRun.find({ startedAt: { $gte: from } }).select('status startedAt').lean(),
      AutomationSettings.countDocuments(enabledWorkspaceFilter()),
      readQueueDepth(),
      SchedulerHealth.findOne({}).select('lastTickAt').lean(),
    ]);

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
    });
  } catch (err) {
    logError('SystemHealth', 'Overview failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not load system health' });
  }
});

router.get('/clients', async (req, res) => {
  try {
    const settings = await AutomationSettings.find(enabledWorkspaceFilter())
      .select('workspaceId invoice.enabled statement.enabled')
      .lean();

    const businesses = await Business.find({
      workspaceId: { $in: settings.map((s) => s.workspaceId) },
    })
      .select('workspaceId xeroIntegrated xeroTokens.refreshTokenExpiresAt')
      .lean();

    const byWorkspace = new Map(businesses.map((b) => [b.workspaceId, b]));

    res.json({
      clients: settings.map((s) => ({
        workspaceId: s.workspaceId,
        invoiceEnabled: Boolean(s.invoice?.enabled),
        statementEnabled: Boolean(s.statement?.enabled),
        provider: 'xero',
        connection: xeroConnectionStatus(byWorkspace.get(s.workspaceId)),
      })),
    });
  } catch (err) {
    logError('SystemHealth', 'Client list failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not load clients' });
  }
});

export default router;
