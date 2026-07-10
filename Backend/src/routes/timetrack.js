import express from 'express';
import { authenticateToken, requirePortalOwnerOrSupport } from '../middleware/auth.js';
import { putTimeTracking, getItemValues, ITEM_DELETED } from '../services/isoplus.js';
import { transformItemData } from '../utils/itemTransform.js';
import { info, error, warn } from '../utils/logger.js';
import TimeTrack from '../models/TimeTrack.js';
import Item from '../models/Item.js';
import { toRequiredQueryString, mongoEq } from '../utils/securityHelpers.js';

const router = express.Router();

function parseWorkspaceBoardQuery(query) {
  return {
    workspaceId: toRequiredQueryString(query?.workspaceId),
    boardId: toRequiredQueryString(query?.boardId),
  };
}

function parseWorkspaceBoardItemBody(body) {
  return {
    workspaceId: toRequiredQueryString(body?.workspaceId),
    boardId: toRequiredQueryString(body?.boardId),
    itemId: toRequiredQueryString(body?.itemId),
  };
}

function computeDuration(start, end) {
    return Math.floor((end - start) / 1000);
}

async function pushTimeEntryToIsoPlus(workspaceId, boardId, itemId, startTime, endTime, description = '') {
    const raw = await getItemValues(workspaceId, boardId, itemId);
    if (!raw || raw === ITEM_DELETED) {
        warn('TimeTrack-Service', 'Could not re-fetch item for ISO+ sync', {
            workspaceId,
            boardId,
            itemId,
            deleted: raw === ITEM_DELETED
        });
        return false;
    }
    const flat = transformItemData(raw);
    const ttKey = flat._timeTrackingKey;
    const ttAttrId = flat._timeTrackingAttributeId;
    if (!ttAttrId) {
        warn('TimeTrack-Service', 'No time tracking attribute ID found, skipping ISO+ sync', { itemId });
        return false;
    }
    const existingEntries = ttKey && Array.isArray(flat[ttKey]) ? flat[ttKey] : [];
    return putTimeTracking(
        workspaceId,
        boardId,
        itemId,
        startTime,
        endTime,
        ttAttrId,
        existingEntries,
        description
    );
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

router.get('/tasks', authenticateToken, requirePortalOwnerOrSupport, async (req, res) => {
    const { workspaceId, boardId } = parseWorkspaceBoardQuery(req.query);
    if (!workspaceId || !boardId) {
        return res.status(400).json({ message: 'workspaceId and boardId are required' });
    }
    try {
        const items = await Item.find(
            {
                workspaceId: mongoEq(workspaceId),
                boardId: mongoEq(boardId),
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

router.get('/status', authenticateToken, requirePortalOwnerOrSupport, async (req, res) => {
    const { workspaceId, boardId } = parseWorkspaceBoardQuery(req.query);
    if (!workspaceId || !boardId) {
        return res.status(400).json({ message: 'workspaceId and boardId are required' });
    }
    try {
        const active = await TimeTrack.findOne({
            workspaceId: mongoEq(workspaceId),
            boardId: mongoEq(boardId),
            User: req.user.email,
            ended_at: null
        }).lean();

        if (!active) {
            return res.status(200).json({ active: null });
        }

        let taskName = active.Task;
        if (active.itemId) {
            const item = await Item.findOne({ itemId: mongoEq(active.itemId) }, { data: 1 }).lean();
            if (item) {
                taskName = resolveItemName(item.data, taskName);
            }
        }

        const activeStartLoc = active.StartLocation?.lat
            ? { lat: active.StartLocation.lat, lng: active.StartLocation.lng, address: active.StartLocation.address }
            : (active.Location?.lat ? { lat: active.Location.lat, lng: active.Location.lng, address: active.Location.address } : null);

        res.status(200).json({
            active: {
                id: active._id,
                taskName,
                itemId: active.itemId,
                startTime: active.started_at ?? active.StartTime,
                location: activeStartLoc,
                startLocation: activeStartLoc,
                notes: active.notes
            }
        });
    } catch (err) {
        error('TimeTrack-Service', 'Failed to fetch active status', { err }, req);
        res.status(500).json({ message: err.message });
    }
});

router.get('/', authenticateToken, requirePortalOwnerOrSupport, async (req, res) => {
    const { workspaceId, boardId } = parseWorkspaceBoardQuery(req.query);
    if (!workspaceId || !boardId) {
        return res.status(400).json({ message: 'workspaceId and boardId are required' });
    }
    try {
        const entries = await TimeTrack.find(
            { workspaceId: mongoEq(workspaceId), boardId: mongoEq(boardId) },
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
            const startLoc = entry.StartLocation?.lat
                ? { lat: entry.StartLocation.lat, lng: entry.StartLocation.lng, address: entry.StartLocation.address }
                : (entry.Location?.lat ? { lat: entry.Location.lat, lng: entry.Location.lng, address: entry.Location.address } : null);
            const endLoc = entry.EndLocation?.lat
                ? { lat: entry.EndLocation.lat, lng: entry.EndLocation.lng, address: entry.EndLocation.address }
                : null;
            return {
                id: entry._id,
                taskName,
                itemId: entry.itemId,
                startTime: entry.started_at ?? entry.StartTime,
                endTime: entry.ended_at ?? entry.EndTime,
                duration: entry.Duration,
                location: startLoc,
                startLocation: startLoc,
                endLocation: endLoc,
                userId: entry.UserId,
                userName: entry.UserName,
                notes: entry.notes,
                isoPlusSynced: entry.isoPlusSynced,
                source: entry.source || 'portal'
            };
        });

        res.status(200).json({ tasks });
    } catch (err) {
        error('TimeTrack-Service', 'Failed to fetch time entries', { err }, req);
        res.status(500).json({ message: err.message });
    }
});

router.post('/start', authenticateToken, requirePortalOwnerOrSupport, async (req, res) => {
    const { workspaceId, boardId, itemId } = parseWorkspaceBoardItemBody(req.body);
    const { location, notes } = req.body || {};
    if (!workspaceId || !boardId || !itemId) {
        return res.status(400).json({ message: 'workspaceId, boardId, and itemId are required' });
    }
    try {
        const item = await Item.findOne({
            itemId: mongoEq(itemId),
            boardId: mongoEq(boardId),
            workspaceId: mongoEq(workspaceId),
        }, { data: 1 }).lean();
        if (!item) {
            return res.status(404).json({ message: 'Task item not found for this board' });
        }
        const taskName = resolveItemName(item.data, itemId);

        const existing = await TimeTrack.findOne({
            workspaceId: mongoEq(workspaceId),
            boardId: mongoEq(boardId),
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
        const hasLocation = !!(location?.lat && location?.lng);

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
            Location: hasLocation ? locationData : {},
            StartLocation: hasLocation ? locationData : {},
            notes: notes || null,
            isoPlusSynced: false,
            source: 'portal'
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

router.post('/stop', authenticateToken, requirePortalOwnerOrSupport, async (req, res) => {
    const { workspaceId, boardId, itemId } = parseWorkspaceBoardItemBody(req.body);
    const { location, notes } = req.body || {};
    if (!workspaceId || !boardId || !itemId) {
        return res.status(400).json({ message: 'workspaceId, boardId, and itemId are required' });
    }
    try {
        const entry = await TimeTrack.findOne({
            workspaceId: mongoEq(workspaceId),
            boardId: mongoEq(boardId),
            itemId: mongoEq(itemId),
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
            updateFields.EndLocation = {
                lat: location.lat ?? null,
                lng: location.lng ?? null,
                address: location.address ?? null
            };
        }
        if (notes) updateFields.notes = notes;
        await TimeTrack.updateOne({ _id: entry._id }, { $set: updateFields });

        info('TimeTrack-Service', 'Clock-out completed', { workspaceId, boardId, itemId, duration, user: req.user.email }, req);

        pushTimeEntryToIsoPlus(
            workspaceId,
            boardId,
            itemId,
            startedAt,
            endTimeStamp,
            notes || entry.notes || ''
        )
            .then(synced => {
                TimeTrack.updateOne({ _id: entry._id }, { $set: { isoPlusSynced: !!synced } }).catch(() => {});
                if (!synced) warn('TimeTrack-Service', 'ISO+ sync failed on clock-out', { itemId, entryId: entry._id });
            })
            .catch(() => {});

        const startLoc = entry.StartLocation?.lat
            ? { lat: entry.StartLocation.lat, lng: entry.StartLocation.lng, address: entry.StartLocation.address }
            : (entry.Location?.lat ? { lat: entry.Location.lat, lng: entry.Location.lng, address: entry.Location.address } : null);
        const endLoc = updateFields.EndLocation ?? null;

        res.status(200).json({
            id: entry._id,
            taskName: entry.Task,
            itemId,
            startTime: startedAt,
            endTime: endTimeStamp,
            duration,
            location: startLoc,
            startLocation: startLoc,
            endLocation: endLoc
        });
    } catch (err) {
        error('TimeTrack-Service', 'Failed to stop time tracking', { err }, req);
        res.status(500).json({ message: err.message });
    }
});

router.put('/', authenticateToken, requirePortalOwnerOrSupport, async (req, res) => {
    try {
        const { workspaceId, boardId, itemId, startTime, endTime, description } = req.body || {};
        const synced = await pushTimeEntryToIsoPlus(
            workspaceId,
            boardId,
            itemId,
            startTime,
            endTime,
            description || ''
        );
        info('TimeTrack-Service', 'Time tracking updated (direct)', { workspaceId, boardId, itemId }, req ?? null);
        res.status(200).json({ success: synced });
    } catch (err) {
        error('TimeTrack-Service', 'Failed to update time tracking', { err }, req);
        res.status(500).json({ success: false, message: err.message });
    }
});

export default router;