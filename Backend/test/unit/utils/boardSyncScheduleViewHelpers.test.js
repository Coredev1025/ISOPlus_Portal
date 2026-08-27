import { describe, it, expect } from 'vitest';
import { buildBoardSyncScheduleView } from '../../../src/utils/boardSyncScheduleViewHelpers.js';

const upcoming = new Date('2026-08-20T16:00:00Z');
const portal = {
  cron: '0 2 * * *',
  timezone: 'Australia/Sydney',
  nextRunAt: upcoming,
};

describe('buildBoardSyncScheduleView', () => {
  it('returns Idle current, lastSyncedAt as previous Success, and portal nextRunAt', () => {
    const lastSyncedAt = new Date('2026-08-18T16:00:00Z');
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'realtime_sync', lastSyncedAt },
      jobStatus: null,
      syncExecution: null,
      portalSchedule: portal,
    });
    expect(view.cron).toBe('0 2 * * *');
    expect(view.previous).toEqual({ at: lastSyncedAt, status: 'completed' });
    expect(view.current).toBeNull();
    expect(view.upcoming).toEqual({ at: upcoming });
  });

  it('marks previous Failed when sticky lastSyncError is set', () => {
    const lastSyncedAt = new Date('2026-08-18T16:00:00Z');
    const view = buildBoardSyncScheduleView({
      board: {
        syncStatus: 'failed',
        lastSyncedAt,
        lastSyncError: 'ISO+ returned 429 at 02:00',
      },
      jobStatus: null,
      syncExecution: null,
      portalSchedule: portal,
    });
    expect(view.previous).toEqual({ at: lastSyncedAt, status: 'failed' });
  });

  it('does not treat a user cancel message as Failed on previous', () => {
    const lastSyncedAt = new Date('2026-08-18T16:00:00Z');
    const view = buildBoardSyncScheduleView({
      board: {
        syncStatus: 'sync_cancelled',
        lastSyncedAt,
        lastSyncError: 'Sync cancelled by user',
      },
      jobStatus: null,
      syncExecution: null,
      portalSchedule: portal,
    });
    expect(view.previous).toEqual({ at: lastSyncedAt, status: 'completed' });
  });

  it('returns null previous when lastSyncedAt is missing', () => {
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'realtime_sync', lastSyncedAt: null, lastSyncError: 'boom' },
      jobStatus: null,
      syncExecution: null,
      portalSchedule: portal,
    });
    expect(view.previous).toBeNull();
  });

  it('surfaces an in-flight catch-up as current', () => {
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'scheduled_sync', lastSyncedAt: null },
      jobStatus: { state: 'waiting' },
      syncExecution: null,
      portalSchedule: portal,
    });
    expect(view.current).toEqual({ state: 'waiting', syncType: 'scheduled_sync' });
  });

  it('ignores a finished BullMQ job so Current returns to Idle', () => {
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'realtime_sync', lastSyncedAt: new Date('2026-08-18T16:00:00Z') },
      jobStatus: { state: 'completed' },
      syncExecution: null,
      portalSchedule: portal,
    });
    expect(view.current).toBeNull();
  });

  it('ignores a failed BullMQ job left on syncJobId', () => {
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'realtime_sync', lastSyncedAt: null },
      jobStatus: { state: 'failed' },
      syncExecution: null,
      portalSchedule: portal,
    });
    expect(view.current).toBeNull();
  });

  it('omits upcoming when the portal schedule is missing', () => {
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'realtime_sync', lastSyncedAt: null },
      jobStatus: null,
      syncExecution: null,
      portalSchedule: null,
    });
    expect(view.upcoming).toBeNull();
    expect(view.cron).toBeNull();
  });
});
