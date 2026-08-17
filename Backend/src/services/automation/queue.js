import { Queue } from 'bullmq';

import { buildRedisConnection } from '../redisConnection.js';
import { info, error } from '../../utils/logger.js';

const LOG_LABEL = 'Automation-Queue';

/**
 * `attempts`/`backoff` mirror sync/queue.js.
 *
 * `removeOnComplete`/`removeOnFail` are deliberately absent, unlike
 * sync/queue.js: BullMQ refuses an add whose jobId it still holds a record of,
 * and that record IS the double-billing guard for a redelivered slot. Evicting
 * a completed job frees its jobId, so the next redelivery bills again.
 */
const AUTOMATION_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000,
  },
};

// Hash tags keep BullMQ's per-queue keys in one Redis Cluster hash slot; without
// the braces its multi-key scripts fail with CROSSSLOT. Same as sync/queue.js.
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
    queue = new Queue(AUTOMATION_QUEUE_NAME, {
      connection: buildRedisConnection(LOG_LABEL),
      defaultJobOptions: AUTOMATION_JOB_OPTIONS,
    });
    // Required, not diagnostic: BullMQ re-emits connection failures as a Queue
    // 'error', and an unlistened EventEmitter 'error' terminates the process.
    queue.on('error', (err) => error(LOG_LABEL, 'Queue error occurred', {
      error: err.message,
      stack: err.stack,
    }));
    info(LOG_LABEL, 'BullMQ automation queue initialized', { queueName: AUTOMATION_QUEUE_NAME });
  }
  return queue;
}
