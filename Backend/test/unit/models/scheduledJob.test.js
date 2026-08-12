import { describe, it, expect } from 'vitest';
import ScheduledJob from '../../../src/models/ScheduledJob.js';

describe('ScheduledJob model', () => {
  it('applies defaults for a minimally specified schedule', async () => {
    const job = await ScheduledJob.create({
      kind: 'board_sync',
      targetId: 'board-1',
      cron: '*/30 * * * *',
      nextRunAt: new Date('2026-08-11T00:00:00Z'),
    });

    expect(job.timezone).toBe('Australia/Sydney');
    expect(job.enabled).toBe(true);
    expect(job.missedRuns).toBe(0);
    expect(job.consecutiveFailures).toBe(0);
    expect(job.lastRunAt).toBeNull();
    expect(job.lastError).toBeNull();
  });

  it('refuses a second schedule for the same kind and target', async () => {
    await ScheduledJob.create({
      kind: 'board_sync',
      targetId: 'board-dupe',
      cron: '*/30 * * * *',
      nextRunAt: new Date('2026-08-11T00:00:00Z'),
    });
    await ScheduledJob.syncIndexes();

    await expect(
      ScheduledJob.create({
        kind: 'board_sync',
        targetId: 'board-dupe',
        cron: '0 * * * *',
        nextRunAt: new Date('2026-08-11T01:00:00Z'),
      }),
    ).rejects.toThrow();
  });

  it('allows the same target under a different kind', async () => {
    await ScheduledJob.create({
      kind: 'board_sync',
      targetId: 'shared-target',
      cron: '*/30 * * * *',
      nextRunAt: new Date('2026-08-11T00:00:00Z'),
    });
    await ScheduledJob.syncIndexes();

    const other = await ScheduledJob.create({
      kind: 'invoice_issuance',
      targetId: 'shared-target',
      cron: '0 2 1 * *',
      nextRunAt: new Date('2026-09-01T00:00:00Z'),
    });

    expect(other.kind).toBe('invoice_issuance');
  });

  it('requires a cron expression and a next run time', async () => {
    await expect(
      ScheduledJob.create({ kind: 'board_sync', targetId: 'board-2' }),
    ).rejects.toThrow();
  });

  it('rejects a cron expression that does not parse', async () => {
    await expect(
      ScheduledJob.create({
        kind: 'board_sync',
        targetId: 'board-bad-cron',
        cron: 'not-a-cron',
        nextRunAt: new Date('2026-08-11T00:00:00Z'),
      }),
    ).rejects.toThrow();
  });

  it('rejects a timezone that is not a valid IANA name', async () => {
    await expect(
      ScheduledJob.create({
        kind: 'board_sync',
        targetId: 'board-bad-tz',
        cron: '*/30 * * * *',
        timezone: 'Mars/Olympus',
        nextRunAt: new Date('2026-08-11T00:00:00Z'),
      }),
    ).rejects.toThrow();
  });
});

describe('ScheduledJob cron/schedule exclusivity', () => {
  const base = {
    kind: 'invoice_automation',
    targetId: 'ws-1',
    timezone: 'Australia/Sydney',
    nextRunAt: new Date('2026-09-01T09:00:00+10:00'),
  };
  const picker = {
    every: { n: 1, unit: 'month' },
    runOn: 15,
    runAt: '09:00',
    startDate: new Date('2026-08-01T00:00:00+10:00'),
  };

  it('accepts a cron-only job', async () => {
    const doc = new ScheduledJob({ ...base, cron: '0 9 * * *' });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('accepts a schedule-only job', async () => {
    const doc = new ScheduledJob({ ...base, schedule: picker });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('rejects a job with both', async () => {
    const doc = new ScheduledJob({ ...base, cron: '0 9 * * *', schedule: picker });
    await expect(doc.validate()).rejects.toThrow(/exactly one/i);
  });

  it('rejects a job with neither', async () => {
    const doc = new ScheduledJob({ ...base });
    await expect(doc.validate()).rejects.toThrow(/exactly one/i);
  });

  it('validates timezone on a schedule-only job, where cron is null', async () => {
    const doc = new ScheduledJob({ ...base, timezone: 'Not/AZone', schedule: picker });
    await expect(doc.validate()).rejects.toThrow(/timezone/i);
  });

  it('rejects an unknown unit', async () => {
    const doc = new ScheduledJob({
      ...base,
      schedule: { ...picker, every: { n: 1, unit: 'fortnight' } },
    });
    await expect(doc.validate()).rejects.toThrow(/unit/);
  });
});
