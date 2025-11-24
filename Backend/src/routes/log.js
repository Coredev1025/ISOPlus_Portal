import express from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth.js';
import { warn, info, error, extractContextFromReq } from '../utils/logger.js';

const router = express.Router();

// Define your Log schema
const logSchema = new mongoose.Schema({
    message: String,
    level: String,
    timestamp: Date,
    metadata: Object,
});

// Create a model from the schema
const Log = mongoose.model('Log', logSchema);

// Route to get logs
router.get('/', authenticateToken, async (req, res) => {
    try {
        if(req.user.role == 'isoplus_user') {
            warn('Log-Service', 'Unauthorized access', { email: req.user.email }, extractContextFromReq(req));
            return res.status(403).json({ message: 'Unauthorized access' });
        }

        const {
            page = '1',
            limit = '50',
            search = '',
            level = '',
            source = ''
        } = req.query;

        const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
        const limitNumber = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const skip = (pageNumber - 1) * limitNumber;

        const query = {};

        if (level && level !== 'all') {
            query.level = { $regex: new RegExp(`^${level}$`, 'i') };
        }

        if (source && source !== 'all') {
            query['metadata.source'] = { $regex: new RegExp(source, 'i') };
        }

        if (search) {
            const regex = new RegExp(search, 'i');
            query.$or = [
                { message: regex },
                { 'metadata.source': regex }
            ];
        }

        const [total, logs] = await Promise.all([
            Log.countDocuments(query),
            Log.aggregate([
                { $match: query },
                { $skip: skip },
                { $limit: limitNumber }
            ], { allowDiskUse: true })
        ]);

        info('Log-Service', 'Logs fetched successfully', {
            count: logs.length,
            total,
            page: pageNumber,
            limit: limitNumber
        }, extractContextFromReq(req));

        res.json({
            items: logs,
            total,
            page: pageNumber,
            limit: limitNumber,
            totalPages: Math.ceil(total / limitNumber) || 1
        });
    } catch (err) {
        error('Log-Service', 'Error fetching logs', { error: err.message }, extractContextFromReq(req));
        res.status(500).json({ message: err.message });
    }
});

export default router;