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
import Business from '../models/Business.js';
import { mongoEq } from '../utils/securityHelpers.js';
import { substituteEmailTemplate } from '../utils/emailTemplateHelpers.js';
import { info, warn } from '../utils/logger.js';

const BLOCK_FOR_KIND = { [KIND_INVOICE]: 'invoice', [KIND_STATEMENT]: 'statement' };

/** Full generator results ({itemId, pdfUrl, invoiceNumber?, participant?}) —
 * the pdfUrls become the attachments, the rest feeds the template vars. */
async function generateDocumentResults(job) {
  const { kind, workspaceId, boardId, periodKey, schedule } = job.data;
  const slot = new Date(job.data.slot);
  const timezone = job.data.timezone || DEFAULT_TIMEZONE;

  if (kind === KIND_INVOICE) {
    return generateInvoicesForBoard({
      workspaceId, boardId, slot, timezone, periodKey, schedule,
    });
  }
  if (kind === KIND_STATEMENT) {
    return generateStatementsForBoard({
      workspaceId, boardId, slot, timezone, periodKey,
    });
  }
  return [];
}

/** Distinct non-empty strings, first-seen order. */
function distinctValues(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

/**
 * Vars for the email spec's dynamic fields. A var is only present when the run
 * actually produced a value for it — substituteEmailTemplate leaves absent
 * tokens intact, so an unresolvable field survives verbatim instead of
 * rendering 'undefined'. {{statement_number}} is deliberately never provided:
 * statements have no number in the data model.
 */
async function buildTemplateVars({ workspaceId, results }) {
  const vars = {};
  const business = await Business.findOne({ workspaceId: mongoEq(String(workspaceId)) }).lean();
  if (business?.name) vars.business_name = business.name;

  const invoiceNumbers = distinctValues(results.map((doc) => doc.invoiceNumber));
  if (invoiceNumbers.length > 0) vars.invoice_number = invoiceNumbers.join(', ');

  const clientNames = distinctValues(results.map((doc) => doc.participant));
  if (clientNames.length > 0) vars.client_name = clientNames.join(', ');

  return vars;
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

  const results = await generateDocumentResults(job);
  const attachments = results.map((doc) => doc.pdfUrl);

  if (!isOfflineMode()) {
    warn('Automation', 'Email delivery not implemented (Epic 5 part 4); completing without sending', {
      kind, workspaceId, boardId, periodKey, attachments: attachments.length,
    });
    return;
  }

  // Substitute dynamic fields at compose time. An empty/absent emailSubject
  // stays falsy through substitution, so the outbox's subject fallback
  // (`kind + ' for board ...'`) still applies.
  const vars = await buildTemplateVars({ workspaceId, results });
  const composedBlock = {
    ...block,
    emailSubject: substituteEmailTemplate(block.emailSubject, vars),
    emailMessage: substituteEmailTemplate(block.emailMessage, vars),
  };

  const { outboxKey } = await deliverEmail({
    kind, workspaceId, boardId, periodKey, block: composedBlock, attachments,
  });
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
