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
});
