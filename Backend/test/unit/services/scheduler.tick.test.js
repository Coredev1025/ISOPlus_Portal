import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import ScheduledJob from '../../../src/models/ScheduledJob.js';
import SchedulerHealth from '../../../src/models/SchedulerHealth.js';
import { runTick, tickKindScope } from '../../../src/services/scheduler/tick.js';
import { register, clearRegistry } from '../../../src/services/scheduler/registry.js';
import {
  AT_MOST_ONCE,
  AT_LEAST_ONCE,
  SCHEDULER_HEALTH_KEY,
} from '../../../src/constants/scheduler.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../../../src/constants/automation.js';

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
      heldBack: 0,
      capped: false,
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: job.targetId, workspaceId: 'ws-1' }),
    );
  });

  it('claims only the requested kinds when a scope is given', async () => {
    // A per-kind EventBridge rule ticks with a per-kind credential; the
    // scope it carries must leave every other kind untouched and still due.
    const handler = vi.fn().mockResolvedValue(undefined);
    register('inv-demo', { handler, policy: AT_MOST_ONCE });
    register('stmt-demo', { handler, policy: AT_MOST_ONCE });
    await due('inv-demo');
    const statementJob = await due('stmt-demo');

    const summary = await runTick({ now: NOW, kinds: ['inv-demo'] });

    expect(summary.claimed).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const untouched = await ScheduledJob.findById(statementJob._id).lean();
    expect(untouched.nextRunAt).toEqual(statementJob.nextRunAt);
  });

  it('claims every kind when no scope is given', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    register('inv-demo', { handler, policy: AT_MOST_ONCE });
    register('stmt-demo', { handler, policy: AT_MOST_ONCE });
    await due('inv-demo');
    await due('stmt-demo');

    const summary = await runTick({ now: NOW });
    expect(summary.claimed).toBe(2);
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

  it('passes the claimed schedule picker so the handler can bill that period', async () => {
    let seen;
    const schedule = {
      every: { n: 2, unit: 'week' },
      runOn: 'tuesday',
      runAt: '09:00',
      startDate: new Date('2026-07-14T00:00:00+10:00'),
    };
    register('demo', {
      policy: AT_LEAST_ONCE,
      handler: async (payload) => {
        seen = payload;
      },
    });
    await due('demo', { cron: null, schedule });

    await runTick({ now: NOW });

    expect(seen.schedule.every).toEqual({ n: 2, unit: 'week' });
    expect(seen.schedule.runOn).toBe('tuesday');
    expect(seen.timezone).toBe('Australia/Sydney');
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

    expect(summary).toEqual({ claimed: 0, dispatched: 0, failed: 0, heldBack: 0, capped: false });
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

/**
 * AUTOMATION_ENABLED is the deployment-level kill switch. It used to be read
 * only inside the automation handler, which returned without fanning out — and
 * returning IS success, so recordSuccess advanced nextRunAt past the slot. A
 * deployment that spent three months with the switch off therefore consumed
 * three billing periods and generated nothing for any of them: no documents, no
 * error, no trace that the periods had existed. Turning the switch back on
 * resumed from the current slot, and those months were unbillable.
 *
 * The tick holds those kinds back before claiming them instead, so the slot
 * stays due and is billed when the switch comes on. Only the OLDEST due slot
 * fires then, because recordSuccess advances straight past the rest and counts
 * them in missedRuns — so switching on does not replay a backlog.
 */
describe('runTick and the AUTOMATION_ENABLED kill switch', () => {
  const saved = {};

  beforeEach(() => {
    saved.AUTOMATION_ENABLED = process.env.AUTOMATION_ENABLED;
    clearRegistry();
  });

  afterEach(() => {
    if (saved.AUTOMATION_ENABLED === undefined) delete process.env.AUTOMATION_ENABLED;
    else process.env.AUTOMATION_ENABLED = saved.AUTOMATION_ENABLED;
  });

  async function dueAutomation(kind) {
    return ScheduledJob.create({
      kind,
      targetId: `t-${Math.random().toString(16).slice(2)}`,
      cron: null,
      schedule: { every: { n: 1, unit: 'month' }, runOn: 1, runAt: '09:00', startDate: new Date('2026-01-01T00:00:00Z') },
      timezone: 'Australia/Sydney',
      nextRunAt: new Date('2026-08-11T04:00:00Z'),
    });
  }

  it('leaves an automation schedule due rather than advancing past its slot', async () => {
    delete process.env.AUTOMATION_ENABLED;
    const handler = vi.fn().mockResolvedValue(undefined);
    register(KIND_INVOICE, { handler, policy: AT_LEAST_ONCE });
    const job = await dueAutomation(KIND_INVOICE);

    const summary = await runTick({ now: NOW });

    expect(handler).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ claimed: 0, dispatched: 0, failed: 0, heldBack: 1 });
    const after = await ScheduledJob.findById(job._id).lean();
    // The slot survives, so the period is billed once the switch comes on.
    expect(after.nextRunAt.toISOString()).toBe(job.nextRunAt.toISOString());
    // And it is not made to look broken: a deployment-wide switch is not this
    // workspace's failure.
    expect(after.lastError).toBeNull();
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastRunAt ?? null).toBeNull();
  });

  it('holds both automation kinds back and no others', async () => {
    process.env.AUTOMATION_ENABLED = 'false';
    const handler = vi.fn().mockResolvedValue(undefined);
    register(KIND_INVOICE, { handler, policy: AT_LEAST_ONCE });
    register(KIND_STATEMENT, { handler, policy: AT_LEAST_ONCE });
    register('board_sync_demo', { handler, policy: AT_LEAST_ONCE });
    await dueAutomation(KIND_INVOICE);
    await dueAutomation(KIND_STATEMENT);
    const syncJob = await due('board_sync_demo');

    const summary = await runTick({ now: NOW });

    expect(summary).toMatchObject({ claimed: 1, dispatched: 1, heldBack: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ targetId: syncJob.targetId }));
  });

  it('dispatches automation normally once the switch is on', async () => {
    process.env.AUTOMATION_ENABLED = 'true';
    const handler = vi.fn().mockResolvedValue(undefined);
    register(KIND_INVOICE, { handler, policy: AT_LEAST_ONCE });
    await dueAutomation(KIND_INVOICE);

    const summary = await runTick({ now: NOW });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ claimed: 1, dispatched: 1, heldBack: 0 });
  });

  // A per-kind EventBridge rule ticks with a scope of its own. The switch has
  // to narrow that scope rather than replace it, or an invoice-scoped tick
  // would start claiming statement schedules the moment the switch went off.
  it('intersects the kill switch with a scoped tick rather than widening it', async () => {
    delete process.env.AUTOMATION_ENABLED;
    const handler = vi.fn().mockResolvedValue(undefined);
    register(KIND_INVOICE, { handler, policy: AT_LEAST_ONCE });
    register(KIND_STATEMENT, { handler, policy: AT_LEAST_ONCE });
    await dueAutomation(KIND_INVOICE);
    await dueAutomation(KIND_STATEMENT);

    const summary = await runTick({ now: NOW, kinds: [KIND_INVOICE] });

    expect(handler).not.toHaveBeenCalled();
    // Only the invoice schedule was this tick's to run, so only it is held back.
    expect(summary).toMatchObject({ claimed: 0, heldBack: 1 });
  });

  // Nothing due means nothing held back — the count is a backlog signal, not a
  // count of schedules that exist.
  it('reports no backlog when the held-back kinds have nothing due', async () => {
    delete process.env.AUTOMATION_ENABLED;
    register(KIND_INVOICE, { handler: vi.fn(), policy: AT_LEAST_ONCE });
    await ScheduledJob.create({
      kind: KIND_INVOICE,
      targetId: 'not-due',
      cron: null,
      schedule: { every: { n: 1, unit: 'month' }, runOn: 1, runAt: '09:00', startDate: new Date('2026-01-01T00:00:00Z') },
      timezone: 'Australia/Sydney',
      nextRunAt: new Date('2027-01-01T00:00:00Z'),
    });

    expect(await runTick({ now: NOW })).toMatchObject({ heldBack: 0 });
  });
});

/**
 * The scope arithmetic on its own. Two shapes are needed rather than one
 * because "every kind" has no list to subtract from: an unscoped tick expresses
 * the exclusion negatively ($nin), a scoped one positively ($in).
 */
describe('tickKindScope', () => {
  const saved = {};

  beforeEach(() => { saved.AUTOMATION_ENABLED = process.env.AUTOMATION_ENABLED; });
  afterEach(() => {
    if (saved.AUTOMATION_ENABLED === undefined) delete process.env.AUTOMATION_ENABLED;
    else process.env.AUTOMATION_ENABLED = saved.AUTOMATION_ENABLED;
  });

  it('passes the requested scope through untouched when automation is on', () => {
    process.env.AUTOMATION_ENABLED = 'true';

    expect(tickKindScope(null)).toEqual({ kinds: null, heldKinds: [] });
    expect(tickKindScope([KIND_INVOICE])).toEqual({ kinds: [KIND_INVOICE], heldKinds: [] });
  });

  it.each(['1', 'yes', 'on', 'TRUE', ' true '])('treats %j as on', (value) => {
    process.env.AUTOMATION_ENABLED = value;

    expect(tickKindScope(null).heldKinds).toEqual([]);
  });

  it.each([undefined, '', 'false', '0', 'off', 'ture'])('treats %j as off', (value) => {
    if (value === undefined) delete process.env.AUTOMATION_ENABLED;
    else process.env.AUTOMATION_ENABLED = value;

    expect(tickKindScope(null).heldKinds).toEqual([KIND_INVOICE, KIND_STATEMENT]);
  });

  it('excludes negatively for an unscoped tick', () => {
    delete process.env.AUTOMATION_ENABLED;

    expect(tickKindScope(null)).toEqual({
      kinds: null,
      heldKinds: [KIND_INVOICE, KIND_STATEMENT],
      excludeKinds: [KIND_INVOICE, KIND_STATEMENT],
    });
  });

  it('narrows positively for a scoped tick, and never widens it', () => {
    delete process.env.AUTOMATION_ENABLED;

    // An automation-only rule is left with nothing to claim, which is the
    // point: an empty $in matches nothing rather than everything.
    expect(tickKindScope([KIND_INVOICE])).toEqual({
      kinds: [],
      heldKinds: [KIND_INVOICE],
      excludeKinds: [],
    });
    // A mixed scope keeps the kinds the switch has no say over.
    expect(tickKindScope([KIND_STATEMENT, 'board_sync'])).toEqual({
      kinds: ['board_sync'],
      heldKinds: [KIND_STATEMENT],
      excludeKinds: [],
    });
  });
});
