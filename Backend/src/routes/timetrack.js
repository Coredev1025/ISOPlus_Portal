import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { putTimeTracking } from '../services/isoplus.js';
import { info, error, warn } from '../utils/logger.js';
import TimeTrack from '../models/TimeTrack.js';
import Item from '../models/Item.js';

const router = express.Router();

function computeDuration(start, end) {
    return Math.floor((end - start) / 1000);
}

function resolveItemName(itemData, fallbackId) {
    if (!itemData) return fallbackId;
    if (typeof itemData._primaryValue === 'string' && itemData._primaryValue) return itemData._primaryValue;
    const nameFields = ['Name', 'Task Name', 'Title', 'Participant Full Name', 'Client', 'Worker'];
    for (const key of nameFields) {
        const v = itemData[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return fallbackId;
}

router.get('/tasks', authenticateToken, async (req, res) => {
    const { workspaceId, boardId } = req.query;
    if (!workspaceId || !boardId) {
        return res.status(400).json({ message: 'workspaceId and boardId are required' });
    }
    try {
        const items = await Item.find(
            {
                workspaceId,
                boardId,
                $or: [
                    { 'data._hasTimeTracking': true },
                    { 'data._timeTrackingAttributeId': { $exists: true } },
                    { 'data.Time Tracking': { $exists: true } }
                ]
            },
            { itemId: 1, data: 1 }
        ).lean();

        const tasks = items.map(item => {
            const lat = item.data?.['Job Location Lat'];
            const lng = item.data?.['Job Location Lng'];
            return {
                id: item.itemId,
                name: resolveItemName(item.data, item.itemId),
                location: lat && lng
                    ? {
                        latitude: parseFloat(lat),
                        longitude: parseFloat(lng),
                        address: item.data?.['Job Location'] || ''
                    }
                    : undefined
            };
        });

        res.status(200).json({ tasks });
    } catch (err) {
        error('TimeTrack-Service', 'Failed to fetch time-tracking tasks', { err }, req);
        res.status(500).json({ message: err.message });
    }
});

router.get('/status', authenticateToken, async (req, res) => {
    const { workspaceId, boardId } = req.query;
    if (!workspaceId || !boardId) {
        return res.status(400).json({ message: 'workspaceId and boardId are required' });
    }
    try {
        const active = await TimeTrack.findOne({
            workspaceId,
            boardId,
            User: req.user.email,
            ended_at: null
        }).lean();

        if (!active) {
            return res.status(200).json({ active: null });
        }

        let taskName = active.Task;
        if (active.itemId) {
            const item = await Item.findOne({ itemId: active.itemId }, { data: 1 }).lean();
            if (item) {
                taskName = resolveItemName(item.data, taskName);
            }
        }

        res.status(200).json({
            active: {
                id: active._id,
                taskName,
                itemId: active.itemId,
                startTime: active.started_at ?? active.StartTime,
                location: active.Location?.lat
                    ? { lat: active.Location.lat, lng: active.Location.lng, address: active.Location.address }
                    : null,
                notes: active.notes
            }
        });
    } catch (err) {
        error('TimeTrack-Service', 'Failed to fetch active status', { err }, req);
        res.status(500).json({ message: err.message });
    }
});

router.get('/', authenticateToken, async (req, res) => {
    const { workspaceId, boardId } = req.query;
    if (!workspaceId || !boardId) {
        return res.status(400).json({ message: 'workspaceId and boardId are required' });
    }
    try {
        const entries = await TimeTrack.find(
            { workspaceId, boardId },
            null,
            { sort: { started_at: -1 } }
        ).lean();

        const itemIds = [...new Set(entries.map(e => e.itemId).filter(Boolean))];
        const items = itemIds.length > 0
            ? await Item.find({ itemId: { $in: itemIds } }, { itemId: 1, data: 1 }).lean()
            : [];
        const itemMap = Object.fromEntries(items.map(i => [i.itemId, i.data]));

        const tasks = entries.map(entry => {
            const itemData = itemMap[entry.itemId];
            const taskName = resolveItemName(itemData, entry.Task);
            return {
                id: entry._id,
                taskName,
                itemId: entry.itemId,
                startTime: entry.started_at ?? entry.StartTime,
                endTime: entry.ended_at ?? entry.EndTime,
                duration: entry.Duration,
                location: entry.Location?.lat
                    ? { lat: entry.Location.lat, lng: entry.Location.lng, address: entry.Location.address }
                    : null,
                userId: entry.UserId,
                userName: entry.UserName,
                notes: entry.notes,
                isoPlusSynced: entry.isoPlusSynced
            };
        });

        res.status(200).json({ tasks });
    } catch (err) {
        error('TimeTrack-Service', 'Failed to fetch time entries', { err }, req);
        res.status(500).json({ message: err.message });
    }
});

router.post('/start', authenticateToken, async (req, res) => {
    const { workspaceId, boardId, itemId, location, notes } = req.body || {};
    if (!workspaceId || !boardId || !itemId) {
        return res.status(400).json({ message: 'workspaceId, boardId, and itemId are required' });
    }
    try {
        const item = await Item.findOne({ itemId, boardId, workspaceId }, { data: 1 }).lean();
        if (!item) {
            return res.status(404).json({ message: 'Task item not found for this board' });
        }
        const taskName = resolveItemName(item.data, itemId);

        const existing = await TimeTrack.findOne({
            workspaceId,
            boardId,
            User: req.user.email,
            ended_at: null
        });
        if (existing) {
            return res.status(409).json({
                message: 'You already have an active time tracking session on this board',
                activeItemId: existing.itemId
            });
        }

        const startTimeStamp = new Date();
        const locationData = location
            ? { lat: location.lat ?? null, lng: location.lng ?? null, address: location.address ?? null }
            : {};

        const entry = await TimeTrack.create({
            workspaceId,
            boardId,
            itemId,
            Task: taskName,
            started_at: startTimeStamp,
            ended_at: null,
            User: req.user.email,
            UserId: req.user.id || req.user._id || null,
            UserName: req.user.name || req.user.email,
            Location: locationData,
            notes: notes || null,
            isoPlusSynced: false
        });

        info('TimeTrack-Service', 'Clock-in started', { workspaceId, boardId, itemId, user: req.user.email }, req);

        res.status(201).json({
            id: entry._id,
            taskName,
            itemId,
            startTime: entry.started_at,
            location: entry.Location?.lat ? entry.Location : null
        });
    } catch (err) {
        error('TimeTrack-Service', 'Failed to start time tracking', { err }, req);
        res.status(500).json({ message: err.message });
    }
});

router.post('/stop', authenticateToken, async (req, res) => {
    const { workspaceId, boardId, itemId, location, notes } = req.body || {};
    if (!workspaceId || !boardId || !itemId) {
        return res.status(400).json({ message: 'workspaceId, boardId, and itemId are required' });
    }
    try {
        const entry = await TimeTrack.findOne({
            workspaceId, boardId, itemId,
            User: req.user.email,
            ended_at: null
        }).lean();
        if (!entry) {
            return res.status(404).json({ message: 'No active session found for this task' });
        }

        const endTimeStamp = new Date();
        const startedAt = entry.started_at ?? entry.StartTime;
        const duration = computeDuration(startedAt, endTimeStamp);

        const updateFields = { ended_at: endTimeStamp, Duration: duration };
        if (location) {
            updateFields.Location = {
                lat: location.lat ?? entry.Location?.lat,
                lng: location.lng ?? entry.Location?.lng,
                address: location.address ?? entry.Location?.address
            };
        }
        if (notes) updateFields.notes = notes;
        await TimeTrack.updateOne({ _id: entry._id }, { $set: updateFields });

        info('TimeTrack-Service', 'Clock-out completed', { workspaceId, boardId, itemId, duration, user: req.user.email }, req);

        Item.findOne({ itemId }, { data: 1 }).lean()
            .then(fullItem => {
                const ttKey = fullItem?.data?._timeTrackingKey;
                const ttAttrId = fullItem?.data?._timeTrackingAttributeId;
                if (!ttAttrId) {
                    warn('TimeTrack-Service', 'No time tracking attribute ID found, skipping ISO+ sync', { itemId });
                    return false;
                }
                const existingEntries = (ttKey && Array.isArray(fullItem.data[ttKey]))
                    ? fullItem.data[ttKey]
                    : [];
                return putTimeTracking(
                    workspaceId, boardId, itemId,
                    startedAt, endTimeStamp,
                    ttAttrId, existingEntries, notes || entry.notes
                );
            })
            .then(synced => {
                TimeTrack.updateOne({ _id: entry._id }, { $set: { isoPlusSynced: !!synced } }).catch(() => {});
                if (!synced) warn('TimeTrack-Service', 'ISO+ sync failed on clock-out', { itemId, entryId: entry._id });
            })
            .catch(() => {});

        res.status(200).json({
            id: entry._id,
            taskName: entry.Task,
            itemId,
            startTime: startedAt,
            endTime: endTimeStamp,
            duration,
            location: updateFields.Location ?? (entry.Location?.lat ? entry.Location : null)
        });
    } catch (err) {
        error('TimeTrack-Service', 'Failed to stop time tracking', { err }, req);
        res.status(500).json({ message: err.message });
    }
});

router.put('/', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId, itemId, startTime, endTime } = req.body || {};
        const fullItem = await Item.findOne({ itemId }, { data: 1 }).lean();
        const ttKey = fullItem?.data?._timeTrackingKey;
        const ttAttrId = fullItem?.data?._timeTrackingAttributeId;
        const existingEntries = (ttKey && Array.isArray(fullItem?.data?.[ttKey]))
            ? fullItem.data[ttKey] : [];
        const synced = await putTimeTracking(
            workspaceId, boardId, itemId, startTime, endTime,
            ttAttrId, existingEntries
        );
        info('TimeTrack-Service', 'Time tracking updated (direct)', { workspaceId, boardId, itemId }, req ?? null);
        res.status(200).json({ success: synced });
    } catch (err) {
        error('TimeTrack-Service', 'Failed to update time tracking', { err }, req);
        res.status(500).json({ success: false, message: err.message });
    }
});

export default router;