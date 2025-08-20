import express from 'express';
import axios from 'axios';
import { authenticateToken } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { info, error } from '../utils/logger.js';
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
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update data' });
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
                console.log("needsUpdate", automationItem.name);
            }
            
            if (needsUpdate && updatedAutomation.workflow && Array.isArray(updatedAutomation.workflow)) {
                updatedAutomation.workflow = updatedAutomation.workflow.map(workflow => {
                    if (workflow.config && workflow.config.url) {
                        let updatedUrl = workflow.config.url;
                        
                        const urlPattern = /\/api\/([^\/]+)\/([^\/]+)\/([^\/\?]+)/;
                        const match = updatedUrl.match(urlPattern);
                        
                        if (match) {
                            const apiPath = match[1];
                            const currentWorkspaceId = match[2];
                            const currentBoardId = match[3];
                            
                            updatedUrl = updatedUrl.replace(
                                new RegExp(`/api/${apiPath}/${currentWorkspaceId}/${currentBoardId}`),
                                `/api/${apiPath}/${workspaceId}/${boardId}`
                            );
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
                    info('Automation-Service', 'Automation updated', { workspaceId, boardId, automationId: updatedAutomation.id }, req);
                    updatedAutomations.push(result);
                } else {
                    error('Automation-Service', 'Failed to update Automation', { workspaceId, boardId, automationId: updatedAutomation.id }, req);
                }
            } 
        }
        res.status(200).json(updatedAutomations);
    } catch (err) {
        error('Automation-Service', 'Failed to update Automations', { error: err }, req);
        res.status(500).json({ error: 'Failed to update Automations' });
    }
});

export default router;