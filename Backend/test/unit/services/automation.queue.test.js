import { describe, it, expect, afterEach, vi } from 'vitest';

// Local mocks, overriding the global ones in test/setup.js, because this suite
// asserts on what queue.js *constructs*: the Queue's options and the event
// listeners registered on both the Queue and its ioredis connection. The global
// mocks discard all three.
const { queueCalls, redisInstances } = vi.hoisted(() => ({
  queueCalls: [],
  redisInstances: [],
}));

vi.mock('bullmq', () => {
  class QueueMock {
    constructor(name, opts) {
      this.name = name;
      this.opts = opts;
      this.events = [];
      queueCalls.push(this);
    }

    on(event) {
      this.events.push(event);
      return this;
    }
  }
  class WorkerMock {
    constructor() {}
    on() { return this; }
  }
  return { Queue: QueueMock, Worker: WorkerMock };
});

vi.mock('ioredis', () => {
  class RedisMock {
    constructor() {
      this.events = [];
      redisInstances.push(this);
    }

    static Cluster = class ClusterMock {
      constructor() {
        this.events = [];
        redisInstances.push(this);
      }

      on(event) {
        this.events.push(event);
        return this;
      }

      quit() {}
      disconnect() {}
    };

    on(event) {
      this.events.push(event);
      return this;
    }

    quit() {}
    disconnect() {}
  }
  return { default: RedisMock };
});

async function loadQueueModule() {
  vi.resetModules();
  return import('../../../src/services/automation/queue.js');
}

// Redis Cluster rejects a multi-key Lua script whose keys span hash slots
// unless the key names share a {tag}. BullMQ derives per-queue key names
// (wait, active, meta, events, ...) from the queue name, so under
// REDIS_CLUSTER=true the queue name must be hash-tagged — mirroring the
// established pattern in sync/queue.js ('{board-sync}') and
// workers/syncWorker.js. This test pins both branches so a regression that
// drops the tag (works locally, CROSSSLOTs in production) fails immediately.
describe('AUTOMATION_QUEUE_NAME', () => {
  const originalCluster = process.env.REDIS_CLUSTER;

  afterEach(() => {
    if (originalCluster === undefined) {
      delete process.env.REDIS_CLUSTER;
    } else {
      process.env.REDIS_CLUSTER = originalCluster;
    }
    vi.resetModules();
  });

  it('hash-tags the queue name under Redis Cluster', async () => {
    vi.resetModules();
    process.env.REDIS_CLUSTER = 'true';
    const { AUTOMATION_QUEUE_NAME } = await import('../../../src/services/automation/queue.js');
    expect(AUTOMATION_QUEUE_NAME).toBe('{automation}');
  });

  it('uses the plain name outside Redis Cluster', async () => {
    vi.resetModules();
    delete process.env.REDIS_CLUSTER;
    const { AUTOMATION_QUEUE_NAME } = await import('../../../src/services/automation/queue.js');
    expect(AUTOMATION_QUEUE_NAME).toBe('automation');
  });
});

describe('getAutomationQueue', () => {
  afterEach(() => {
    queueCalls.length = 0;
    redisInstances.length = 0;
    vi.resetModules();
  });

  // An ioredis 'error' event with no listener is an unhandled EventEmitter
  // 'error' — Node terminates the process. The automation queue is constructed
  // inside the API process, so a Redis blip would take the whole API down.
  // sync/queue.js registers these deliberately; this is the same idiom.
  it('registers an error listener on the Redis connection so a blip cannot kill the process', async () => {
    const { getAutomationQueue } = await loadQueueModule();
    getAutomationQueue();

    expect(redisInstances).not.toHaveLength(0);
    expect(redisInstances.at(-1).events).toContain('error');
  });

  it('registers an error listener on the queue itself', async () => {
    const { getAutomationQueue } = await loadQueueModule();
    getAutomationQueue();

    expect(queueCalls).not.toHaveLength(0);
    expect(queueCalls.at(-1).events).toContain('error');
  });

  // BullMQ defaults to attempts: 1. A transient Mongo or S3 error while
  // generating one board's invoices would therefore never be retried — while
  // the scheduler has already advanced nextRunAt, so that board's billing month
  // is silently skipped. sync/queue.js sets 3 attempts with exponential
  // backoff; billing deserves at least as much.
  it('retries a transient failure rather than silently skipping a billing month', async () => {
    const { getAutomationQueue } = await loadQueueModule();
    const queue = getAutomationQueue();

    expect(queue.opts.defaultJobOptions.attempts).toBe(3);
    expect(queue.opts.defaultJobOptions.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  // Deliberately asymmetric with sync/queue.js, which sets both. The whole
  // double-billing guarantee is the per-board jobId from buildFanOutSpecs, and
  // BullMQ only refuses a duplicate jobId while it still HOLDS that job's
  // record. Set removeOnComplete and the record is evicted, the jobId becomes
  // available again, and a redelivered at-least-once dispatch bills the board
  // a second time.
  it('retains completed and failed job records, or the jobId dedupe evaporates', async () => {
    const { getAutomationQueue } = await loadQueueModule();
    const queue = getAutomationQueue();

    expect(queue.opts.defaultJobOptions.removeOnComplete).toBeUndefined();
    expect(queue.opts.defaultJobOptions.removeOnFail).toBeUndefined();
  });

  // The consequence of the retention setting above, spelled out. There is no
  // Redis in this suite, so this models BullMQ's documented jobId semantics —
  // an add whose jobId is already known is discarded, and removeOnComplete is
  // what makes it stop being known — driven by the options queue.js really
  // passes. It fails the moment queue.js starts discarding completed jobs.
  it('discards a re-add of the same spec after that job has completed', async () => {
    const { getAutomationQueue } = await loadQueueModule();
    const { buildFanOutSpecs } = await import('../../../src/services/automation/fanOut.js');
    const { KIND_INVOICE } = await import('../../../src/constants/automation.js');
    const { defaultJobOptions } = getAutomationQueue().opts;

    const [spec] = buildFanOutSpecs({
      kind: KIND_INVOICE,
      workspaceId: 'ws-1',
      boards: [{ boardId: 'b1' }],
      slot: new Date('2026-08-11T23:00:00Z'),
      timezone: 'Australia/Sydney',
    });

    const known = new Set();
    const add = () => {
      if (known.has(spec.opts.jobId)) return null;
      known.add(spec.opts.jobId);
      return spec.opts.jobId;
    };

    expect(add()).toBe(spec.opts.jobId);
    // ...the job completes...
    if (defaultJobOptions.removeOnComplete) known.delete(spec.opts.jobId);

    expect(add()).toBeNull();
  });
});
