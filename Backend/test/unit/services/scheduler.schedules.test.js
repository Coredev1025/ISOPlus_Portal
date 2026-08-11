import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import ScheduledJob from '../../../src/models/ScheduledJob.js';
import {
  upsertSchedule,
  disableSchedule,
} from '../../../src/services/scheduler/schedules.js';
import { getSchedulerAuthorization } from '../../../src/services/scheduler/auth.js';

const NOW = new Date('2026-08-11T04:05:00Z');

describe('getSchedulerAuthorization', () => {
  const original = process.env.PERSONAL_ACCESS_TOKEN;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.PERSONAL_ACCESS_TOKEN;
    } else {
      process.env.PERSONAL_ACCESS_TOKEN = original;
    }
  });

  it('builds a bearer header from the personal access token', () => {
    process.env.PERSONAL_ACCESS_TOKEN = 'pat-123';
    expect(getSchedulerAuthorization()).toBe('Bearer pat-123');
  });

  it('throws when the token is missing, rather than calling ISO+ unauthenticated', () => {
    delete process.env.PERSONAL_ACCESS_TOKEN;
    expect(() => getSchedulerAuthorization()).toThrow(/PERSONAL_ACCESS_TOKEN/);
  });
});

describe('upsertSchedule', () => {
  const original = process.env.PERSONAL_ACCESS_TOKEN;
  beforeEach(() => {
    process.env.PERSONAL_ACCESS_TOKEN = 'pat-123';
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env.PERSONAL_ACCESS_TOKEN;
    } else {
      process.env.PERSONAL_ACCESS_TOKEN = original;
    }
  });

  it('creates a schedule with the next run computed from the cron', async () => {
    const job = await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-1',
      workspaceId: 'ws-1',
      cron: '*/30 * * * *',
      timezone: 'Australia/Sydney',
      now: NOW,
    });

    expect(job.nextRunAt.toISOString()).toBe('2026-08-11T04:30:00.000Z');
    expect(job.enabled).toBe(true);
  });

  it('updates an existing schedule instead of creating a second one', async () => {
    await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-2',
      cron: '*/30 * * * *',
      now: NOW,
    });
    const updated = await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-2',
      cron: '0 2 1 * *',
      now: NOW,
    });

    expect(updated.cron).toBe('0 2 1 * *');
    expect(await ScheduledJob.countDocuments({ targetId: 'board-2' })).toBe(1);
  });

  it('re-enables and resets failure state when a disabled schedule is upserted', async () => {
    await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-3',
      cron: '*/30 * * * *',
      now: NOW,
    });
    await ScheduledJob.updateOne(
      { kind: 'board_sync', targetId: 'board-3' },
      { $set: { enabled: false, consecutiveFailures: 4, lastError: 'boom' } },
    );

    const job = await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-3',
      cron: '*/30 * * * *',
      now: NOW,
    });

    expect(job.enabled).toBe(true);
    expect(job.consecutiveFailures).toBe(0);
    expect(job.lastError).toBeNull();
  });

  it('rejects an invalid cron expression before writing anything', async () => {
    await expect(
      upsertSchedule({
        kind: 'board_sync',
        targetId: 'board-bad',
        cron: 'not-a-cron',
        now: NOW,
      }),
    ).rejects.toThrow(/invalid schedule/i);

    expect(await ScheduledJob.countDocuments({ targetId: 'board-bad' })).toBe(0);
  });

  it('rejects an unknown timezone before writing anything', async () => {
    await expect(
      upsertSchedule({
        kind: 'board_sync',
        targetId: 'board-tz',
        cron: '*/30 * * * *',
        timezone: 'Mars/Olympus',
        now: NOW,
      }),
    ).rejects.toThrow(/invalid schedule/i);

    expect(await ScheduledJob.countDocuments({ targetId: 'board-tz' })).toBe(0);
  });
});

describe('disableSchedule', () => {
  it('disables without deleting, so history survives', async () => {
    await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-4',
      cron: '*/30 * * * *',
      now: NOW,
    });

    const job = await disableSchedule({ kind: 'board_sync', targetId: 'board-4' });
    expect(job.enabled).toBe(false);
    expect(await ScheduledJob.countDocuments({ targetId: 'board-4' })).toBe(1);
  });

  it('returns null for a schedule that does not exist', async () => {
    const job = await disableSchedule({ kind: 'board_sync', targetId: 'missing' });
    expect(job).toBeNull();
  });
});

/**
 * Verify that environment variable restoration works correctly.
 * This catches the bug where assigning `undefined` to process.env coerces to the string "undefined".
 * After all tests, the variable must be either:
 * - undefined (not set in process.env), OR
 * - equal to its original value at suite start
 * Never the string "undefined".
 */
afterAll(() => {
  const current = process.env.PERSONAL_ACCESS_TOKEN;
  const isStringUndefined = current === 'undefined';
  expect(isStringUndefined).toBe(false);
});
