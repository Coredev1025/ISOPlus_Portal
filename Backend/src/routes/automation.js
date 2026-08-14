import express from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

import { authenticateToken } from '../middleware/auth.js';
import { info, error, warn, debug, error as logError } from '../utils/logger.js';
import { getAutomation, updateAutomation } from '../services/isoplus.js';
import { sanitizeApiPathSegment, mongoEq } from '../utils/securityHelpers.js';
import { sanitizeLogValue } from '../utils/sanitizeLog.js';
import { buildUpdatedAutomation } from '../utils/automationUrlUpdate.js';
import AutomationRun from '../models/AutomationRun.js';
import AutomationSettings from '../models/AutomationSettings.js';
import ScheduledJob from '../models/ScheduledJob.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../services/automation/fanOut.js';
import { CLIENT_PANEL_RUN_LIMIT } from '../constants/systemHealth.js';

const router = express.Router();

const isoPlusApi = axios.create({
    baseURL: 'https://app.isoplus.online',
    timeout: 30000
});

/**
 * The client-facing half of Visibility & Monitoring.
 *
 * Separate from /api/system-health deliberately: that router is admin-only and
 * returns every client, and one shared handler with a role branch is how a
 * scoping bug eventually ships.
 *
 * Declared above /:workspaceId/:boardId: Express matches routes in
 * declaration order, and that route would otherwise capture "status" as a
 * boardId.
 */
router.get('/:workspaceId/status', authenticateToken, async (req, res) => {
  try {
    const workspaceId = mongoEq(req.params.workspaceId);

    const [settings, schedules, runs] = await Promise.all([
      AutomationSettings.findOne({ workspaceId }).lean(),
      ScheduledJob.find({ targetId: workspaceId }).select('kind nextRunAt enabled').lean(),
      AutomationRun.find({ workspaceId })
        .sort({ startedAt: -1 })
        .limit(CLIENT_PANEL_RUN_LIMIT)
        .lean(),
    ]);

    const nextRunFor = (kind) =>
      schedules.find((s) => s.kind === kind && s.enabled)?.nextRunAt ?? null;
    const lastStatusFor = (kind) => runs.find((r) => r.kind === kind)?.status ?? null;

    res.json({
      invoice: {
        enabled: Boolean(settings?.invoice?.enabled),
        nextRun: nextRunFor(KIND_INVOICE),
        lastStatus: lastStatusFor(KIND_INVOICE),
      },
      statement: {
        enabled: Boolean(settings?.statement?.enabled),
        nextRun: nextRunFor(KIND_STATEMENT),
        lastStatus: lastStatusFor(KIND_STATEMENT),
      },
      runs,
      // Drives the panel's "Email delivery is not enabled yet" section. A
      // literal until Epic 5.6/5.7 lands, and then a real check.
      deliveryEnabled: false,
    });
  } catch (err) {
    logError('Automation', 'Status failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not load automation status' });
  }
});

router.get('/:workspaceId/:boardId', authenticateToken, async (req, res) => {
    try {
        const workspaceId = sanitizeApiPathSegment(
            req.params.workspaceId,
            'workspaceId'
        );

        const boardId = sanitizeApiPathSegment(
            req.params.boardId,
            'boardId'
        );

        const automation = await getAutomation(
            workspaceId,
            boardId,
            req.session.Authorization
        );

        res.json(automation);
    } catch (err) {
        error(
            'Automation-Service',
            'Failed to retrieve automation',
            sanitizeLogValue({
                message: err.message,
                stack: err.stack
            }),
            req ?? null
        );

        res.status(500).json({
            error: 'Failed to retrieve automation'
        });
    }
});

router.put('/:workspaceId/:boardId', authenticateToken, async (req, res) => {
    try {
        if (
            req.user.role !== 'owner' &&
            req.user.role !== 'support_admin'
        ) {
            return res.status(403).json({
                message:
                    'Access denied. Owner or Support Admin permission required.'
            });
        }

        const workspaceId = sanitizeApiPathSegment(
            req.params.workspaceId,
            'workspaceId'
        );

        const boardId = sanitizeApiPathSegment(
            req.params.boardId,
            'boardId'
        );

        const automation = await getAutomation(
            workspaceId,
            boardId,
            req.session.Authorization
        );

        if (!automation) {
            return res.status(404).json({
                error: 'Automation not found'
            });
        }

        const updatedAutomations = [];

        for (const automationItem of automation) {
            const {
                needsUpdate,
                automation: updatedAutomation
            } = buildUpdatedAutomation(
                automationItem,
                workspaceId,
                boardId
            );

            if (!needsUpdate) {
                continue;
            }

            debug(
                'Automation-Service',
                'Automation requires URL update',
                sanitizeLogValue({
                    name: automationItem.name,
                    automationId: updatedAutomation.id
                }),
                req ?? null
            );

            const result = await updateAutomation(
                workspaceId,
                boardId,
                automationItem.id,
                updatedAutomation,
                req.session.Authorization
            );

            if (result) {
                info(
                    'Automation-Service',
                    'Automation updated',
                    sanitizeLogValue({
                        workspaceId,
                        boardId,
                        automationId: updatedAutomation.id
                    }),
                    req ?? null
                );

                updatedAutomations.push(result);
            } else {
                warn(
                    'Automation-Service',
                    'Failed to update automation',
                    sanitizeLogValue({
                        workspaceId,
                        boardId,
                        automationId: updatedAutomation.id
                    }),
                    req ?? null
                );
            }
        }

        res.status(200).json(updatedAutomations);
    } catch (err) {
        error(
            'Automation-Service',
            'Failed to update automations',
            sanitizeLogValue({
                workspaceId: req.params.workspaceId,
                boardId: req.params.boardId,
                message: err.message,
                stack: err.stack
            }),
            req ?? null
        );

        res.status(500).json({
            error: 'Failed to update automations'
        });
    }
});

export default router;