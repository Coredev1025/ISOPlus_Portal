import { Worker } from 'bullmq';

import { AUTOMATION_QUEUE_NAME } from '../services/automation/queue.js';
import { buildRedisConnection } from '../services/redisConnection.js';
import { info } from '../utils/logger.js';

/**
 * INTENTIONALLY INERT. This worker generates nothing and sends nothing.
 *
 * It exists so enqueued jobs are drained and completed rather than
 * accumulating in the queue and triggering BullMQ retry/backoff against a
 * consumer that was never meant to act on them. PDF generation and SES
 * delivery are Epic 5 parts 3-4 and replace the body of this handler.
 *
 * The queue name is imported rather than written out: it already carries the
 * Redis Cluster hash tag ('{automation}'), and a Worker listening on the wrong
 * name silently processes nothing while the queue grows.
 */
export function startAutomationWorker() {
  return new Worker(
    AUTOMATION_QUEUE_NAME,
    async (job) => {
      info('Automation', 'Received automation job (stub — nothing generated or sent)', {
        kind: job.data.kind,
        workspaceId: job.data.workspaceId,
        boardId: job.data.boardId,
        periodKey: job.data.periodKey,
      });
    },
    { connection: buildRedisConnection() },
  );
}
