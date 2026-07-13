import express from 'express';
import axios from 'axios';
import { authenticateToken } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { info, error, warn, debug } from '../utils/logger.js';
import { getAutomation, updateAutomation } from '../services/isoplus.js';
import { sanitizeApiPathSegment } from '../utils/securityHelpers.js';

const router = express.Router();

router.get('/:workspaceId/:boardId', authenticateToken, async (req, res) => {
    const workspaceId = sanitizeApiPathSegment(req.params.workspaceId, 'workspaceId');
    const boardId = sanitizeApiPathSegment(req.params.boardId, 'boardId');
    const automation = await getAutomation(workspaceId, boardId, req.session.Authorization);
    res.json(automation);
});

router.post('/:workspaceId/:boardId', authenticateToken, async (req, res) => {
    try {
        // Only Support Admin / Owner can create automations via the portal
        if (req.user.role !== 'owner' && req.user.role !== 'support_admin') {
            return res.status(403).json({ message: 'Access denied. Owner or Support Admin permission required.' });
        }
        const workspaceId = sanitizeApiPathSegment(req.params.workspaceId, 'workspaceId');
        const boardId = sanitizeApiPathSegment(req.params.boardId, 'boardId');
        const automation = req.body;
        let automationId = uuidv4();
        const existingAutomation = await getAutomation(workspaceId, boardId, req.session.Authorization);
        if (existingAutomation) {
            let existingAutomationIndex = existingAutomation.findIndex(automation => automation.id === automationId);
            while (existingAutomationIndex >= 0) {
                automationId = uuidv4();
                existingAutomationIndex = existingAutomation.findIndex(automation => automation.id === automationId);
            }
        }
        const safeWorkspaceId = encodeURIComponent(workspaceId);
        const safeAutomationId = encodeURIComponent(automationId);
        const automationUrl = `https://app.isoplus.online/api/${safeWorkspaceId}/automations/${safeAutomationId}`;
        const response = await axios.put(automationUrl, {
            ...automation,
            id: automationId
        }, {
            headers: {
                'Authorization': `Bearer ${req.session.Authorization}`
            }
        });
        info('Automation-Service', 'Automation created via ISO+ API', { workspaceId, boardId, automationId }, req ?? null);
        res.json(response.data);
    } catch (err) {
        error('Automation-Service', 'Failed to create automation', { err, workspaceId: req.params.workspaceId, boardId: req.params.boardId }, req);
        res.status(500).json({ error: 'Failed to update data', message: err.message });
    }
});

router.put('/:workspaceId/:boardId', authenticateToken, async (req, res) => {
    // Only Support Admin / Owner can update portal automations
    if (req.user.role !== 'owner' && req.user.role !== 'support_admin') {
        return res.status(403).json({ message: 'Access denied. Owner or Support Admin permission required.' });
    }
    const workspaceId = sanitizeApiPathSegment(req.params.workspaceId, 'workspaceId');
    const boardId = sanitizeApiPathSegment(req.params.boardId, 'boardId');
    const automation = await getAutomation(workspaceId, boardId, req.session.Authorization);
    if (!automation) {
        res.status(404).json({ error: 'Automation not found' });
        return;
    }
    
    let updatedAutomations = [];
    try {
        for (const automationItem of automation) {
            const { needsUpdate, automation: updatedAutomation } = buildUpdatedAutomation(
                automationItem,
                workspaceId,
                boardId
            );

            if (!needsUpdate) continue;

            debug('Automation-Service', 'Automation requires URL update', {
                name: automationItem.name,
                automationId: updatedAutomation.id,
            }, req ?? null);

            const result = await updateAutomation(
                workspaceId,
                boardId,
                automationItem.id,
                updatedAutomation,
                req.session.Authorization
            );
            if (result) {
                info('Automation-Service', 'Automation updated', {
                    workspaceId,
                    boardId,
                    automationId: updatedAutomation.id,
                }, req ?? null);
                updatedAutomations.push(result);
            } else {
                error('Automation-Service', 'Failed to update Automation', {
                    workspaceId,
                    boardId,
                    automationId: updatedAutomation.id,
                }, req ?? null);
            }
        }
        res.status(200).json(updatedAutomations);
    } catch (err) {
        error('Automation-Service', 'Failed to update Automations', { err, workspaceId, boardId }, req);
        res.status(500).json({ error: 'Failed to update Automations' });
    }
});

export default router;