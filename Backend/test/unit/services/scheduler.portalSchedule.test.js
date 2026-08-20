import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const scheduleMock = vi.fn();
const validateMock = vi.fn(() => true);

vi.mock('node-cron', () => ({
  schedule: (...args) => scheduleMock(...args),
  validate: (...args) => validateMock(...args),
}));

vi.mock('../../../src/services/scheduler/handlers.js', () => ({
  runBoardSyncSweep: vi.fn(async () => undefined),
}));

import ScheduledJob from '../../../src/models/ScheduledJob.js';
import {
  buildPortalBoardSyncMeta,
  disableLeftoverPortalBoardSyncSchedule,
  startBoardSyncCron,
} from '../../../src/services/scheduler/portalSchedule.js';
import { runBoardSyncSweep } from '../../../src/services/scheduler/handlers.js';
import {
  BOARD_SYNC_CRON_DEFAULT,
  BOARD_SYNC_KIND,
  BOARD_SYNC_TARGET_ID,
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

describe('disableLeftoverPortalBoardSyncSchedule', () => {
  it('disables any enabled portal board_sync row left from the tick era', async () => {
    await ScheduledJob.create({
      kind: BOARD_SYNC_KIND,
      targetId: BOARD_SYNC_TARGET_ID,
      cron: BOARD_SYNC_CRON_DEFAULT,
      timezone: DEFAULT_TIMEZONE,
      enabled: true,
      nextRunAt: new Date('2026-08-12T16:00:00Z'),
    });

    const result = await disableLeftoverPortalBoardSyncSchedule();

    expect(result.modifiedCount).toBe(1);
    const row = await ScheduledJob.findOne({
      kind: BOARD_SYNC_KIND, targetId: BOARD_SYNC_TARGET_ID,
    }).lean();
    expect(row.enabled).toBe(false);
  });

  it('retries and then throws when updateMany keeps failing', async () => {
    const spy = vi.spyOn(ScheduledJob, 'updateMany').mockRejectedValue(new Error('mongo down'));

    await expect(disableLeftoverPortalBoardSyncSchedule({ attempts: 2 }))
      .rejects.toThrow('mongo down');
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });
});

describe('startBoardSyncCron', () => {
  const original = process.env.BOARD_SYNC_CRON;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    scheduleMock.mockReset();
    validateMock.mockReset();
    validateMock.mockReturnValue(true);
    scheduleMock.mockReturnValue({ stop: vi.fn() });
    runBoardSyncSweep.mockClear();
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    if (original === undefined) delete process.env.BOARD_SYNC_CRON;
    else process.env.BOARD_SYNC_CRON = original;
    process.env.NODE_ENV = originalEnv;
    vi.useRealTimers();
  });

  it('schedules BOARD_SYNC_CRON in DEFAULT_TIMEZONE and wires the sweep', async () => {
    process.env.BOARD_SYNC_CRON = '0 2 * * *';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T16:00:05Z'));

    const task = startBoardSyncCron();

    expect(validateMock).toHaveBeenCalledWith('0 2 * * *');
    expect(scheduleMock).toHaveBeenCalledWith(
      '0 2 * * *',
      expect.any(Function),
      { timezone: DEFAULT_TIMEZONE },
    );
    expect(task).toEqual({ stop: expect.any(Function) });

    const onTick = scheduleMock.mock.calls[0][1];
    await onTick();
    expect(runBoardSyncSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: BOARD_SYNC_TARGET_ID,
        timezone: DEFAULT_TIMEZONE,
        scheduledFor: new Date('2026-08-11T16:00:00Z'),
      }),
    );

    vi.useRealTimers();
  });

  it('does not schedule when the expression is invalid', () => {
    validateMock.mockReturnValue(false);
    process.env.BOARD_SYNC_CRON = 'not a cron';

    expect(startBoardSyncCron()).toBeNull();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('does not schedule in test', () => {
    process.env.NODE_ENV = 'test';
    expect(startBoardSyncCron()).toBeNull();
    expect(scheduleMock).not.toHaveBeenCalled();
  });
});
