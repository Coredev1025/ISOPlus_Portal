import TimeTrack from '../models/TimeTrack.js';
import { warn, info } from './logger.js';
import { mongoEq } from './securityHelpers.js';

function computeDuration(start, end) {
    return Math.floor((new Date(end) - new Date(start)) / 1000);
}

export async function syncTimeTrackingFromItem(workspaceId, boardId, itemId, itemData) {
    if (!itemData?._hasTimeTracking) return 0;

    const safeWorkspaceId = mongoEq(workspaceId);
    const safeBoardId = mongoEq(boardId);
    const safeItemId = mongoEq(itemId);
    if (!safeWorkspaceId || !safeBoardId || !safeItemId) return 0;

    const ttKey = itemData._timeTrackingKey;
    const entries = itemData[ttKey];
    if (!Array.isArray(entries) || entries.length === 0) return 0;

    const taskName = itemData._primaryValue || safeItemId;

    const existing = await TimeTrack.find(
        { boardId: safeBoardId, itemId: safeItemId },
        { started_at: 1 }
    ).lean();

    const existingTimes = new Set(existing.map(r => new Date(r.started_at).getTime()));

    let synced = 0;
    for (const entry of entries) {
        if (!entry.started_at || !entry.ended_at) continue;

        const startTime = new Date(entry.started_at);
        const endTime   = new Date(entry.ended_at);

        if (existingTimes.has(startTime.getTime())) continue;

        try {
            const duration = computeDuration(startTime, endTime);

            await TimeTrack.create({
                workspaceId: safeWorkspaceId,
                boardId: safeBoardId,
                itemId: safeItemId,
                Task: taskName,
                started_at: startTime,
                ended_at:   endTime,
                Duration:   duration,
                User:     '[iso+]',
                UserName: entry.description || 'ISO+ Import',
                notes:    entry.description || null,
                isoPlusSynced: true,
                source: 'isoplus'
            });

            existingTimes.add(startTime.getTime());
            synced++;
        } catch (err) {
            if (err.code !== 11000) {
                warn('TimeTrackSync', 'Failed to import ISO+ time-track entry', {
                    boardId: safeBoardId,
                    itemId: safeItemId,
                    started_at: entry.started_at,
                    error: err.message
                });
            }
        }
    }

    if (synced > 0) {
        info('TimeTrackSync', 'Imported ISO+ time-track entries', { boardId: safeBoardId, itemId: safeItemId, synced });
    }

    return synced;
}
