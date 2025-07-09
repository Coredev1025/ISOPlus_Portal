import express from 'express';
import axios from 'axios';
import { authenticateToken } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { info, error } from '../utils/logger.js';

const router = express.Router();

const getAutomation = async (workspaceId, boardId, authorization) => {
    try {
        const response = await axios.get(`https://app.isoplus.online/api/${workspaceId}/automations/${boardId}`, {
            headers: {
                'Authorization': `${authorization}`
            }
        });
        return response.data;
    } catch (error) {
        return null;
    }
}

const updateAutomation = async (workspaceId, boardId, automationId, automation, authorization) => {
    try {
        let existingAutomation = await getAutomation(workspaceId, boardId, authorization);
        if (!existingAutomation) {
            return null;
        }
        let existingAutomationIndex = existingAutomation.findIndex(automation => automation.id === automationId);
        if (existingAutomationIndex < 0) {
            res.status(404).json({ error: 'Automation not found' });
            return;
        }

        const response = await axios.put(`https://app.isoplus.online/api/${workspaceId}/automations/${automationId}`, automation, {
            headers: {
                'Authorization': `${authorization}`
            }
        });
        console.log(response.data);
        return response.data;
    } catch (error) {
        return null;
    }
}

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
        console.log(response.data);
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
            
            // Check if automation has workflow and update URLs containing "portal-"
            if (updatedAutomation.workflow && Array.isArray(updatedAutomation.workflow)) {
                updatedAutomation.workflow = updatedAutomation.workflow.map(workflow => {
                    if (workflow.config && workflow.config.url && needsUpdate) {
                        // Update the portal URL to use current workspace and board IDs
                        let updatedUrl = workflow.config.url;
                        
                        // Extract and replace the workspace ID and board ID in the URL
                        // Pattern: /api/something/workspaceId/boardId/rest-of-path
                        const urlPattern = /\/api\/([^\/]+)\/([^\/]+)\/([^\/\?]+)/;
                        const match = updatedUrl.match(urlPattern);
                        
                        if (match) {
                            const apiPath = match[1]; // e.g., "care-management-ndis-pricing"
                            const currentWorkspaceId = match[2]; // current workspace ID in URL
                            const currentBoardId = match[3]; // current board ID in URL
                            
                            // Replace the workspace and board IDs with current ones
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
            
            // Update the automation with incremented row_version
            updatedAutomation.row_version = (updatedAutomation.row_version || 0) + 1;
            
            // Only update if there are changes (portal URL updates or status change)
            console.log("updatedAutomation", updatedAutomation);
            if (needsUpdate) {
                const result = await updateAutomation(workspaceId, boardId, automationItem.id, updatedAutomation, req.session.Authorization);
                if (result) {
                    updatedAutomations.push(result);
                } else {
                    updatedAutomations.push(updatedAutomation);
                }
            } else {
                updatedAutomations.push(updatedAutomation);
            }
        }
    } catch (err) {
        error('Automation-Service', 'Failed to update Automations', { error: err }, req);
        res.status(500).json({ error: 'Failed to update Automations' });
    }
    info('Automation-Service', 'Automations updated', { updatedAutomations: updatedAutomations }, req);
    res.json(updatedAutomations);
});

export default router;