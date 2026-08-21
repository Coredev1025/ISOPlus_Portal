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
  const original = process.env.BOARD_SYNC_CRON;
  afterEach(() => {
    if (original === undefined) delete process.env.BOARD_SYNC_CRON;
    else process.env.BOARD_SYNC_CRON = original;
  });

  it('returns cron, timezone, and nextRunAt from the env cron', () => {
    delete process.env.BOARD_SYNC_CRON;
    const now = new Date('2026-08-11T04:05:00Z');
    const meta = buildPortalBoardSyncMeta({ now });

    expect(meta.cron).toBe(BOARD_SYNC_CRON_DEFAULT);
    expect(meta.timezone).toBe(DEFAULT_TIMEZONE);
    expect(meta.nextRunAt).toBeInstanceOf(Date);
    expect(meta.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('startBoardSyncCron', () => {
  const original = process.env.BOARD_SYNC_CRON;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    runBoardSyncSweep.mockClear();
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    if (original === undefined) delete process.env.BOARD_SYNC_CRON;
    else process.env.BOARD_SYNC_CRON = original;
    process.env.NODE_ENV = originalEnv;
    vi.useRealTimers();
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
        slot: expect.any(Date),
      }),
    );

    task.stop();
  });

  it('does not schedule when the expression is invalid', () => {
    process.env.BOARD_SYNC_CRON = 'not a cron';
    expect(startBoardSyncCron()).toBeNull();
  });

  it('does not schedule in test', () => {
    process.env.NODE_ENV = 'test';
    expect(startBoardSyncCron()).toBeNull();
  });
});
