import { describe, it, expect, afterEach } from 'vitest';

import { readQueueDepth } from '../../../src/services/automation/queueMetrics.js';
import { QUEUE_DEPTH_WARN } from '../../../src/constants/systemHealth.js';

afterEach(() => {
  globalThis.__BULLMQ_JOB_COUNTS__ = null;
});

describe('readQueueDepth', () => {
  it('reports zeroes for an idle queue', async () => {
    expect(await readQueueDepth()).toMatchObject({
      waiting: 0, active: 0, failed: 0, delayed: 0, total: 0, backlogged: false,
    });
  });

  it('totals the states that represent outstanding work', async () => {
    globalThis.__BULLMQ_JOB_COUNTS__ = {
      waiting: 3, active: 2, delayed: 1, failed: 7, completed: 999,
    };

    const depth = await readQueueDepth();

    // completed is not outstanding work, and failed is reported but not
    // counted as depth — a failed job is not waiting for a worker.
    expect(depth.total).toBe(6);
    expect(depth.failed).toBe(7);
  });

  it('flags a backlog at the threshold, not above it', async () => {
    globalThis.__BULLMQ_JOB_COUNTS__ = { waiting: QUEUE_DEPTH_WARN, active: 0, delayed: 0, failed: 0 };
    expect((await readQueueDepth()).backlogged).toBe(true);

    globalThis.__BULLMQ_JOB_COUNTS__ = { waiting: QUEUE_DEPTH_WARN - 1, active: 0, delayed: 0, failed: 0 };
    expect((await readQueueDepth()).backlogged).toBe(false);
  });

  it('reports zeroes rather than throwing when the queue is unreachable', async () => {
    // Redis being down must degrade one tile, not 500 the whole overview.
    globalThis.__BULLMQ_JOB_COUNTS__ = 'explode';
    const depth = await readQueueDepth();
    expect(depth).toMatchObject({ total: 0, available: false });
  });
});
