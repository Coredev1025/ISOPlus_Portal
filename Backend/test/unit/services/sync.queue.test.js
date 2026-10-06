import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * queue.js does all of its work at import time: it picks a Redis connection
 * shape from the environment, names the queue, and hands BullMQ its default job
 * options. The tests below re-import it under different environments and assert
 * the configuration it produces — that configuration is this module's entire
 * observable contract.
 */

const ORIGINAL_ENV = { ...process.env };

function installRecordingMocks() {
  const record = {
    redisArgs: [],
    clusterArgs: [],
    queueArgs: [],
    redisEvents: [],
    queueEvents: [],
  };

  class RedisMock {
    constructor(...args) {
      record.redisArgs.push(args);
    }

    on(event) {
      record.redisEvents.push(event);
      return this;
    }

    quit() {}

    disconnect() {}

    static Cluster = class ClusterMock {
      constructor(...args) {
        record.clusterArgs.push(args);
      }

      on(event) {
        record.redisEvents.push(event);
        return this;
      }

      quit() {}

      disconnect() {}
    };
  }

  class QueueMock {
    constructor(...args) {
      record.queueArgs.push(args);
      this.name = args[0];
      this.opts = args[1];
    }

    on(event) {
      record.queueEvents.push(event);
      return this;
    }
  }

  vi.doMock('ioredis', () => ({ default: RedisMock }));
  vi.doMock('bullmq', () => ({
    Queue: QueueMock,
    Worker: class WorkerMock {
      on() {}
    },
  }));

  return record;
}

async function loadQueue(env = {}) {
  vi.resetModules();
  for (const key of ['REDIS_HOST', 'REDIS_PORT', 'REDIS_CLUSTER', 'REDIS_TLS', 'REDIS_PASSWORD']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);

  const record = installRecordingMocks();
  const module = await import('../../../src/services/sync/queue.js');
  return { module, record };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('ioredis');
  vi.doUnmock('bullmq');
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

describe('sync queue in single-node mode', () => {
  it('builds a plain Redis connection, not a cluster one', async () => {
    const { record } = await loadQueue();

    expect(record.redisArgs).toHaveLength(1);
    expect(record.clusterArgs).toHaveLength(0);
  });

  it('falls back to localhost:6379 when the environment supplies neither', async () => {
    // Importing the module pulls in the logger, which loads Backend/.env, so an
    // unset variable can be repopulated mid-import. Blank values exercise the
    // same `||` fallback without depending on what .env happens to contain.
    const { record } = await loadQueue({ REDIS_HOST: '', REDIS_PORT: '' });

    expect(record.redisArgs[0][0]).toMatchObject({ host: 'localhost', port: 6379 });
  });

  it('takes the host and port from the environment', async () => {
    const { record } = await loadQueue({ REDIS_HOST: 'redis.internal', REDIS_PORT: '6380' });

    expect(record.redisArgs[0][0]).toMatchObject({ host: 'redis.internal', port: 6380 });
  });

  it('falls back to 6379 when the port is not a number', async () => {
    const { record } = await loadQueue({ REDIS_PORT: 'not-a-port' });

    expect(record.redisArgs[0][0].port).toBe(6379);
  });

  it('disables the per-request retry limit, as BullMQ requires', async () => {
    const { record } = await loadQueue();

    expect(record.redisArgs[0][0].maxRetriesPerRequest).toBeNull();
  });

  it('omits the password key entirely when none is configured', async () => {
    const { record } = await loadQueue();

    expect('password' in record.redisArgs[0][0]).toBe(false);
  });

  it('passes the password through when one is configured', async () => {
    const { record } = await loadQueue({ REDIS_PASSWORD: 's3cret' });

    expect(record.redisArgs[0][0].password).toBe('s3cret');
  });

  it('omits TLS unless REDIS_TLS is exactly "true"', async () => {
    const { record } = await loadQueue({ REDIS_TLS: 'yes' });

    expect('tls' in record.redisArgs[0][0]).toBe(false);
  });

  it('enables TLS when REDIS_TLS is "true"', async () => {
    const { record } = await loadQueue({ REDIS_TLS: 'true' });

    expect(record.redisArgs[0][0].tls).toEqual({ rejectUnauthorized: false });
  });

  it('names the queue "board-sync" without hash tags', async () => {
    const { record } = await loadQueue();

    expect(record.queueArgs[0][0]).toBe('board-sync');
  });

  it('subscribes to the connection lifecycle events', async () => {
    const { record } = await loadQueue();

    expect(record.redisEvents).toEqual(['connect', 'ready', 'error', 'close', 'reconnecting']);
  });

  it('subscribes to the queue error and waiting events', async () => {
    const { record } = await loadQueue();

    expect(record.queueEvents).toEqual(['error', 'waiting']);
  });
});

describe('sync queue in cluster mode', () => {
  it('builds a Redis Cluster connection instead of a plain one', async () => {
    const { record } = await loadQueue({ REDIS_CLUSTER: 'true' });

    expect(record.clusterArgs).toHaveLength(1);
    expect(record.redisArgs).toHaveLength(0);
  });

  it('seeds the cluster with the configured host and port', async () => {
    const { record } = await loadQueue({
      REDIS_CLUSTER: 'true',
      REDIS_HOST: 'cache.aws',
      REDIS_PORT: '6379',
    });

    expect(record.clusterArgs[0][0]).toEqual([{ host: 'cache.aws', port: 6379 }]);
  });

  it('always enables TLS, which ElastiCache Serverless requires', async () => {
    const { record } = await loadQueue({ REDIS_CLUSTER: 'true' });

    expect(record.clusterArgs[0][1].redisOptions.tls).toEqual({});
  });

  it('does not honour REDIS_TLS=false in cluster mode', async () => {
    const { record } = await loadQueue({ REDIS_CLUSTER: 'true', REDIS_TLS: 'false' });

    expect(record.clusterArgs[0][1].redisOptions.tls).toEqual({});
  });

  it('allows 30 seconds for cluster discovery', async () => {
    const { record } = await loadQueue({ REDIS_CLUSTER: 'true' });

    expect(record.clusterArgs[0][1].redisOptions.connectTimeout).toBe(30000);
  });

  it('disables the offline queue so writes fail fast during a failover', async () => {
    const { record } = await loadQueue({ REDIS_CLUSTER: 'true' });

    expect(record.clusterArgs[0][1].enableOfflineQueue).toBe(false);
  });

  it('resolves DNS to the address it was given, as ElastiCache requires', async () => {
    const { record } = await loadQueue({ REDIS_CLUSTER: 'true' });

    const { dnsLookup } = record.clusterArgs[0][1];
    const resolved = await new Promise((resolve) => {
      dnsLookup('node-1.cache.aws', (err, address) => resolve([err, address]));
    });
    expect(resolved).toEqual([null, 'node-1.cache.aws']);
  });

  it('backs off linearly up to a 3 second ceiling on the connection', async () => {
    const { record } = await loadQueue({ REDIS_CLUSTER: 'true' });

    const { retryStrategy } = record.clusterArgs[0][1].redisOptions;
    expect(retryStrategy(1)).toBe(100);
    expect(retryStrategy(10)).toBe(1000);
    expect(retryStrategy(30)).toBe(3000);
    expect(retryStrategy(100)).toBe(3000);
  });

  it('backs off linearly up to a 3 second ceiling on the cluster', async () => {
    const { record } = await loadQueue({ REDIS_CLUSTER: 'true' });

    const { clusterRetryStrategy } = record.clusterArgs[0][1];
    expect(clusterRetryStrategy(1)).toBe(100);
    expect(clusterRetryStrategy(30)).toBe(3000);
    expect(clusterRetryStrategy(1000)).toBe(3000);
  });

  it('hash-tags the queue name so every key lands in one slot', async () => {
    const { record } = await loadQueue({ REDIS_CLUSTER: 'true' });

    expect(record.queueArgs[0][0]).toBe('{board-sync}');
  });

  it('omits the password key entirely when none is configured', async () => {
    const { record } = await loadQueue({ REDIS_CLUSTER: 'true' });

    expect('password' in record.clusterArgs[0][1].redisOptions).toBe(false);
  });

  it('passes the password into redisOptions when configured', async () => {
    const { record } = await loadQueue({ REDIS_CLUSTER: 'true', REDIS_PASSWORD: 's3cret' });

    expect(record.clusterArgs[0][1].redisOptions.password).toBe('s3cret');
  });

  it('additionally subscribes to the cluster node events', async () => {
    const { record } = await loadQueue({ REDIS_CLUSTER: 'true' });

    expect(record.redisEvents).toEqual([
      'connect',
      'ready',
      'error',
      'close',
      'reconnecting',
      '+node',
      '-node',
      'node error',
      'refresh',
    ]);
  });

  it('treats any value other than "true" as single-node', async () => {
    const { record } = await loadQueue({ REDIS_CLUSTER: 'TRUE' });

    expect(record.clusterArgs).toHaveLength(0);
    expect(record.redisArgs).toHaveLength(1);
  });
});

describe('sync queue job options', () => {
  it('retries a failed job three times with exponential backoff from 5 seconds', async () => {
    const { record } = await loadQueue();

    expect(record.queueArgs[0][1].defaultJobOptions).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  });

  it('keeps completed jobs for 24 hours, capped at the last 1000', async () => {
    const { record } = await loadQueue();

    expect(record.queueArgs[0][1].defaultJobOptions.removeOnComplete)
      .toEqual({ age: 86400, count: 1000 });
  });

  it('keeps failed jobs for seven days so a backlog can still be inspected', async () => {
    const { record } = await loadQueue();

    expect(record.queueArgs[0][1].defaultJobOptions.removeOnFail).toEqual({ age: 604800 });
  });

  it('hands the queue the same connection object it built', async () => {
    const { module, record } = await loadQueue();

    expect(record.queueArgs[0][1].connection).toBe(module.redisConnection);
  });
});

describe('sync queue exports', () => {
  it('exports the same queue as both the named and default export', async () => {
    const { module } = await loadQueue();

    expect(module.default).toBe(module.syncQueue);
  });

  it('exports the Redis connection for reuse by the worker', async () => {
    const { module } = await loadQueue();

    expect(module.redisConnection).toBeDefined();
  });
});
