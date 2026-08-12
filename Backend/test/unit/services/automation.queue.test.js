import { describe, it, expect, afterEach, vi } from 'vitest';

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
