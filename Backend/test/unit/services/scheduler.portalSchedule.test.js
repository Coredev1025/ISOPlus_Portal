import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/services/scheduler/handlers.js', () => ({
  runBoardSyncSweep: vi.fn(async () => undefined),
}));

import {
  buildPortalBoardSyncMeta,
  startBoardSyncCron,
} from '../../../src/services/scheduler/portalSchedule.js';
import { runBoardSyncSweep } from '../../../src/services/scheduler/handlers.js';
import {
  BOARD_SYNC_CRON_DEFAULT,
  DEFAULT_TIMEZONE,
} from '../../../src/constants/scheduler.js';

describe('buildPortalBoardSyncMeta', () => {
  const originalCron = process.env.BOARD_SYNC_CRON;
  const originalEnabled = process.env.BOARD_SYNC_ENABLED;
  afterEach(() => {
    if (originalCron === undefined) delete process.env.BOARD_SYNC_CRON;
    else process.env.BOARD_SYNC_CRON = originalCron;
    if (originalEnabled === undefined) delete process.env.BOARD_SYNC_ENABLED;
    else process.env.BOARD_SYNC_ENABLED = originalEnabled;
  });

  it('returns cron, timezone, and nextRunAt from the env cron', () => {
    delete process.env.BOARD_SYNC_CRON;
    delete process.env.BOARD_SYNC_ENABLED;
    const now = new Date('2026-08-11T04:05:00Z');
    const meta = buildPortalBoardSyncMeta({ now });

    expect(meta.cron).toBe(BOARD_SYNC_CRON_DEFAULT);
    expect(meta.timezone).toBe(DEFAULT_TIMEZONE);
    expect(meta.nextRunAt).toBeInstanceOf(Date);
    expect(meta.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('returns nextRunAt null when BOARD_SYNC_ENABLED is off', () => {
    delete process.env.BOARD_SYNC_CRON;
    process.env.BOARD_SYNC_ENABLED = 'false';
    const meta = buildPortalBoardSyncMeta({ now: new Date('2026-08-11T04:05:00Z') });
    expect(meta.nextRunAt).toBeNull();
    expect(meta.cron).toBe(BOARD_SYNC_CRON_DEFAULT);
  });
});

describe('startBoardSyncCron', () => {
  const original = process.env.BOARD_SYNC_CRON;
  const originalEnabled = process.env.BOARD_SYNC_ENABLED;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    runBoardSyncSweep.mockClear();
    process.env.NODE_ENV = 'production';
    delete process.env.BOARD_SYNC_ENABLED;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.BOARD_SYNC_CRON;
    else process.env.BOARD_SYNC_CRON = original;
    if (originalEnabled === undefined) delete process.env.BOARD_SYNC_ENABLED;
    else process.env.BOARD_SYNC_ENABLED = originalEnabled;
    process.env.NODE_ENV = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('arms a timeout for the next cron slot and fires the sweep', async () => {
    process.env.BOARD_SYNC_CRON = '0 2 * * *';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T16:00:05Z'));

    const task = startBoardSyncCron();
    expect(task).toEqual({ stop: expect.any(Function) });

    // Next 02:00 Sydney after 16:00:05Z on the 11th is 16:00Z on the 12th.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 - 5000);
    expect(runBoardSyncSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: DEFAULT_TIMEZONE,
        slot: new Date('2026-08-12T16:00:00.000Z'),
      }),
    );

    task.stop();
  });

  it('passes the armed slot even when the timer fires a millisecond early', async () => {
    process.env.BOARD_SYNC_CRON = '0 2 * * *';
    vi.useFakeTimers();
    // One millisecond before the 02:00 Sydney fire (16:00Z on the 12th).
    vi.setSystemTime(new Date('2026-08-12T15:59:59.999Z'));

    let scheduledFire = null;
    vi.spyOn(global, 'setTimeout').mockImplementation((fn) => {
      scheduledFire = fn;
      return { unref() {} };
    });

    const task = startBoardSyncCron();
    expect(scheduledFire).toBeTypeOf('function');
    // Fire while still early — re-deriving the slot from Date.now() would pick
    // yesterday's occurrence and collapse onto a spent period key.
    await scheduledFire();

    expect(runBoardSyncSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: new Date('2026-08-12T16:00:00.000Z'),
      }),
    );

    task.stop();
  });

  it('does not schedule when the expression is invalid', () => {
    process.env.BOARD_SYNC_CRON = 'not a cron';
    expect(startBoardSyncCron()).toBeNull();
  });

  it('does not schedule when BOARD_SYNC_ENABLED is false', () => {
    process.env.BOARD_SYNC_CRON = '0 2 * * *';
    process.env.BOARD_SYNC_ENABLED = 'false';
    expect(startBoardSyncCron()).toBeNull();
  });

  it('does not schedule in test', () => {
    process.env.NODE_ENV = 'test';
    expect(startBoardSyncCron()).toBeNull();
  });
});
