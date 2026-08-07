import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Board from '../models/Board.js';
import TimeTrack from '../models/TimeTrack.js';
import { info, error, warn } from '../utils/logger.js';
import { getBoardAttributes, getAllViews, getItemValues, ITEM_DELETED } from '../services/isoplus.js';
import { isOfflineMode, getBoardAttributesOffline } from '../services/offlineIsoplus.js';

const slugify = (str) => (str || '').toString().toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '');

const getValueFromItem = (item, attrName) => {
    const entry = item?.values?.find(v => v?.attribute?.name === attrName);
    if (!entry || entry.data == null) return null;
    const d = entry.data;
    if (typeof d === 'object' && d?.name) return String(d.name);
    return String(d);
};
import { logAuditTrail } from '../utils/auditLogger.js';
import { toRequiredQueryString, toMongoQueryValue } from '../utils/securityHelpers.js';
import {
  handleBoardSyncDisable,
  handleBoardSyncEnable,
  parseSyncToggle,
  revertBoardSyncFlag,
} from '../utils/boardSyncActions.js';

const router = express.Router();

function pickBoardAttribute(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const attribute = {};
  const id = value.id != null ? toMongoQueryValue(value.id) : undefined;
  const name = value.name != null ? toMongoQueryValue(value.name) : undefined;
  if (id != null) attribute.id = id;
  if (name != null) attribute.name = name;
  return Object.keys(attribute).length > 0 ? attribute : undefined;
}

function buildBoardUpdatePayload(body) {
  const payload = {};
  const stringFields = [
    'name', 'description', 'color', 'og_image', 'label',
    'timeTrackStartAttributeId', 'timeTrackEndAttributeId',
  ];

  for (const field of stringFields) {
    if (body[field] !== undefined) {
      payload[field] = toMongoQueryValue(body[field]) ?? '';
    }
  }

  if (body.boardId !== undefined) {
    payload.boardId = toMongoQueryValue(body.boardId);
  }
  if (body.workspaceId !== undefined) {
    payload.workspaceId = toMongoQueryValue(body.workspaceId);
  }
  if (body.syncData !== undefined) {
    payload.syncData = body.syncData === true || body.syncData === 'true';
  }

  const attribute = pickBoardAttribute(body.attribute);
  if (attribute) payload.attribute = attribute;

  const pdfAttribute = pickBoardAttribute(body.pdfAttribute);
  if (pdfAttribute) payload.pdfAttribute = pdfAttribute;

  return payload;
}

router.post('/', authenticateToken, async (req, res) => {
    try {
        // Only Support Admin / Owner can create boards in portal DB
        if (req.user.role !== 'support_admin' && req.user.role !== 'owner') {
            warn('Board-Service', 'Access denied creating board', { userId: req.user.userId, role: req.user.role }, req ?? null);
            return res.status(403).json({ message: 'Access denied. Owner or Support Admin permission required.' });
        }
        const boardId = toRequiredQueryString(req.body.id);
        if (!boardId) return res.status(400).json({ message: 'Invalid boardId' });
        const existingBoard = await Board.findOne({ boardId: { $eq: String(boardId) } }).lean();
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
        const boardId = toRequiredQueryString(req.query.id);
        if (!boardId) return res.status(400).json({ message: 'Invalid boardId' });
        const existingBoard = await Board.findOne({ boardId: { $eq: String(boardId) } }).lean();

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
        // Only Support Admin / Owner can update board configuration (label, sync, attributes)
        if (req.user.role !== 'support_admin' && req.user.role !== 'owner') {
            warn('Board-Service', 'Access denied updating board', { userId: req.user.userId, role: req.user.role, boardId: req.body.boardId }, req ?? null);
            return res.status(403).json({ message: 'Access denied. Owner or Support Admin permission required.' });
        }
        const boardId = toRequiredQueryString(req.body.boardId);
        const workspaceId = toRequiredQueryString(req.body.workspaceId);
        if (!boardId || !workspaceId) return res.status(400).json({ message: 'Invalid boardId or workspaceId' });
        
        // Get current board state to check if syncData is changing
        const existingBoard = await Board.findOne({ boardId: { $eq: String(boardId) } }).select('syncData').lean();
        const { wasSyncEnabled, willSyncBeEnabled } = parseSyncToggle(req.body, existingBoard);
        
        const boardUpdate = buildBoardUpdatePayload(req.body);
        const result = await Board.updateOne({ boardId: { $eq: String(boardId) } }, { $set: boardUpdate }, { upsert: true });
        
        if (result.matchedCount === 0 && result.upsertedCount === 0) {
            warn('Board-Service', 'Board not found and not created', { boardId: req.body.boardId }, req ?? null);
            return res.status(404).json({ message: 'Board not found' });
        }
        
        let syncResult = null;
        
        if (!wasSyncEnabled && willSyncBeEnabled) {
            try {
                ({ syncResult } = await handleBoardSyncEnable({ req, workspaceId, boardId }));
            } catch (syncErr) {
                error('Board-Service', 'Failed to enable sync', { 
                    boardId, 
                    workspaceId,
                    error: syncErr.message,
                    stack: syncErr.stack
                }, req ?? null);
                
                await revertBoardSyncFlag(boardId);
                
                return res.status(500).json({ 
                    message: 'Board updated but sync enablement failed', 
                    error: syncErr.message,
                    board: await Board.findOne({ boardId: { $eq: String(boardId) } }).lean()
                });
            }
        }
        
        if (wasSyncEnabled && !willSyncBeEnabled) {
            ({ syncResult } = await handleBoardSyncDisable({ req, workspaceId, boardId }));
        }
        
        const updatedBoard = await Board.findOne({ boardId: { $eq: String(boardId) } }).lean();
        
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
        const fetchAttributes = isOfflineMode() ? getBoardAttributesOffline : getBoardAttributes;
        const attributes = await fetchAttributes(req.query.workspaceId, req.query.boardId);

        // getBoardAttributes() returns { message, status } with NO `attribute`
        // key when the ISO+ call throws, so reading .attribute directly turned
        // every upstream failure into a TypeError and an opaque 500. Surface the
        // real status instead.
        if (!Array.isArray(attributes?.attribute)) {
            warn('Board-Service', 'Failed fetching board attribute data', {
                boardId: req.query.boardId,
                status: attributes?.status,
                message: attributes?.message,
            }, req ?? null);
            return res.status(attributes?.status === 200 ? 404 : (attributes?.status || 502)).json({
                message: attributes?.message || 'Attribute not found',
            });
        }

        const data = attributes.attribute.filter(item => item.type == "text" || item.type == "longtext");
        res.status(attributes.status).json({ attributes: data });
    } catch (err) {
        error('Board-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/views-for-qr', authenticateToken, async (req, res) => {
    try {
        const views = await getAllViews(req.session.Authorization, req.query.workspaceId, req.query.boardId);
        const sharedForms = (views.views || [])
            .filter(item => item.type === 'form' && item.settings?.formSettings?.enabled)
            .map(item => ({
                id: item.id,
                name: item.name,
                url: `https://app.isoplus.online/form/${item.id}`,
                type: item.type
            }));
        let sharedDocuments = [];
        const publicDocumentIds = (views.views || [])
            .filter(item => item.type === 'document')
            .flatMap(item =>
                Object.entries(item.settings?.editorItems || {})
                    .filter(([, entry]) => entry?.public === true)
                    .map(([editorItemKey]) => ({
                        id: editorItemKey,
                        viewId: item.id,
                        type: item.type
                    }))
            );
        
        for (const documentId of publicDocumentIds) {
            const documentValues = await getItemValues(req.query.workspaceId, req.query.boardId, documentId.id);
            if (documentValues && documentValues !== ITEM_DELETED) {
                const name = getValueFromItem(documentValues, 'Name') || getValueFromItem(documentValues, 'Document') || getValueFromItem(documentValues, 'Documents') || getValueFromItem(documentValues, 'Document Title') || getValueFromItem(documentValues, 'Communication Topic');
                const slug = slugify(name) || '';
                const last5 = documentId.id.toString().slice(-5);
                sharedDocuments.push({
                    id: documentId.id,
                    name: name || 'Unnamed',
                    url: `https://app.isoplus.online/p/i${req.query.workspaceId}-${documentId.viewId}/${slug? slug + '-' : ''}${last5}`,
                    type: documentId.type,
                });
            }
        }

        const combined = [...sharedForms, ...sharedDocuments].sort((a, b) =>
            (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
        );

        res.status(200).json({ views: combined });
    } catch (err) {
        error('Board-Service', 'Server error', { message: err.message, stack: err.stack }, req ?? null);
        res.status(500).json({ message: 'Server error' });
    }
});

export default router;