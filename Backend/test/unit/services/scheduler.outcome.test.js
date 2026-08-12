import { describe, it, expect } from 'vitest';
import ScheduledJob from '../../../src/models/ScheduledJob.js';
import {
  recordSuccess,
  recordFailure,
  MAX_CONSECUTIVE_FAILURES,
} from '../../../src/services/scheduler/outcome.js';
import {
  AT_MOST_ONCE,
  AT_LEAST_ONCE,
} from '../../../src/services/scheduler/registry.js';

const NOW = new Date('2026-08-11T04:05:00Z');

async function makeJob(overrides = {}) {
  return ScheduledJob.create({
    kind: 'demo',
    targetId: `t-${Math.random().toString(16).slice(2)}`,
    cron: '*/30 * * * *',
    timezone: 'Australia/Sydney',
    nextRunAt: new Date('2026-08-11T04:00:00Z'),
    ...overrides,
  });
}

describe('recordSuccess', () => {
  it('clears failure state under at-most-once without touching nextRunAt', async () => {
    // The claim already advanced it; recording success must not advance twice.
    const job = await makeJob({ consecutiveFailures: 3, lastError: 'old' });
    const claimedNextRunAt = job.nextRunAt;

    await recordSuccess(job, AT_MOST_ONCE, NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.consecutiveFailures).toBe(0);
    expect(fresh.lastError).toBeNull();
    expect(fresh.nextRunAt.toISOString()).toBe(claimedNextRunAt.toISOString());
  });

  it('advances nextRunAt under at-least-once, because the claim did not', async () => {
    const job = await makeJob();

    await recordSuccess(job, AT_LEAST_ONCE, NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.nextRunAt.toISOString()).toBe('2026-08-11T04:30:00.000Z');
    expect(fresh.lastRunAt.toISOString()).toBe(NOW.toISOString());
  });
});

describe('recordFailure', () => {
  it('records the error and counts it under at-most-once, losing the slot', async () => {
    const job = await makeJob();
    const claimedNextRunAt = job.nextRunAt;

    await recordFailure(job, AT_MOST_ONCE, new Error('enqueue failed'), NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.lastError).toContain('enqueue failed');
    expect(fresh.consecutiveFailures).toBe(1);
    expect(fresh.nextRunAt.toISOString()).toBe(claimedNextRunAt.toISOString());
    expect(fresh.enabled).toBe(true);
  });

  it('leaves nextRunAt alone under at-least-once so the next tick retries', async () => {
    const job = await makeJob();
    const dueAt = job.nextRunAt;

    await recordFailure(job, AT_LEAST_ONCE, new Error('boom'), NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.nextRunAt.toISOString()).toBe(dueAt.toISOString());
    expect(fresh.consecutiveFailures).toBe(1);
  });

  it('advances anyway once at-least-once has failed too many times in a row', async () => {
    // Without this the slot would be retried on every tick forever, occupying
    // a place in the batch cap.
    const job = await makeJob({
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1,
    });

    await recordFailure(job, AT_LEAST_ONCE, new Error('still broken'), NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(fresh.nextRunAt.toISOString()).toBe('2026-08-11T04:30:00.000Z');
    expect(fresh.enabled).toBe(true);
  });

  it('still records the error and consecutiveFailures when the give-up advance cannot parse the cron', async () => {
    // A row whose cron/timezone stopped parsing (written directly, bypassing
    // upsertSchedule and the model validator) must not make recordFailure
    // itself throw once it tries to advance past MAX_CONSECUTIVE_FAILURES —
    // that throw is what took every other schedule down with it.
    const job = await makeJob({
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1,
    });
    const unparseableJob = { ...job.toObject(), cron: 'not-a-cron' };

    await expect(
      recordFailure(unparseableJob, AT_LEAST_ONCE, new Error('still broken'), NOW),
    ).resolves.toBeUndefined();

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(fresh.lastError).toContain('still broken');
    // The advance itself could not happen, so nextRunAt is left where it was
    // rather than crashing the caller.
    expect(fresh.nextRunAt.toISOString()).toBe(job.nextRunAt.toISOString());
    // ...and since it can never be advanced, it is taken out of the claim
    // query rather than retried on every tick for the rest of time.
    expect(fresh.enabled).toBe(false);
  });

  it('does not overwrite a success that already advanced the slot', async () => {
    // Two instances may both dispatch the same at-least-once slot — that is
    // the guarantee, not a bug. One succeeds, the other fails, and the failure
    // lands second. It must not resurrect lastError or a stale failure count
    // on a schedule that has already moved on.
    const job = await makeJob();
    const stale = job.toObject();

    await recordSuccess(stale, AT_LEAST_ONCE, NOW);
    await recordFailure(stale, AT_LEAST_ONCE, new Error('late failure'), NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.consecutiveFailures).toBe(0);
    expect(fresh.lastError).toBeNull();
    expect(fresh.nextRunAt.toISOString()).toBe('2026-08-11T04:30:00.000Z');
  });

  it('counts a concurrent failure from the stored value, not the value it read before dispatching', async () => {
    // Both instances read consecutiveFailures: 2 and both fail. Deriving the
    // new count in memory writes 3 twice; the second failure is lost.
    const job = await makeJob({ consecutiveFailures: 2 });
    const stale = job.toObject();

    await recordFailure(stale, AT_LEAST_ONCE, new Error('first'), NOW);
    await recordFailure(stale, AT_LEAST_ONCE, new Error('second'), NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.consecutiveFailures).toBe(4);
  });

  it('describes plain objects (not Error instances) usefully without stringifying to [object Object]', async () => {
    const job = await makeJob();
    const plainObj = { code: 'ETIMEDOUT', syscall: 'connect' };

    await recordFailure(job, AT_MOST_ONCE, plainObj, NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.lastError).toContain('ETIMEDOUT');
    expect(fresh.lastError).not.toBe('[object Object]');
  });

  it('describes thrown strings directly without wrapping', async () => {
    const job = await makeJob();

    await recordFailure(job, AT_MOST_ONCE, 'Something went wrong', NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.lastError).toBe('Something went wrong');
  });

  it('handles circular objects without throwing out of recordFailure', async () => {
    const job = await makeJob();
    // Create a circular structure (common in driver/request objects)
    const circular = { msg: 'error' };
    circular.self = circular;

    // This must not throw; recordFailure should survive circular refs gracefully
    await recordFailure(job, AT_MOST_ONCE, circular, NOW);

    const fresh = await ScheduledJob.findById(job._id);
    // Should fall back to String(circular) which produces [object Object],
    // but the important thing is it didn't throw
    expect(fresh.lastError).toBeDefined();
    expect(fresh.consecutiveFailures).toBe(1);
  });
});
