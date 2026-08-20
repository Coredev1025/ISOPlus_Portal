import { describe, it, expect } from 'vitest';
import { buildBoardSyncScheduleView } from '../../../src/utils/boardSyncScheduleViewHelpers.js';

const upcoming = new Date('2026-08-20T16:00:00Z');
const portal = {
  cron: '0 2 * * *',
  timezone: 'Australia/Sydney',
  nextRunAt: upcoming,
};

describe('buildBoardSyncScheduleView', () => {
  it('returns Idle current, lastSyncedAt as previous, and portal nextRunAt', () => {
    const lastSyncedAt = new Date('2026-08-18T16:00:00Z');
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'realtime_sync', lastSyncedAt },
      jobStatus: null,
      syncExecution: null,
      lastCompleted: null,
      portalSchedule: portal,
    });
    expect(view.cron).toBe('0 2 * * *');
    expect(view.previous).toEqual({
      at: lastSyncedAt, status: 'completed', syncType: null,
    });
    expect(view.current).toBeNull();
    expect(view.upcoming).toEqual({ at: upcoming });
  });

  it('prefers a completed execution over lastSyncedAt', () => {
    const at = new Date('2026-08-17T16:00:00Z');
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'realtime_sync', lastSyncedAt: new Date('2026-08-10T00:00:00Z') },
      jobStatus: null,
      syncExecution: null,
      lastCompleted: { endTime: at, status: 'completed', syncType: 'scheduled_sync' },
      portalSchedule: portal,
    });
    expect(view.previous).toEqual({
      at, status: 'completed', syncType: 'scheduled_sync',
    });
  });

  it('surfaces an in-flight catch-up as current', () => {
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'scheduled_sync', lastSyncedAt: null },
      jobStatus: { state: 'waiting' },
      syncExecution: null,
      lastCompleted: null,
      portalSchedule: portal,
    });
    expect(view.current).toEqual({ state: 'waiting', syncType: 'scheduled_sync' });
  });

  it('ignores a finished BullMQ job so Current returns to Idle', () => {
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'realtime_sync', lastSyncedAt: new Date('2026-08-18T16:00:00Z') },
      jobStatus: { state: 'completed' },
      syncExecution: null,
      lastCompleted: null,
      portalSchedule: portal,
    });
    expect(view.current).toBeNull();
  });

  it('ignores a failed BullMQ job left on syncJobId', () => {
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'realtime_sync', lastSyncedAt: null },
      jobStatus: { state: 'failed' },
      syncExecution: null,
      lastCompleted: null,
      portalSchedule: portal,
    });
    expect(view.current).toBeNull();
  });

  it('omits upcoming when the portal schedule is missing', () => {
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'realtime_sync', lastSyncedAt: null },
      jobStatus: null,
      syncExecution: null,
      lastCompleted: null,
      portalSchedule: null,
    });
    expect(view.upcoming).toBeNull();
    expect(view.cron).toBeNull();
  });
});
