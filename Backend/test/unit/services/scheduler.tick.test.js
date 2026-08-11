import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import ScheduledJob from '../../../src/models/ScheduledJob.js';
import { runTick } from '../../../src/services/scheduler/tick.js';
import {
  register,
  clearRegistry,
  AT_MOST_ONCE,
  AT_LEAST_ONCE,
} from '../../../src/services/scheduler/registry.js';

const NOW = new Date('2026-08-11T04:05:00Z');

async function due(kind, overrides = {}) {
  return ScheduledJob.create({
    kind,
    targetId: `t-${Math.random().toString(16).slice(2)}`,
    cron: '*/30 * * * *',
    timezone: 'Australia/Sydney',
    nextRunAt: new Date('2026-08-11T04:00:00Z'),
    ...overrides,
  });
}

describe('runTick', () => {
  beforeEach(() => {
    clearRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches a due schedule and reports it', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    register('demo', { handler, policy: AT_MOST_ONCE });
    const job = await due('demo', { workspaceId: 'ws-1' });

    const summary = await runTick({ now: NOW });

    expect(summary).toEqual({
      claimed: 1,
      dispatched: 1,
      failed: 0,
      capped: false,
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: job.targetId, workspaceId: 'ws-1' }),
    );
  });

  it('ignores schedules that are not yet due', async () => {
    register('demo', { handler: vi.fn(), policy: AT_MOST_ONCE });
    await due('demo', { nextRunAt: new Date('2026-08-11T09:00:00Z') });

    const summary = await runTick({ now: NOW });
    expect(summary.claimed).toBe(0);
  });

  it('ignores disabled schedules', async () => {
    register('demo', { handler: vi.fn(), policy: AT_MOST_ONCE });
    await due('demo', { enabled: false });

    const summary = await runTick({ now: NOW });
    expect(summary.claimed).toBe(0);
  });

  it('advances an at-most-once schedule before dispatching, so a crash loses the slot', async () => {
    let nextRunAtDuringDispatch;
    register('demo', {
      policy: AT_MOST_ONCE,
      handler: async ({ targetId }) => {
        const row = await ScheduledJob.findOne({ targetId });
        nextRunAtDuringDispatch = row.nextRunAt;
      },
    });
    await due('demo');

    await runTick({ now: NOW });

    expect(nextRunAtDuringDispatch.toISOString()).toBe('2026-08-11T04:30:00.000Z');
  });

  it('does not advance an at-least-once schedule until the handler succeeds', async () => {
    let nextRunAtDuringDispatch;
    register('demo', {
      policy: AT_LEAST_ONCE,
      handler: async ({ targetId }) => {
        const row = await ScheduledJob.findOne({ targetId });
        nextRunAtDuringDispatch = row.nextRunAt;
      },
    });
    const job = await due('demo');

    await runTick({ now: NOW });

    expect(nextRunAtDuringDispatch.toISOString()).toBe(job.nextRunAt.toISOString());
    const after = await ScheduledJob.findById(job._id);
    expect(after.nextRunAt.toISOString()).toBe('2026-08-11T04:30:00.000Z');
  });

  it('records missed slots when the schedule was due long ago', async () => {
    register('demo', { handler: vi.fn(), policy: AT_MOST_ONCE });
    const job = await due('demo', { nextRunAt: new Date('2026-08-11T01:00:00Z') });

    await runTick({ now: NOW });

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.missedRuns).toBe(6);
  });

  it('counts a throwing handler as failed without stopping the tick', async () => {
    register('bad', {
      handler: vi.fn().mockRejectedValue(new Error('nope')),
      policy: AT_MOST_ONCE,
    });
    register('good', { handler: vi.fn(), policy: AT_MOST_ONCE });
    await due('bad');
    await due('good');

    const summary = await runTick({ now: NOW });

    expect(summary.claimed).toBe(2);
    expect(summary.dispatched).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it('counts an unregistered kind as failed rather than throwing out of the tick', async () => {
    await due('never_registered');

    const summary = await runTick({ now: NOW });

    expect(summary.failed).toBe(1);
  });

  it('reports when it hits the batch cap instead of truncating silently', async () => {
    register('demo', { handler: vi.fn(), policy: AT_MOST_ONCE });
    await Promise.all([due('demo'), due('demo'), due('demo')]);

    const summary = await runTick({ now: NOW, limit: 2 });

    expect(summary.claimed).toBe(2);
    expect(summary.capped).toBe(true);
  });

  it('does not re-process an at-least-once schedule within the same tick', async () => {
    // It is not advanced at claim time, so without exclusion the loop would
    // pick the same document up again and spin.
    const handler = vi.fn();
    register('demo', { handler, policy: AT_LEAST_ONCE });
    await due('demo');

    const summary = await runTick({ now: NOW });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(summary.claimed).toBe(1);
  });

  it('lets only one caller claim an at-most-once schedule', async () => {
    register('demo', { handler: vi.fn(), policy: AT_MOST_ONCE });
    await due('demo');

    const [a, b] = await Promise.all([
      runTick({ now: NOW }),
      runTick({ now: NOW }),
    ]);

    expect(a.claimed + b.claimed).toBe(1);
  });

  it('continues to the next candidate after losing a claim race', async () => {
    const handler = vi.fn();
    register('demo', { handler, policy: AT_MOST_ONCE });
    await due('demo', { nextRunAt: new Date('2026-08-11T03:00:00Z') }); // claimed first
    await due('demo', { nextRunAt: new Date('2026-08-11T03:30:00Z') }); // must still be reached

    // One lost CAS: findOneAndUpdate resolves null exactly once, as it does when
    // another instance claimed the row between our read and our update.
    vi.spyOn(ScheduledJob, 'findOneAndUpdate').mockResolvedValueOnce(null);

    const summary = await runTick({ now: NOW });

    // Old behaviour (stop on a lost CAS) gives claimed: 0 here.
    expect(summary.claimed).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
