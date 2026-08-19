import { Queue } from 'bullmq';

import { AUTOMATION_JOB_RETENTION_SECONDS } from '../../constants/automation.js';
import { buildRedisConnection } from '../redisConnection.js';
import { info, error } from '../../utils/logger.js';

const LOG_LABEL = 'Automation-Queue';

/**
 * `attempts`/`backoff` mirror sync/queue.js.
 *
 * Retention is by AGE ONLY, where sync/queue.js also caps by count. The jobId
 * record is what collapses an at-least-once redelivery of the same slot, and a
 * count cap evicts by recency — so a busy queue could free the jobId of a job
 * that completed minutes ago, inside the window where that redelivery is still
 * plausible. An age cap cannot. See AUTOMATION_JOB_RETENTION_SECONDS for why
 * bounded retention is safe at all: PDFLink's per-slot rows, not the jobId, are
 * what stop a replayed slot from billing twice, and they do not expire.
 */
const AUTOMATION_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000,
  },
  removeOnComplete: { age: AUTOMATION_JOB_RETENTION_SECONDS },
  removeOnFail: { age: AUTOMATION_JOB_RETENTION_SECONDS },
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
