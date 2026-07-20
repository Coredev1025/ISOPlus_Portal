import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import AuditTrail from '../models/AuditTrail.js';
import { info, error } from '../utils/logger.js';
import { pickAllowedSortField, toRequiredQueryString } from '../utils/securityHelpers.js';

const router = express.Router();

// GET all audit trails
router.get('/', authenticateToken, async (req, res) => {
    try {
        const workspaceId = toRequiredQueryString(req.query.workspaceId);
        if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });
        
        // Add pagination to reduce memory usage
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const skip = (page - 1) * limit;
        
        // Add sorting (default: newest first)
        const sortBy = pickAllowedSortField(req.query.sortBy, ['createdAt', 'action', 'userEmail'], 'createdAt');
        const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
        const sort = { [sortBy]: sortOrder };
        
        const [total, auditTrails] = await Promise.all([
            AuditTrail.countDocuments({ workspaceId }),
            AuditTrail.find({ workspaceId })
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .lean() // Use lean() for better performance
        ]);
        
        info('AuditTrail-Service', 'Audit trails fetched successfully', { 
            count: auditTrails.length, 
            total,
            page,
            limit 
        }, req ?? null);
        
        res.json({
            items: auditTrails,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1
        });
    } catch (err) {
        error('AuditTrail-Service', 'Error fetching audit trails', { err }, req);
        res.status(500).json({ message: err.message });
    }
});

// POST a new audit trail
router.post('/', authenticateToken, async (req, res) => {
    const auditTrail = new AuditTrail({
        workspaceId: toRequiredQueryString(req.body.workspaceId),
        action: toRequiredQueryString(req.body.action),
        detail: toRequiredQueryString(req.body.detail),
        userEmail: req.user.email,
        userIp: req.ip?.split(':').pop()
    });

    try {
        const newAuditTrail = await auditTrail.save();
        info('AuditTrail-Service', 'New Audit trail created', { auditTrailId: newAuditTrail._id }, req ?? null);
        res.status(201).json(newAuditTrail);
    } catch (err) {
        error('AuditTrail-Service', 'Error creating new Audit trail', { err, body: req.body }, req);
        res.status(400).json({ message: err.message });
    }
});

// PUT to update an audit trail by ID
router.put('/:id', authenticateToken, async (req, res) => {
    try {
        const id = toRequiredQueryString(req.params.id);
        const workspaceId = toRequiredQueryString(req.body.workspaceId);
        if (!id || !workspaceId) return res.status(400).json({ message: 'Invalid id or workspaceId' });
        const auditTrail = await AuditTrail.findOne({ _id: id, workspaceId });
        if (!auditTrail) {
            return res.status(404).json({ message: 'AuditTrail not found' });
        }

        auditTrail.action = toRequiredQueryString(req.body.action) || auditTrail.action;
        auditTrail.detail = toRequiredQueryString(req.body.detail) || auditTrail.detail;
        auditTrail.userEmail = toRequiredQueryString(req.body.userEmail) || auditTrail.userEmail;
        auditTrail.userIp = toRequiredQueryString(req.body.userIp) || auditTrail.userIp;

        const updatedAuditTrail = await auditTrail.save();
        info('AuditTrail-Service', 'Audit trail updated', { auditTrailId: updatedAuditTrail._id }, req ?? null);
        res.json(updatedAuditTrail);
    } catch (err) {
        error('AuditTrail-Service', 'Error updating Audit trail', { err, params: req.params, body: req.body }, req);
        res.status(400).json({ message: err.message });
    }
});

export default router;