import { Queue } from 'bullmq';

import { buildRedisConnection } from '../redisConnection.js';
import { info, error } from '../../utils/logger.js';

const LOG_LABEL = 'Automation-Queue';

/**
 * Job options for every automation job.
 *
 * `attempts`/`backoff` mirror sync/queue.js. BullMQ's default is one attempt,
 * which for billing means a transient Mongo or S3 error while generating one
 * board's invoices is final: the scheduler has already advanced nextRunAt, so
 * that board's month is silently skipped and nobody finds out until the
 * customer does.
 *
 * The retention settings are deliberately ASYMMETRIC with sync/queue.js, which
 * sets removeOnComplete and removeOnFail. Do not "finish the job" by copying
 * them over.
 *
 * The entire double-billing guarantee is the per-board jobId minted in
 * fanOut.js: an at-least-once redispatch of the same slot collapses into the
 * job already there. BullMQ enforces that by refusing an add whose jobId it
 * still HOLDS A RECORD OF — and removeOnComplete is precisely the setting that
 * throws that record away. Evict the completed job and the jobId is free
 * again, so the next redelivery generates a second set of invoices, with fresh
 * numbers, for the same participants and the same period. The queue therefore
 * grows without bound by design; trimming it is a decision to be made
 * deliberately (by periodKey age, not by count) rather than inherited from the
 * sibling queue.
 */
const AUTOMATION_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000,
  },
};

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
    queue = new Queue(AUTOMATION_QUEUE_NAME, {
      connection: buildRedisConnection(LOG_LABEL),
      defaultJobOptions: AUTOMATION_JOB_OPTIONS,
    });
    // Not optional. BullMQ re-emits its connection's failures as a Queue
    // 'error', and an EventEmitter 'error' with no listener terminates the
    // Node process — here, the API process the scheduler runs in. syncQueue
    // registers the same listener for the same reason.
    queue.on('error', (err) => error(LOG_LABEL, 'Queue error occurred', {
      error: err.message,
      stack: err.stack,
    }));
    info(LOG_LABEL, 'BullMQ automation queue initialized', { queueName: AUTOMATION_QUEUE_NAME });
  }
  return queue;
}
