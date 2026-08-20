import { describe, it, expect, beforeEach, vi } from 'vitest';

import ScheduledJob from '../../../src/models/ScheduledJob.js';
import { runTick } from '../../../src/services/scheduler/tick.js';
import {
  recordSuccess,
  recordFailure,
} from '../../../src/services/scheduler/outcome.js';
import { register, clearRegistry } from '../../../src/services/scheduler/registry.js';
import {
  AT_MOST_ONCE,
  AT_LEAST_ONCE,
  MAX_CONSECUTIVE_FAILURES,
} from '../../../src/constants/scheduler.js';

/**
 * The tick and outcome modules used to call the cron arithmetic directly with
 * `job.cron`, which is NULL for a picker schedule. cron-parser treats a null
 * expression as '* * * * *', so it did not throw — it returned `now + 1
 * minute`. The first picker schedule to exist would therefore have advanced by
 * one minute on every tick and issued invoices every 60 seconds, silently.
 *
 * Every expectation here pins an exact instant. Asserting "nextRunAt is a
 * Date" does not catch this: the bug produces a perfectly valid Date.
 */
const NOW = new Date('2026-08-11T04:05:00Z');
const ONE_MINUTE_LATER = '2026-08-11T04:06:00.000Z';
const TZ = 'Australia/Sydney';

// Every 2 weeks on a Monday at 09:00 Sydney, anchored on Mon 3 Aug 2026. From
// NOW (Tue 11 Aug, 14:05 Sydney) the next slot is Mon 17 Aug 09:00 AEST.
const PICKER = {
  every: { n: 2, unit: 'week' },
  runOn: 'monday',
  runAt: '09:00',
  startDate: new Date('2026-08-03T00:00:00+10:00'),
};
const PICKER_NEXT = '2026-08-16T23:00:00.000Z';

// The cron the existing scheduler tests use, and the instant they pin. Repeated
// here so a picker regression cannot be "fixed" by changing cron behaviour.
const CRON = '*/30 * * * *';
const CRON_NEXT = '2026-08-11T04:30:00.000Z';

function makeJob(overrides = {}) {
  return ScheduledJob.create({
    kind: 'demo',
    targetId: `t-${Math.random().toString(16).slice(2)}`,
    cron: CRON,
    timezone: TZ,
    nextRunAt: new Date('2026-08-11T04:00:00Z'),
    ...overrides,
  });
}

function pickerJob(overrides = {}) {
  return makeJob({ cron: null, schedule: PICKER, ...overrides });
}

/** The lean shape claimNext hands to recordSuccess/recordFailure. */
function asClaimed(job) {
  return ScheduledJob.findById(job._id).lean();
}

describe('the tick advance path', () => {
  beforeEach(() => {
    clearRegistry();
    register('demo', { handler: vi.fn(), policy: AT_MOST_ONCE });
  });

  it('advances a picker schedule by its own arithmetic when claiming it', async () => {
    const job = await pickerJob();

    await runTick({ now: NOW });

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.nextRunAt.toISOString()).toBe(PICKER_NEXT);
    expect(fresh.nextRunAt.toISOString()).not.toBe(ONE_MINUTE_LATER);
  });

  it('advances a cron schedule exactly as it does today', async () => {
    const job = await makeJob();

    await runTick({ now: NOW });

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.nextRunAt.toISOString()).toBe(CRON_NEXT);
  });

  it('counts an overdue picker schedule in its own slots, not by walking a null cron', async () => {
    // countMissedSlots walks a cron iterator and is cron-only by construction.
    // Against a null cron it counted one skipped slot per minute — 1000, the
    // walk cap — for a schedule that had missed at most a handful. That is
    // what this test was originally written to prevent, and still is.
    //
    // It asserted 0 because picker schedules had no missed-slot arithmetic at
    // all. They do now (services/scheduler/missedSlots.js), so the correct
    // answer is the real count: due 1 Aug, ticked 11 Aug, fortnightly from
    // Mon 3 Aug — only Mon 3 Aug went by, and Mon 17 Aug is still ahead.
    const job = await pickerJob({ nextRunAt: new Date('2026-08-01T00:00:00Z') });

    await runTick({ now: NOW });

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.missedRuns).toBe(1);
    // The point of the original assertion, kept explicit: nowhere near the cap.
    expect(fresh.missedRuns).toBeLessThan(10);
    expect(fresh.nextRunAt.toISOString()).toBe(PICKER_NEXT);
  });

  it('still counts missed slots for an overdue cron schedule', async () => {
    const job = await makeJob({ nextRunAt: new Date('2026-08-11T01:00:00Z') });

    await runTick({ now: NOW });

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.missedRuns).toBe(6);
  });
});

describe('recordSuccess', () => {
  it('advances a picker schedule by its own arithmetic', async () => {
    const job = await pickerJob();

    await recordSuccess(await asClaimed(job), AT_LEAST_ONCE, NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.nextRunAt.toISOString()).toBe(PICKER_NEXT);
    expect(fresh.nextRunAt.toISOString()).not.toBe(ONE_MINUTE_LATER);
  });

  it('advances a cron schedule exactly as it does today', async () => {
    const job = await makeJob();

    await recordSuccess(await asClaimed(job), AT_LEAST_ONCE, NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.nextRunAt.toISOString()).toBe(CRON_NEXT);
  });
});

describe('recordFailure past the failure limit', () => {
  it('advances a picker schedule by its own arithmetic', async () => {
    const job = await pickerJob({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1 });

    await recordFailure(await asClaimed(job), AT_LEAST_ONCE, new Error('still broken'), NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.nextRunAt.toISOString()).toBe(PICKER_NEXT);
    expect(fresh.nextRunAt.toISOString()).not.toBe(ONE_MINUTE_LATER);
  });

  it('advances a cron schedule exactly as it does today', async () => {
    const job = await makeJob({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1 });

    await recordFailure(await asClaimed(job), AT_LEAST_ONCE, new Error('still broken'), NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.nextRunAt.toISOString()).toBe(CRON_NEXT);
  });
});
