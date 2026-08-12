import { Queue } from 'bullmq';

import { buildRedisConnection } from '../redisConnection.js';

// For Redis Cluster, use hash tags to ensure all keys are in the same hash
// slot — same pattern as sync/queue.js's '{board-sync}'. Without the braces,
// BullMQ's per-queue keys (wait, active, meta, events, ...) can land on
// different shards and Redis Cluster rejects the multi-key scripts BullMQ
// issues with CROSSSLOT.
const useCluster = process.env.REDIS_CLUSTER === 'true';
export const AUTOMATION_QUEUE_NAME = useCluster ? '{automation}' : 'automation';

let queue = null;

/**
 * Deliberately separate from syncQueue (R7): a stuck sync backlog must not
 * delay billing. Lazily constructed so importing this module in a test does
 * not open a Redis connection.
 */
export function getAutomationQueue() {
  if (!queue) {
    queue = new Queue(AUTOMATION_QUEUE_NAME, { connection: buildRedisConnection() });
  }
  return queue;
}
