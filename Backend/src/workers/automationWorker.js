import { Worker } from 'bullmq';

import { KIND_INVOICE, KIND_STATEMENT } from '../constants/automation.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';
import { AUTOMATION_QUEUE_NAME } from '../services/automation/queue.js';
import { deliverEmail } from '../services/email/outbox.js';
import { generateInvoicesForBoard } from '../services/automation/generateDocuments.js';
import { generateStatementsForBoard } from '../services/automation/generateStatements.js';
import { isOfflineMode } from '../services/offlineIsoplus.js';
import { buildRedisConnection } from '../services/redisConnection.js';
import AutomationSettings from '../models/AutomationSettings.js';
import { mongoEq } from '../utils/securityHelpers.js';
import { info, warn } from '../utils/logger.js';

const BLOCK_FOR_KIND = { [KIND_INVOICE]: 'invoice', [KIND_STATEMENT]: 'statement' };

async function generateAttachments(job) {
  const { kind, workspaceId, boardId, periodKey, schedule } = job.data;
  const slot = new Date(job.data.slot);
  const timezone = job.data.timezone || DEFAULT_TIMEZONE;

  if (kind === KIND_INVOICE) {
    const generated = await generateInvoicesForBoard({
      workspaceId, boardId, slot, timezone, periodKey, schedule,
    });
    return generated.map((doc) => doc.pdfUrl);
  }
  if (kind === KIND_STATEMENT) {
    const generated = await generateStatementsForBoard({
      workspaceId, boardId, slot, timezone, periodKey,
    });
    return generated.map((doc) => doc.pdfUrl);
  }
  return [];
}

async function composeAndDeliver(job) {
  const { kind, workspaceId, boardId, periodKey } = job.data;

  const settings = await AutomationSettings.findOne({ workspaceId: mongoEq(workspaceId) }).lean();
  const block = settings?.[BLOCK_FOR_KIND[kind]];
  if (!block?.enabled) {
    warn('Automation', 'Job fired with no enabled settings block; nothing composed', {
      kind, workspaceId, boardId, periodKey,
    });
    return;
  }

  const attachments = await generateAttachments(job);

  if (!isOfflineMode()) {
    warn('Automation', 'Email delivery not implemented (Epic 5 part 4); completing without sending', {
      kind, workspaceId, boardId, periodKey, attachments: attachments.length,
    });
    return;
  }

  const { outboxKey } = await deliverEmail({ kind, workspaceId, boardId, periodKey, block, attachments });
  info('Automation', 'Automation email composed to offline outbox', {
    kind, workspaceId, boardId, periodKey, outboxKey, attachments: attachments.length,
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
