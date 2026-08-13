import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import ScheduledJob from '../../../src/models/ScheduledJob.js';
import SchedulerHealth from '../../../src/models/SchedulerHealth.js';
import { runTick } from '../../../src/services/scheduler/tick.js';
import { register, clearRegistry } from '../../../src/services/scheduler/registry.js';
import {
  AT_MOST_ONCE,
  AT_LEAST_ONCE,
  SCHEDULER_HEALTH_KEY,
} from '../../../src/constants/scheduler.js';

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

  it('passes the due slot as scheduledFor under at-most-once, not the post-claim next slot', async () => {
    let seen;
    register('demo', {
      policy: AT_MOST_ONCE,
      handler: async ({ scheduledFor }) => {
        seen = scheduledFor;
      },
    });
    const job = await due('demo');

    await runTick({ now: NOW });

    // The claim already advanced nextRunAt to the following slot (04:30); a
    // handler keying off scheduledFor must still see the slot that was due
    // (04:00), or an at-most-once consumer derives the wrong billing period.
    expect(seen.toISOString()).toBe(job.nextRunAt.toISOString());
    expect(seen.toISOString()).toBe('2026-08-11T04:00:00.000Z');
  });

  it('passes the due slot as scheduledFor under at-least-once', async () => {
    let seen;
    register('demo', {
      policy: AT_LEAST_ONCE,
      handler: async ({ scheduledFor }) => {
        seen = scheduledFor;
      },
    });
    const job = await due('demo');

    await runTick({ now: NOW });

    expect(seen.toISOString()).toBe(job.nextRunAt.toISOString());
    expect(seen.toISOString()).toBe('2026-08-11T04:00:00.000Z');
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

  it('records a heartbeat on a tick that claims nothing, proving the clock is alive', async () => {
    await runTick({ now: NOW });

    const health = await SchedulerHealth.findOne({ key: SCHEDULER_HEALTH_KEY }).lean();
    expect(health).not.toBeNull();
    expect(health.lastTickAt.toISOString()).toBe(NOW.toISOString());
  });

  it('updates the same heartbeat document across ticks instead of duplicating it', async () => {
    await runTick({ now: NOW });
    const later = new Date(NOW.getTime() + 60_000);
    await runTick({ now: later });

    const count = await SchedulerHealth.countDocuments({ key: SCHEDULER_HEALTH_KEY });
    expect(count).toBe(1);

    const health = await SchedulerHealth.findOne({ key: SCHEDULER_HEALTH_KEY }).lean();
    expect(health.lastTickAt.toISOString()).toBe(later.toISOString());
  });

  it('records the heartbeat even when dispatches failed, because the clock still fired', async () => {
    register('bad', {
      handler: vi.fn().mockRejectedValue(new Error('nope')),
      policy: AT_MOST_ONCE,
    });
    await due('bad');

    const summary = await runTick({ now: NOW });
    expect(summary).toMatchObject({ claimed: 1, dispatched: 0, failed: 1 });

    const health = await SchedulerHealth.findOne({ key: SCHEDULER_HEALTH_KEY }).lean();
    expect(health.lastTickAt.toISOString()).toBe(NOW.toISOString());
  });

  it('returns the tick summary normally even when the heartbeat write fails', async () => {
    vi.spyOn(SchedulerHealth, 'findOneAndUpdate').mockRejectedValueOnce(new Error('mongo down'));

    const summary = await runTick({ now: NOW });

    expect(summary).toEqual({ claimed: 0, dispatched: 0, failed: 0, capped: false });
    const count = await SchedulerHealth.countDocuments({ key: SCHEDULER_HEALTH_KEY });
    expect(count).toBe(0);
  });

  it('disables an at-most-once row whose cron cannot parse instead of reselecting it every tick', async () => {
    register('demo', { handler: vi.fn(), policy: AT_MOST_ONCE });
    // Written straight at the collection, bypassing upsertSchedule and the
    // model validator — the only way such a row can exist.
    await ScheduledJob.collection.insertOne({
      kind: 'demo',
      targetId: 'unparseable',
      cron: 'not-a-cron',
      timezone: 'Australia/Sydney',
      enabled: true,
      nextRunAt: new Date('2026-08-11T04:00:00Z'),
      missedRuns: 0,
      consecutiveFailures: 0,
    });

    const first = await runTick({ now: NOW });

    // Its next slot is exactly what cannot be computed, so it can never run
    // again. Leaving it enabled means re-reading and re-failing it forever.
    expect(first.failed).toBe(1);
    const fresh = await ScheduledJob.findOne({ targetId: 'unparseable' }).lean();
    expect(fresh.enabled).toBe(false);
    expect(fresh.lastError).toBeTruthy();
    expect(fresh.consecutiveFailures).toBe(1);

    const second = await runTick({ now: NOW });
    expect(second).toMatchObject({ claimed: 0, dispatched: 0, failed: 0 });
  });

  it('still dispatches the other due schedules in a tick that quarantines one', async () => {
    const handler = vi.fn();
    register('demo', { handler, policy: AT_MOST_ONCE });
    await ScheduledJob.collection.insertOne({
      kind: 'demo',
      targetId: 'unparseable-2',
      cron: 'not-a-cron',
      timezone: 'Australia/Sydney',
      enabled: true,
      nextRunAt: new Date('2026-08-11T03:00:00Z'), // sorts first
      missedRuns: 0,
      consecutiveFailures: 0,
    });
    await due('demo');

    const summary = await runTick({ now: NOW });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ claimed: 1, dispatched: 1, failed: 1 });
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
