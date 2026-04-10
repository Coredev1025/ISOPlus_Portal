import express from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth.js';
import { warn, info, error } from '../utils/logger.js';

const router = express.Router();

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Define your Log schema
const logSchema = new mongoose.Schema({
    message: String,
    level: String,
    timestamp: Date,
    metadata: Object,
});

// Create TTL index on timestamp field (default: 90 days, configurable via LOG_TTL_DAYS env var)
// TTL index automatically deletes documents older than the specified time
const ttlDays = parseInt(process.env.LOG_TTL_DAYS) || 7; // Default to 90 days
const ttlSeconds = ttlDays * 24 * 60 * 60; // Convert days to seconds

logSchema.index({ timestamp: 1 }, { expireAfterSeconds: ttlSeconds });
logSchema.index({ timestamp: -1, level: 1 });
logSchema.index({ 'metadata.source': 1, timestamp: -1 });

// Create a model from the schema
const Log = mongoose.model('Log', logSchema);

// Route to get logs
router.get('/', authenticateToken, async (req, res) => {
    try {
        if(req.user.role == 'isoplus_user') {
            warn('Log-Service', 'Unauthorized access', { email: req.user.email }, req ?? null);
            return res.status(403).json({ message: 'Unauthorized access' });
        }

        const {
            page = '1',
            limit = '50',
            search = '',
            level = '',
            source = '',
            sortBy = 'timestamp',
            sortOrder = 'desc'
        } = req.query;

        const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
        const limitNumber = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const skip = (pageNumber - 1) * limitNumber;

        const query = {};

        if (level && level !== 'all') {
            query.level = { $regex: new RegExp(`^${escapeRegex(level)}$`, 'i') };
        }

        if (source && source !== 'all') {
            query['metadata.source'] = { $regex: new RegExp(escapeRegex(source), 'i') };
        }

        if (search) {
            const safe = escapeRegex(search);
            const regex = new RegExp(safe, 'i');
            query.$or = [
                { message: regex },
                { 'metadata.source': regex }
            ];
        }

        // Build sort object for query (outside of aggregate)
        const sortField = sortBy === 'timestamp' ? 'timestamp' : 
                         sortBy === 'level' ? 'level' : 
                         sortBy === 'message' ? 'message' : 'timestamp'; // Default to timestamp
        
        const sortDirection = sortOrder === 'asc' ? 1 : -1; // Default to desc (newest first)
        const sortObject = { [sortField]: sortDirection };

        const [total, logs] = await Promise.all([
            Log.countDocuments(query),
            Log.find(query)
                .sort(sortObject)
                .skip(skip)
                .limit(limitNumber)
                .lean() // Use lean() for better performance
        ]);

        info('Log-Service', 'Logs fetched successfully', {
            count: logs.length,
            total,
            page: pageNumber,
            limit: limitNumber
        }, req ?? null);

        res.json({
            items: logs,
            total,
            page: pageNumber,
            limit: limitNumber,
            totalPages: Math.ceil(total / limitNumber) || 1
        });
    } catch (err) {
        error('Log-Service', 'Error fetching logs', { err }, req);
        res.status(500).json({ message: err.message });
    }
});

export default router;