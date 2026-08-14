import { Worker } from 'bullmq';

import { KIND_INVOICE, KIND_STATEMENT } from '../constants/automation.js';
import { AUTOMATION_QUEUE_NAME } from '../services/automation/queue.js';
import { deliverEmail } from '../services/email/outbox.js';
import { isOfflineMode } from '../services/offlineIsoplus.js';
import { buildRedisConnection } from '../services/redisConnection.js';
import AutomationSettings from '../models/AutomationSettings.js';
import { mongoEq } from '../utils/securityHelpers.js';
import { info, warn } from '../utils/logger.js';

const BLOCK_FOR_KIND = { [KIND_INVOICE]: 'invoice', [KIND_STATEMENT]: 'statement' };

/**
 * The first slice of Epic 5 part 4, replacing the deliberately inert stub —
 * against its pinned test, which said that was the way to replace it.
 *
 * What it does now: for each fanned-out job, offline, it composes the email
 * the workspace's settings block describes and writes it to the offline
 * outbox (services/email/outbox.js), where a person can open and verify it.
 * **Nothing is sent anywhere, in any mode.** Online there is still no
 * transport, and the job completes with a warn rather than throwing — a throw
 * would put every automation job into BullMQ retry against a transport that
 * does not exist. PDF generation (part 3) and real SES delivery replace the
 * body of composeAndDeliver when they land.
 *
 * The queue name is imported rather than written out: it already carries the
 * Redis Cluster hash tag ('{automation}'), and a Worker listening on the wrong
 * name silently processes nothing while the queue grows.
 */
async function composeAndDeliver(job) {
  const { kind, workspaceId, boardId, periodKey } = job.data;

  const settings = await AutomationSettings.findOne({ workspaceId: mongoEq(workspaceId) }).lean();
  const block = settings?.[BLOCK_FOR_KIND[kind]];
  if (!block?.enabled) {
    // Same tolerance as the scheduler handler: a job whose settings vanished
    // or were disabled mid-flight costs a log line, not a retry storm.
    warn('Automation', 'Job fired with no enabled settings block; nothing composed', {
      kind, workspaceId, boardId, periodKey,
    });
    return;
  }

  if (!isOfflineMode()) {
    warn('Automation', 'Email delivery not implemented (Epic 5 part 4); completing without sending', {
      kind, workspaceId, boardId, periodKey,
    });
    return;
  }

  const { outboxKey } = await deliverEmail({ kind, workspaceId, boardId, periodKey, block });
  info('Automation', 'Automation email composed to offline outbox', {
    kind, workspaceId, boardId, periodKey, outboxKey,
  });
}

export function startAutomationWorker() {
  return new Worker(
    AUTOMATION_QUEUE_NAME,
    async (job) => {
      await composeAndDeliver(job);
    },
    { connection: buildRedisConnection() },
  );
}
