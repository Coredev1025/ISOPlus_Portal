import express from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

import { authenticateToken } from '../middleware/auth.js';
import { info, error, warn, debug } from '../utils/logger.js';
import { getAutomation, updateAutomation } from '../services/isoplus.js';
import { sanitizeApiPathSegment, buildIsoPlusAutomationUrl } from '../utils/securityHelpers.js';
import { sanitizeLogValue } from '../utils/sanitizeLog.js';
import { buildUpdatedAutomation } from '../utils/automationUrlUpdate.js';

const router = express.Router();

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

router.post('/:workspaceId/:boardId', authenticateToken, async (req, res) => {
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

        const automation = req.body;

        let automationId = uuidv4();

        const existingAutomation = await getAutomation(
            workspaceId,
            boardId,
            req.session.Authorization
        );

        if (existingAutomation) {
            let existingAutomationIndex = existingAutomation.findIndex(
                item => item.id === automationId
            );

            while (existingAutomationIndex >= 0) {
                automationId = uuidv4();

                existingAutomationIndex = existingAutomation.findIndex(
                    item => item.id === automationId
                );
            }
        }

        const response = await axios.put(
            buildIsoPlusAutomationUrl(workspaceId, automationId),
            {
                ...automation,
                id: automationId
            },
            {
                headers: {
                    Authorization: `Bearer ${req.session.Authorization}`
                },
                timeout: 30000
            }
        );

        info(
            'Automation-Service',
            'Automation created via ISO+ API',
            sanitizeLogValue({
                workspaceId,
                boardId,
                automationId
            }),
            req ?? null
        );

        res.json(response.data);
    } catch (err) {
        error(
            'Automation-Service',
            'Failed to create automation',
            sanitizeLogValue({
                workspaceId: req.params.workspaceId,
                boardId: req.params.boardId,
                message: err.message,
                stack: err.stack
            }),
            req ?? null
        );

        res.status(500).json({
            error: 'Failed to update data',
            message: err.message
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