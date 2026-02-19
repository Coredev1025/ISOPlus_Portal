import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Board from '../models/Board.js';
import TimeTrack from '../models/TimeTrack.js';
import { info, error, warn } from '../utils/logger.js';
import { getBoardAttributes, getAllViews } from '../services/isoplus.js';
import { enableBoardSync, disableBoardSync } from '../services/sync.js';
import { logAuditTrail } from '../utils/auditLogger.js';

const router = express.Router();

router.post('/', authenticateToken, async (req, res) => {
    try {
        const boardId = req.body.id?.toString();
        if (!boardId) return res.status(400).json({ message: 'Invalid boardId' });
        const existingBoard = await Board.findOne({ boardId }).lean();
        if (existingBoard) {
            warn('Board-Service', 'Board already exists', { boardId: req.body.boardId }, req ?? null);
            res.status(200).json({ board: existingBoard });
        } else {
            const newBoard = new Board({
                boardId: boardId,
                name: req.body.name || '',
                color: req.body.color || '',
                description: req.body.description || '',
                og_image: req.body.og_image || '',
            });
            await newBoard.save();
            await logAuditTrail({
                workspaceId: req.body.workspaceId?.toString(),
                boardId,
                action: 'Created new Board',
                detail: `Resource ID: ${newBoard._id}`,
                req,
                entityType: 'Board',
                entityId: newBoard._id?.toString(),
                success: true,
                statusCode: 200
            });
            info('Board-Service', 'New board created', { boardId: req.body.id }, req ?? null);
            res.status(200).json({ board: newBoard });
        }
    } catch (err) {
        error('Board-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/', authenticateToken, async (req, res) => {
    try {
        const boardId = req.query.id?.toString();
        if (!boardId) return res.status(400).json({ message: 'Invalid boardId' });
        const existingBoard = await Board.findOne({ boardId }).lean();

        if (existingBoard) {
            info('Board-Service', 'Successfully fetching board detail data', { boardId: req.query.id }, req ?? null);
            res.status(200).json({ board: existingBoard });
        } else {
            warn('Board-Service', 'Failed fetching board detail data', { boardId: req.query.id }, req ?? null);
            res.status(200).json({ message: 'Board not found' });
        }
    } catch (err) {
        error('Board-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

router.put('/', authenticateToken, async (req, res) => {
    try {
        const boardId = req.body.boardId?.toString();
        const workspaceId = req.body.workspaceId?.toString();
        if (!boardId || !workspaceId) return res.status(400).json({ message: 'Invalid boardId or workspaceId' });
        
        // Get current board state to check if syncData is changing
        const existingBoard = await Board.findOne({ boardId }).select('syncData').lean();
        const wasSyncEnabled = existingBoard?.syncData || false;
        const willSyncBeEnabled = req.body.syncData === true || req.body.syncData === 'true';
        
        // Update board configuration
        const result = await Board.updateOne({ boardId }, { $set: { ...req.body } }, { upsert: true });
        
        // Check if board was found and updated (matchedCount > 0) or created via upsert (upsertedCount > 0)
        if (result.matchedCount === 0 && result.upsertedCount === 0) {
            warn('Board-Service', 'Board not found and not created', { boardId: req.body.boardId }, req ?? null);
            return res.status(404).json({ message: 'Board not found' });
        }
        
        // Handle sync enable/disable
        let syncResult = null;
        
        // If sync is being enabled (was false, now true)
        if (!wasSyncEnabled && willSyncBeEnabled) {
            info('Board-Service', 'Sync enabled in board configuration, triggering sync job', { 
                boardId, 
                workspaceId 
            }, req ?? null);
            
            try {
                syncResult = await enableBoardSync(req.session.Authorization, workspaceId, boardId);
                
                if (syncResult.success) {
                    info('Board-Service', 'Sync job queued successfully', { 
                        boardId, 
                        workspaceId,
                        jobId: syncResult.jobId 
                    }, req ?? null);
                    
                    await logAuditTrail({ 
                        workspaceId, 
                        boardId,
                        action: 'Enabled Board Sync', 
                        detail: `Board sync enabled and validation job queued (Job ID: ${syncResult.jobId})`, 
                        req,
                        category: 'Sync',
                        entityType: 'Board',
                        entityId: boardId,
                        success: true
                    });
                } else {
                    warn('Board-Service', 'Sync job queue failed', { 
                        boardId, 
                        workspaceId,
                        reason: syncResult.message 
                    }, req ?? null);
                }
            } catch (syncErr) {
                error('Board-Service', 'Failed to enable sync', { 
                    boardId, 
                    workspaceId,
                    error: syncErr.message,
                    stack: syncErr.stack
                }, req ?? null);
                
                // Revert syncData to false if sync enablement failed
                await Board.updateOne({ boardId }, { $set: { syncData: false } });
                
                return res.status(500).json({ 
                    message: 'Board updated but sync enablement failed', 
                    error: syncErr.message,
                    board: await Board.findOne({ boardId }).lean()
                });
            }
        }
        
        // If sync is being disabled (was true, now false)
        if (wasSyncEnabled && !willSyncBeEnabled) {
            info('Board-Service', 'Sync disabled in board configuration', { 
                boardId, 
                workspaceId 
            }, req ?? null);
            
            try {
                syncResult = await disableBoardSync(boardId);
                
                info('Board-Service', 'Sync disabled successfully', { 
                    boardId, 
                    workspaceId 
                }, req ?? null);
                
                await logAuditTrail({ 
                    workspaceId, 
                    boardId,
                    action: 'Disabled Board Sync', 
                    detail: 'Board sync disabled and pending jobs cancelled', 
                    req,
                    category: 'Sync',
                    entityType: 'Board',
                    entityId: boardId,
                    success: true
                });
            } catch (syncErr) {
                error('Board-Service', 'Failed to disable sync', { 
                    boardId, 
                    workspaceId,
                    error: syncErr.message,
                    stack: syncErr.stack
                }, req ?? null);
            }
        }
        
        const updatedBoard = await Board.findOne({ boardId }).lean();
        
        info('Board-Service', 'Board updated', { 
            boardId: req.body.boardId, 
            label: req.body.label, 
            attributeId: req.body.attribute?.id, 
            pdfAttributeId: req.body.pdfAttribute?.id,
            syncData: updatedBoard.syncData,
            syncStatus: updatedBoard.syncStatus
        }, req ?? null);
        
        await logAuditTrail({ 
            workspaceId, 
            boardId,
            action: 'Updated Board', 
            detail: `Changed Board detail: ${req.body.label? "Label: " + req.body.label + ", " : ""}${req.body.attribute?.id? "Attribute ID: " + req.body.attribute.id + ", " : ""}${req.body.pdfAttribute?.id? "PDF Attribute ID: " + req.body.pdfAttribute.id : ""}`, 
            req,
            entityType: 'Board',
            entityId: boardId,
            success: true
        });
        
        res.status(200).json({ 
            board: updatedBoard,
            syncResult: syncResult 
        });
    } catch (err) {
        error('Board-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/attribute', authenticateToken, async (req, res) => {
    try {
        const attributes = await getBoardAttributes(req.query.workspaceId, req.query.boardId);
        const data = attributes.attribute.filter(item => item.type == "text" || item.type == "longtext");
        if (!data) {
            warn('Board-Service', 'Failed fetching board attribute data', { boardId: req.query.boardId }, req ?? null);
            return res.status(404).json({ message: 'Attribute not found' });
        }
        res.status(attributes.status).json({ attributes: data || [] });
    } catch (err) {
        error('Board-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/form', authenticateToken, async (req, res) => {
    try {
        const views = await getAllViews(req.session.Authorization, req.query.workspaceId, req.query.boardId);
        const data = views.views.filter(item => item.type == "form" && item.settings.formSettings.enabled);
        if (!data) {
            warn('Board-Service', 'Failed fetching board form data', { boardId: req.query.boardId }, req ?? null);
            return res.status(404).json({ message: 'Form not found' });
        }
        res.status(200).json({ views: data || [] });
    } catch (err) {
        error('Board-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

export default router;