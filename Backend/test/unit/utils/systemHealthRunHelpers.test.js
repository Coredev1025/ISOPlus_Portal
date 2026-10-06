import { describe, it, expect, beforeEach } from 'vitest';

import ScheduledJob from '../../../src/models/ScheduledJob.js';
import { KIND_STATEMENT } from '../../../src/constants/automation.js';
import {
  buildManualDispatch,
  buildRetrySpec,
  withForceJobIds,
} from '../../../src/utils/systemHealthRunHelpers.js';

/**
 * BullMQ's rule, from Job.validateOptions:
 *
 *   if (jobId.includes(':') && jobId.split(':').length !== 3)
 *     throw new Error('Custom Id cannot contain :');
 *
 * A colon-joined id is legal only at exactly three parts — a compatibility
 * carve-out for old repeatable jobs. The scheduled fan-out (`inv:board:period`)
 * satisfies it by accident of having exactly two colons; anything that appends
 * a fourth segment throws at enqueue time.
 *
 * Observed on portal-dev 2026-08-27: Retry answered 500 "Could not retry the
 * run" for every failed run, and the forced re-run path was broken the same
 * way. Both are asserted here so neither can regress.
 */
const expectBullMqAccepts = (jobId) => {
  expect(jobId.includes(':') && jobId.split(':').length !== 3).toBe(false);
};

describe('buildRetrySpec', () => {
  const run = {
    _id: 'run-1',
    kind: 'invoice_automation',
    workspaceId: 'ws-1',
    boardId: 'board-a',
    periodKey: '20260116-0900',
    startedAt: new Date('2026-08-13T09:00:00.000Z'),
  };

  it('carries slot, so job.data.slot is not undefined for whoever lands the real worker', () => {
    // buildFanOutSpecs emits `slot` on every scheduled spec (see fanOut.js);
    // a retry spec omitting it means a future reader of job.data.slot gets
    // undefined only on the retry path.
    const spec = buildRetrySpec(run);
    expect(spec.data.slot).toEqual(run.startedAt);
  });

  it('keys the retry under a jobId distinct from the original run', () => {
    const spec = buildRetrySpec(run);
    expect(spec.opts.jobId).toBe(`retry-${run._id}:${run.boardId}:${run.periodKey}`);
    expect(spec.opts.jobId).not.toBe(`inv:${run.boardId}:${run.periodKey}`);
  });

  it('mints a jobId BullMQ will accept', () => {
    expectBullMqAccepts(buildRetrySpec(run).opts.jobId);
  });

  it('keeps retries of different runs apart', () => {
    const other = buildRetrySpec({ ...run, _id: 'run-2' });
    expect(other.opts.jobId).not.toBe(buildRetrySpec(run).opts.jobId);
  });
});

describe('withForceJobIds', () => {
  const specs = [
    { name: 'invoice_automation', data: { boardId: 'b1', periodKey: 'p' }, opts: { jobId: 'inv:b1:p', attempts: 3 } },
  ];

  it('passes specs through unchanged when force is not set', () => {
    expect(withForceJobIds({ specs, force: false, existing: 1 })).toBe(specs);
  });

  it('preserves other opts fanOut may set, rather than replacing opts wholesale', () => {
    // A future fanOut.js option (attempts, backoff, removeOnComplete) must
    // survive a forced re-run, not just jobId.
    const [forced] = withForceJobIds({ specs, force: true, existing: 2 });
    expect(forced.opts).toEqual({ attempts: 3, jobId: 'manual-2:b1:p' });
  });

  it('mints a jobId BullMQ will accept', () => {
    const [forced] = withForceJobIds({ specs, force: true, existing: 2 });
    expectBullMqAccepts(forced.opts.jobId);
  });

  it('keeps successive forced re-runs of one period apart', () => {
    const [first] = withForceJobIds({ specs, force: true, existing: 1 });
    const [second] = withForceJobIds({ specs, force: true, existing: 2 });
    expect(first.opts.jobId).not.toBe(second.opts.jobId);
  });
});

describe('buildManualDispatch', () => {
  beforeEach(async () => {
    await ScheduledJob.deleteMany({});
  });

  /**
   * Observed on portal-dev 2026-09-10: System Health Run now produced SOA-5
   * for E2E Handover covering 1–31 August, with March–May invoices as the
   * opening balance and an empty particulars table. The scheduled tick puts
   * `schedule.every` on the job (scheduler.tick.test.js); this path selected
   * only `timezone` and so `coversOneCalendarMonth` treated a missing picker
   * as "last calendar month".
   */
  it('puts the workspace schedule on the job so a statement run covers that cadence', async () => {
    await ScheduledJob.create({
      kind: KIND_STATEMENT,
      targetId: 'ws-1',
      timezone: 'Australia/Sydney',
      schedule: {
        every: { n: 6, unit: 'month' },
        runOn: 10,
        runAt: '09:00',
        startDate: new Date('2026-03-10T00:00:00+11:00'),
      },
      nextRunAt: new Date('2026-09-10T10:00:00.000Z'),
    });

    const { specs } = await buildManualDispatch({
      kind: KIND_STATEMENT,
      workspaceId: 'ws-1',
      boards: [{ boardId: 'b1' }],
    });

    expect(specs[0].data.schedule).toEqual({
      every: { n: 6, unit: 'month' },
      runOn: 10,
    });
  });
});
