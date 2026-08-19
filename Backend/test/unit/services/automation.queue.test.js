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

  // This test used to pin the opposite — no retention settings at all, so no
  // completed job record is ever evicted — and the expectation was wrong
  // because its premise was incomplete, not because the risk it named is fake.
  //
  // The risk is real: BullMQ only refuses a duplicate jobId while it still
  // HOLDS that job's record, so evicting one frees the id and a redelivered
  // at-least-once dispatch re-enqueues the board. What the original reasoning
  // missed is that the jobId is not the only guard, and not the durable one.
  // A re-run of the same slot regenerates nothing: existingSlotResults hands
  // back the slot's PDFLink rows, the NDIS list asks for `pending` (no invoice
  // number yet), the Age Care list drops rows that already carry one, and
  // existingStatementLinks matches on the statement's own itemId. The jobId
  // saves the WORK; PDFLink is what stops the double bill, and it does not
  // expire.
  //
  // Retaining every job forever therefore bought nothing durable and cost an
  // unbounded Redis key set — one job per board per kind per slot, kept for the
  // life of the deployment.
  it('bounds retained job records without shortening the redelivery window', async () => {
    const { getAutomationQueue } = await loadQueueModule();
    const { AUTOMATION_JOB_RETENTION_SECONDS } = await import('../../../src/constants/automation.js');
    const { defaultJobOptions } = getAutomationQueue().opts;

    expect(defaultJobOptions.removeOnComplete).toEqual({ age: AUTOMATION_JOB_RETENTION_SECONDS });
    expect(defaultJobOptions.removeOnFail).toEqual({ age: AUTOMATION_JOB_RETENTION_SECONDS });
  });

  // `count` is deliberately absent where sync/queue.js sets it. A count cap
  // evicts by recency rather than by age, so a busy queue could drop a job that
  // completed minutes ago — inside the window where an at-least-once
  // redelivery of that very slot is still plausible. Age alone cannot do that.
  it('caps retention by age only, never by count', async () => {
    const { getAutomationQueue } = await loadQueueModule();
    const { defaultJobOptions } = getAutomationQueue().opts;

    expect(defaultJobOptions.removeOnComplete.count).toBeUndefined();
    expect(defaultJobOptions.removeOnFail.count).toBeUndefined();
  });

  // The retention has to outlast every redelivery of a slot by a wide margin.
  // Redeliveries cluster within minutes — the tick re-dispatches an unadvanced
  // slot until it succeeds or gives up at MAX_CONSECUTIVE_FAILURES — so the
  // margin here is measured in months, and a later slot is a different
  // periodKey and therefore a different jobId regardless.
  it('keeps a completed job far longer than any slot can be redelivered', async () => {
    const { AUTOMATION_JOB_RETENTION_SECONDS } = await import('../../../src/constants/automation.js');

    expect(AUTOMATION_JOB_RETENTION_SECONDS).toBeGreaterThanOrEqual(30 * 24 * 3600);
  });

  // The dedupe itself, modelled on BullMQ's documented jobId semantics: an add
  // whose jobId is already known is discarded. Within the retention window
  // that is still exactly what happens, which is the property the eviction
  // change must not break.
  it('discards a re-add of the same spec while that job is still retained', async () => {
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
    // Seconds since the job completed, against the configured age cap.
    const add = (ageSeconds = 0) => {
      if (ageSeconds > defaultJobOptions.removeOnComplete.age) known.delete(spec.opts.jobId);
      if (known.has(spec.opts.jobId)) return null;
      known.add(spec.opts.jobId);
      return spec.opts.jobId;
    };

    expect(add()).toBe(spec.opts.jobId);
    // ...the job completes, and a redelivery arrives minutes later...
    expect(add(600)).toBeNull();
  });
});
