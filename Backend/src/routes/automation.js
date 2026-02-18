import express from 'express';
import axios from 'axios';
import { authenticateToken } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { info, error, warn, debug, extractContextFromReq } from '../utils/logger.js';
import { getAutomation, updateAutomation } from '../services/isoplus.js';

const router = express.Router();

router.get('/:workspaceId/:boardId', authenticateToken, async (req, res) => {
    const automation = await getAutomation(req.params.workspaceId, req.params.boardId, req.session.Authorization);
    res.json(automation);
});

router.post('/:workspaceId/:boardId', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        const automation = req.body;
        let automationId = uuidv4();
        const existingAutomation = await getAutomation(req.params.workspaceId, req.params.boardId, req.session.Authorization);
        if (existingAutomation) {
            let existingAutomationIndex = existingAutomation.findIndex(automation => automation.id === automationId);
            while (existingAutomationIndex >= 0) {
                automationId = uuidv4();
                existingAutomationIndex = existingAutomation.findIndex(automation => automation.id === automationId);
            }
        }
        const response = await axios.put(`https://app.isoplus.online/api/${workspaceId}/automations/${automationId}`, {
            ...automation,
            id: automationId
        }, {
            headers: {
                'Authorization': `Bearer ${req.session.Authorization}`
            }
        });
        info('Automation-Service', 'Automation created via ISO+ API', { workspaceId, boardId, automationId }, extractContextFromReq(req));
        res.json(response.data);
    } catch (err) {
        error('Automation-Service', 'Failed to create automation', { err, workspaceId: req.params.workspaceId, boardId: req.params.boardId }, req);
        res.status(500).json({ error: 'Failed to update data', message: err.message });
    }
});

router.put('/:workspaceId/:boardId', authenticateToken, async (req, res) => {
    const { workspaceId, boardId } = req.params;
    const automation = await getAutomation(workspaceId, boardId, req.session.Authorization);
    if (!automation) {
        res.status(404).json({ error: 'Automation not found' });
        return;
    }
    
    let updatedAutomations = [];
    try {
        for (const automationItem of automation) {
            let updatedAutomation = { ...automationItem };
            let needsUpdate = automationItem.name.startsWith("Portal - ");

            if (needsUpdate) {
                debug('Automation-Service', 'Automation requires URL update', { name: automationItem.name, automationId: updatedAutomation.id }, extractContextFromReq(req));
            }
            
            if (needsUpdate && updatedAutomation.workflow && Array.isArray(updatedAutomation.workflow)) {
                updatedAutomation.workflow = updatedAutomation.workflow.map(workflow => {
                    if (workflow.config && workflow.config.url) {
                        let updatedUrl = workflow.config.url;
                        
                        const urlPattern = /https?:\/\/([^\/]+)\/api\/([^\/]+)\/([^\/]+)\/([^\/\?]+)/;
                        const match = updatedUrl.match(urlPattern);
                        
                        if (match) {
                            if (process.env.BACKEND_URL) {
                                const backendUrl = match[1];
                                const apiPath = match[2];
                                const currentWorkspaceId = match[3];
                                const currentBoardId = match[4];

                                const backendUrlWithoutProtocol = process.env.BACKEND_URL.replace(/^https?:\/\//, '');

                                updatedUrl = updatedUrl.replace(
                                    new RegExp(`${backendUrl}/api/${apiPath}/${currentWorkspaceId}/${currentBoardId}`),
                                    `${backendUrlWithoutProtocol}/api/${apiPath}/${workspaceId}/${boardId}`
                                );
                            } else {
                                warn('Automation-Service', 'BACKEND_URL not found in your environment variables', { workspaceId, boardId, automationId: updatedAutomation.id }, extractContextFromReq(req));
                            }
                        }
                        
                        return {
                            ...workflow,
                            config: {
                                ...workflow.config,
                                url: updatedUrl
                            }
                        };
                    }
                    return workflow;
                });
            }
            
            if (needsUpdate) {
                const result = await updateAutomation(workspaceId, boardId, automationItem.id, updatedAutomation, req.session.Authorization);
                if (result) {
                    info('Automation-Service', 'Automation updated', { workspaceId, boardId, automationId: updatedAutomation.id }, extractContextFromReq(req));
                    updatedAutomations.push(result);
                } else {
                    error('Automation-Service', 'Failed to update Automation', { workspaceId, boardId, automationId: updatedAutomation.id }, extractContextFromReq(req));
                }
            }
        }
        res.status(200).json(updatedAutomations);
    } catch (err) {
        error('Automation-Service', 'Failed to update Automations', { err, workspaceId, boardId }, req);
        res.status(500).json({ error: 'Failed to update Automations' });
    }
});

export default router;