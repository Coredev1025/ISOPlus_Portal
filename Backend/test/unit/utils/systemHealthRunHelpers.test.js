import { describe, it, expect } from 'vitest';

import { buildRetrySpec, withForceJobIds } from '../../../src/utils/systemHealthRunHelpers.js';

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
    expect(spec.opts.jobId).toBe(`retry:${run.boardId}:${run.periodKey}:${run._id}`);
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
    expect(forced.opts).toEqual({ attempts: 3, jobId: 'manual:b1:p:2' });
  });
});
