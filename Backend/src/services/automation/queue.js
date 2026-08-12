import { Queue } from 'bullmq';

import { buildRedisConnection } from '../redisConnection.js';

export const AUTOMATION_QUEUE_NAME = 'automation';

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
