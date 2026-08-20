import { Worker } from 'bullmq';

import { KIND_INVOICE, KIND_STATEMENT } from '../constants/automation.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';
import { AUTOMATION_QUEUE_NAME } from '../services/automation/queue.js';
import { activeEmailBackendName, deliverEmail } from '../services/email/outbox.js';
import { generateInvoicesForBoard } from '../services/automation/generateDocuments.js';
import { generateStatementsForBoard } from '../services/automation/generateStatements.js';
import {
  pushDraftInvoicesToXero,
  xeroDeliveryPreflight,
} from '../services/automation/pushDraftInvoicesToXero.js';
import { buildRedisConnection } from '../services/redisConnection.js';
import AutomationSettings from '../models/AutomationSettings.js';
import Business from '../models/Business.js';
import { mongoEq } from '../utils/securityHelpers.js';
import { substituteEmailTemplate } from '../utils/emailTemplateHelpers.js';
import { info, warn, error } from '../utils/logger.js';

const LOG_LABEL = 'Automation-Worker';
const BLOCK_FOR_KIND = { [KIND_INVOICE]: 'invoice', [KIND_STATEMENT]: 'statement' };

// AutomationSettings.sendMethod. 'isoplus' composes and emails; this one hands
// the run's invoices to the workspace's accounting platform instead, and sends
// no email for that run.
const SEND_METHOD_ACCOUNTING = 'accounting';

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
 * produced a value — substituteEmailTemplate leaves absent tokens intact, so an
 * unresolvable field survives verbatim instead of rendering 'undefined'. An
 * invoice run has no statement number and a statement run has no invoice
 * number, so each token resolves only for the kind that produced it.
 */
function buildTemplateVars({ businessName, results }) {
  const vars = {};
  if (businessName) vars.business_name = businessName;

  const invoiceNumbers = distinctValues(results.map((doc) => doc.invoiceNumber));
  if (invoiceNumbers.length > 0) vars.invoice_number = invoiceNumbers.join(', ');

  const statementNumbers = distinctValues(results.map((doc) => doc.statementNumber));
  if (statementNumbers.length > 0) vars.statement_number = statementNumbers.join(', ');

  const clientNames = distinctValues(results.map((doc) => doc.participant));
  if (clientNames.length > 0) vars.client_name = clientNames.join(', ');

  return vars;
}

/**
 * How many messages one job produces: one per participant, for every recipient
 * type.
 *
 * `billing_contact` used to flatten the whole board into a single message with
 * no participant, and that was wrong twice over. It cannot be delivered — the
 * recipient type only chooses WHICH address on a participant's profile is used
 * (Billing Email, or their own Email when no Billing Contact is named), so a
 * group with no participant has no profile to read and resolveRecipient
 * answered no_participant_name for the DEFAULT setting, every time. And if it
 * had resolved, one message carrying every participant's invoices addressed to
 * one of them is a cross-client data leak.
 *
 * There is no board-level or workspace-level billing contact to send that
 * shared message to: selectBillingAddress reads a participant profile, and
 * Business.email is the provider's own address, not the client's.
 *
 * A row with no participant collects under a null key rather than being
 * dropped; the generators always carry one, so this is a floor, not a path.
 */
function deliveryGroups(results) {
  const byParticipant = new Map();
  for (const doc of results) {
    const key = doc.participant ?? null;
    if (!byParticipant.has(key)) byParticipant.set(key, []);
    byParticipant.get(key).push(doc);
  }
  return [...byParticipant].map(([participant, rows]) => ({ participant, results: rows }));
}

/**
 * Substitute the dynamic fields at compose time. The subject is plain text; the
 * message is author-written HTML, so its substituted values are escaped — a
 * participant whose ISO+ record carries a stray '<' must not inject markup into
 * mail sent from the provider's own domain. See utils/emailTemplateHelpers.js.
 *
 * An empty emailSubject stays falsy through substitution, so the outbox's
 * subject fallback still applies.
 */
function composeBlock(block, vars) {
  return {
    ...block,
    emailSubject: substituteEmailTemplate(block.emailSubject, vars),
    emailMessage: substituteEmailTemplate(block.emailMessage, vars, { escapeHtml: true }),
  };
}

async function deliverGroup({
  kind, workspaceId, boardId, periodKey, block, businessName, group, bypassEmail = null,
}) {
  const vars = buildTemplateVars({ businessName, results: group.results });
  const attachments = group.results.map((doc) => doc.pdfUrl);

  const result = await deliverEmail({
    kind,
    workspaceId,
    boardId,
    periodKey,
    recipientKey: group.participant,
    block: composeBlock(block, vars),
    attachments,
    // Absent on an ordinary run; when the tick set it, the backend sends here
    // instead of resolving the participant's billing address.
    ...(bypassEmail ? { bypassEmail } : {}),
  });
  // A backend that refuses names a reason, and every reason here is data an
  // operator has to go and fix on a profile — so it is an error, not the info
  // line a successful hand-over gets. The documents survive: their PDFLink rows
  // carry this slot's periodKey, so the next run hands back the same documents
  // rather than minting new invoice numbers, and the status panel keeps showing
  // them as 'generated' until the send succeeds. Nothing is thrown: the other
  // participants' messages have already gone, and a BullMQ retry would send
  // them a second time to fix a profile it cannot reach.
  if (result.delivered === false && result.reason) {
    error('Automation', 'Automation email was not delivered; documents kept for a re-send', {
      kind, workspaceId, boardId, periodKey,
      backend: result.backend,
      reason: result.reason,
      participant: group.participant,
      documents: attachments.length,
    });
    return;
  }

  // One line whichever backend ran: outboxKey for the offline preview,
  // messageId for a real send.
  info('Automation', 'Automation email delivered', {
    kind, workspaceId, boardId, periodKey,
    backend: result.backend,
    delivered: result.delivered,
    outboxKey: result.outboxKey ?? null,
    messageId: result.messageId ?? null,
    participant: group.participant,
    attachments: attachments.length,
  });
}

/**
 * Which delivery route this job takes.
 *
 * Only invoices. Xero has no statement to create here, and the settings tab
 * renders one shared email block for both kinds, so a statement schedule can
 * carry sendMethod 'accounting' without it meaning anything — those runs email,
 * and say so once in the log rather than silently ignoring the setting.
 */
function isAccountingDelivery(kind, block) {
  return kind === KIND_INVOICE && block?.sendMethod === SEND_METHOD_ACCOUNTING;
}

/**
 * Generate the slot's invoices and push them to Xero as DRAFTs; send no email.
 *
 * Deliverability is settled BEFORE generation, exactly as the email route
 * settles activeEmailBackendName(), because generation is irreversible: it
 * claims invoice numbers and writes PDFLink rows keyed on periodKey. A
 * workspace that chose "accounting" without connecting Xero therefore
 * generates nothing rather than burning numbers on drafts it cannot create.
 */
async function deliverToAccountingPlatform(job) {
  const { kind, workspaceId, boardId, periodKey } = job.data;

  const preflight = await xeroDeliveryPreflight({ workspaceId, boardId });
  if (!preflight.ok) {
    // error, not warn: the client explicitly chose this route, so the run
    // producing nothing is a failure an operator has to see and fix. It still
    // resolves — only a human can connect Xero, so retrying would only repeat
    // this line three times.
    error('Automation', 'Accounting delivery is not possible; generated nothing', {
      kind, workspaceId, boardId, periodKey, reason: preflight.reason,
    });
    return;
  }

  const results = await generateDocumentResults(job);
  const pushed = await pushDraftInvoicesToXero({
    workspaceId,
    boardId,
    slot: new Date(job.data.slot),
    // Carried through so the Age Care push can rebuild the SAME list window
    // generation used, rather than guessing at one.
    timezone: job.data.timezone || DEFAULT_TIMEZONE,
    schedule: job.data.schedule,
    periodKey,
    documents: results,
  });
  info('Automation', 'Automation invoices pushed to the accounting platform as drafts', {
    kind, workspaceId, boardId, periodKey, documents: results.length, drafts: pushed.length,
  });
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

  if (isAccountingDelivery(kind, block)) return deliverToAccountingPlatform(job);
  if (block.sendMethod === SEND_METHOD_ACCOUNTING) {
    warn('Automation', 'Statements are always emailed; sendMethod accounting does not apply', {
      kind, workspaceId, boardId, periodKey,
    });
  }

  // Checked BEFORE generation, which is irreversible: it claims invoice numbers
  // and writes PDFLink rows keyed on periodKey, so discovering there is no way
  // to deliver afterwards burns real numbers on PDFs nobody receives and leaves
  // rows that make the re-run hand back those stale documents. Resolves rather
  // than throws — nothing irreversible happened.
  const backend = activeEmailBackendName();
  if (!backend) {
    warn('Automation', 'No email backend configured; generated nothing rather than discarding it', {
      kind, workspaceId, boardId, periodKey,
    });
    return;
  }

  // There is deliberately no second, pre-generation check that the recipients
  // resolve. A recipient is a participant, and the participants are what
  // generation discovers — so the only way to ask beforehand is to run the
  // generators' list step twice. An address that turns out to be missing is
  // handled per message in deliverGroup instead, where the documents are
  // already durable and re-sendable.
  const results = await generateDocumentResults(job);
  const business = await Business.findOne({ workspaceId: mongoEq(String(workspaceId)) }).lean();

  for (const group of deliveryGroups(results)) {
    await deliverGroup({
      kind,
      workspaceId,
      boardId,
      periodKey,
      block,
      businessName: business?.name,
      group,
      bypassEmail: job.data.bypassEmail ?? null,
    });
  }
}

export function startAutomationWorker() {
  const worker = new Worker(
    AUTOMATION_QUEUE_NAME,
    (job) => composeAndDeliver(job),
    {
      connection: buildRedisConnection(LOG_LABEL),
      // 1, not syncWorker.js's 2: one job renders every PDF for a whole board
      // and holds each as a Buffer before upload, so two in parallel exhaust the
      // heap on a large workspace — and a run that dies mid-way leaves number gaps.
      concurrency: 1,
    },
  );

  // Required, not diagnostic: BullMQ re-emits connection failures as a Worker
  // 'error', and an unlistened EventEmitter 'error' terminates the API process
  // this worker runs in. Same idiom as syncWorker.js.
  worker.on('error', (err) => error(LOG_LABEL, 'Worker error', {
    error: err.message, stack: err.stack,
  }));
  worker.on('failed', (job, err) => error(LOG_LABEL, 'Automation job failed', {
    jobId: job?.id,
    kind: job?.data?.kind,
    boardId: job?.data?.boardId,
    periodKey: job?.data?.periodKey,
    attemptsMade: job?.attemptsMade,
    attemptsTotal: job?.opts?.attempts,
    error: err.message,
  }));

  return worker;
}
