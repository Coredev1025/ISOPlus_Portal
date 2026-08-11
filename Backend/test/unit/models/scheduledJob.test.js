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
});
