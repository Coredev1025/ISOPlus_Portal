import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import ScheduledJob from '../../../src/models/ScheduledJob.js';
import Business from '../../../src/models/Business.js';
import {
  upsertSchedule,
  disableSchedule,
} from '../../../src/services/scheduler/schedules.js';
import { getSchedulerAuthorization } from '../../../src/services/scheduler/auth.js';
import {
  register,
  clearRegistry,
  AT_MOST_ONCE,
  AT_LEAST_ONCE,
} from '../../../src/services/scheduler/registry.js';
import {
  AT_MOST_ONCE_MIN_INTERVAL_MINUTES,
  AT_LEAST_ONCE_MIN_INTERVAL_MINUTES,
} from '../../../src/services/scheduler/intervalFloor.js';

vi.mock('../../../src/utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  default: {},
}));

const { warn } = await import('../../../src/utils/logger.js');

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

describe('upsertSchedule — timezone inheritance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inherits headOfficeTimezone from the Business for the workspace when no timezone is passed', async () => {
    await Business.create({ workspaceId: 'ws-inherit', headOfficeTimezone: 'Australia/Perth' });

    const job = await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-inherit',
      workspaceId: 'ws-inherit',
      cron: '0 2 1 * *',
      now: NOW,
    });

    expect(job.timezone).toBe('Australia/Perth');
  });

  it('an explicit timezone argument overrides the workspace default', async () => {
    await Business.create({ workspaceId: 'ws-explicit', headOfficeTimezone: 'Australia/Perth' });

    const job = await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-explicit',
      workspaceId: 'ws-explicit',
      cron: '0 2 1 * *',
      timezone: 'Pacific/Auckland',
      now: NOW,
    });

    expect(job.timezone).toBe('Pacific/Auckland');
  });

  it('falls back to Australia/Sydney when no Business exists for the workspace', async () => {
    const job = await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-no-business',
      workspaceId: 'ws-does-not-exist',
      cron: '0 2 1 * *',
      now: NOW,
    });

    expect(job.timezone).toBe('Australia/Sydney');
  });

  it('falls back to Australia/Sydney when neither a timezone nor a workspaceId is given', async () => {
    const job = await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-no-workspace',
      cron: '0 2 1 * *',
      now: NOW,
    });

    expect(job.timezone).toBe('Australia/Sydney');
  });

  it('falls back to Australia/Sydney and logs a warning when the inherited timezone is not a valid IANA zone', async () => {
    await Business.create({ workspaceId: 'ws-bad-tz', headOfficeTimezone: 'Mars/Olympus' });

    const job = await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-bad-tz',
      workspaceId: 'ws-bad-tz',
      cron: '0 2 1 * *',
      now: NOW,
    });

    expect(job.timezone).toBe('Australia/Sydney');
    expect(warn).toHaveBeenCalledWith(
      'Scheduler',
      expect.stringMatching(/timezone/i),
      expect.objectContaining({ workspaceId: 'ws-bad-tz', timezone: 'Mars/Olympus' }),
    );
  });

  it('rejects an explicitly-passed invalid timezone rather than falling back, even with a valid inherited value available', async () => {
    // Contrast with the inherited case above: a Business with a *valid*
    // headOfficeTimezone exists for this workspace, so a fallback would have
    // something good to fall back to. The explicit argument still wins and
    // is still invalid, so this must reject — an inherited bad setting must
    // not make schedules uncreatable, but a caller passing a bad value
    // directly is a caller error, not something to paper over.
    await Business.create({
      workspaceId: 'ws-explicit-bad-tz',
      headOfficeTimezone: 'Australia/Perth',
    });

    await expect(
      upsertSchedule({
        kind: 'board_sync',
        targetId: 'board-explicit-bad-tz',
        workspaceId: 'ws-explicit-bad-tz',
        cron: '*/30 * * * *',
        timezone: 'Mars/Olympus',
        now: NOW,
      }),
    ).rejects.toThrow(/invalid schedule/i);

    expect(await ScheduledJob.countDocuments({ targetId: 'board-explicit-bad-tz' })).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('upsertSchedule — minimum-interval floor', () => {
  beforeEach(() => {
    clearRegistry();
    vi.clearAllMocks();
  });
  afterEach(() => {
    clearRegistry();
  });

  it('rejects a 30-minute cron for an AT_MOST_ONCE kind, before writing anything', async () => {
    register('invoice_issuance', { handler: () => {}, policy: AT_MOST_ONCE });

    await expect(
      upsertSchedule({
        kind: 'invoice_issuance',
        targetId: 'ws-invoice-1',
        cron: '*/30 * * * *',
        now: NOW,
      }),
    ).rejects.toThrow(
      /cron "\*\/30 \* \* \* \*".*invoice_issuance.*30.*60-minute floor.*at_most_once/is,
    );

    expect(await ScheduledJob.countDocuments({ targetId: 'ws-invoice-1' })).toBe(0);
  });

  it('accepts a cron whose minimum interval is exactly the 60-minute floor for an AT_MOST_ONCE kind', async () => {
    // The comparison in assertMinimumInterval is strict (`<`), so a gap of
    // exactly the floor must be accepted, not rejected.
    register('invoice_issuance', { handler: () => {}, policy: AT_MOST_ONCE });

    const job = await upsertSchedule({
      kind: 'invoice_issuance',
      targetId: 'ws-invoice-exact-floor',
      cron: '0 * * * *',
      now: NOW,
    });

    expect(job.cron).toBe('0 * * * *');
  });

  it('accepts a monthly cron for an AT_MOST_ONCE kind', async () => {
    register('invoice_issuance', { handler: () => {}, policy: AT_MOST_ONCE });

    const job = await upsertSchedule({
      kind: 'invoice_issuance',
      targetId: 'ws-invoice-2',
      cron: '0 2 1 * *',
      now: NOW,
    });

    expect(job.cron).toBe('0 2 1 * *');
  });

  it('accepts a 30-minute cron for an AT_LEAST_ONCE kind', async () => {
    register('board_sync', { handler: () => {}, policy: AT_LEAST_ONCE });

    const job = await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-30min',
      cron: '*/30 * * * *',
      now: NOW,
    });

    expect(job.cron).toBe('*/30 * * * *');
  });

  it('rejects a once-a-minute cron for an AT_LEAST_ONCE kind, before writing anything', async () => {
    register('board_sync', { handler: () => {}, policy: AT_LEAST_ONCE });

    await expect(
      upsertSchedule({
        kind: 'board_sync',
        targetId: 'board-every-minute',
        cron: '* * * * *',
        now: NOW,
      }),
    ).rejects.toThrow(/cron "\* \* \* \* \*".*board_sync.*1.*5-minute floor.*at_least_once/is);

    expect(await ScheduledJob.countDocuments({ targetId: 'board-every-minute' })).toBe(0);
  });

  it('applies the lenient AT_LEAST_ONCE floor to a kind with no registered handler, and logs it', async () => {
    const job = await upsertSchedule({
      kind: 'not_yet_registered',
      targetId: 'target-unregistered',
      cron: '*/10 * * * *',
      now: NOW,
    });

    expect(job.cron).toBe('*/10 * * * *');
    expect(warn).toHaveBeenCalledWith(
      'Scheduler',
      expect.stringMatching(/no registered handler/i),
      expect.objectContaining({ kind: 'not_yet_registered' }),
    );
  });

  it('rejects a too-frequent cron for a kind with no registered handler, using the lenient floor', async () => {
    await expect(
      upsertSchedule({
        kind: 'not_yet_registered',
        targetId: 'target-unregistered-too-frequent',
        cron: '* * * * *',
        now: NOW,
      }),
    ).rejects.toThrow(/5-minute floor/);

    expect(
      await ScheduledJob.countDocuments({ targetId: 'target-unregistered-too-frequent' }),
    ).toBe(0);
  });

  it('exports the two floor constants for reuse', () => {
    expect(AT_MOST_ONCE_MIN_INTERVAL_MINUTES).toBe(60);
    expect(AT_LEAST_ONCE_MIN_INTERVAL_MINUTES).toBe(5);
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
