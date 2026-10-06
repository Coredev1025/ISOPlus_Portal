import { Worker } from 'bullmq';

import { KIND_INVOICE, KIND_STATEMENT } from '../constants/automation.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';
import { AUTOMATION_QUEUE_NAME } from '../services/automation/queue.js';
import { activeEmailBackendName, deliverEmail } from '../services/email/outbox.js';
import { recordEmailFailure } from '../services/email/deliveryEvents.js';
import { generateInvoicesForBoard } from '../services/automation/generateDocuments.js';
import { generateStatementsForBoard } from '../services/automation/generateStatements.js';
import {
  pushDraftInvoicesToXero,
  xeroDeliveryPreflight,
} from '../services/automation/pushDraftInvoicesToXero.js';
import { buildRedisConnection } from '../services/redisConnection.js';
import AutomationSettings from '../models/AutomationSettings.js';
import Board from '../models/Board.js';
import Business from '../models/Business.js';
import { mongoEq } from '../utils/securityHelpers.js';
import { substituteEmailTemplate } from '../utils/emailTemplateHelpers.js';
import { markRunFailed, markRunSkipped, markRunSucceeded } from '../services/automation/runs.js';
import {
  SKIP_ACCOUNTING_NOT_CONNECTED,
  SKIP_NO_EMAIL_BACKEND,
  SKIP_SETTINGS_DISABLED,
  OUTCOME_NO_DOCUMENTS,
  OUTCOME_NO_EMAILS_SENT,
} from '../constants/systemHealth.js';
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
    // The schedule goes to both kinds: it is what tells a statement run
    // whether the period it covers is a week or a calendar month.
    return generateStatementsForBoard({
      workspaceId, boardId, slot, timezone, periodKey, schedule,
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
 * How many messages one job produces: one per participant PROFILE (KAN-293). A
 * document that carries no profile id, such as a statement, is grouped by
 * participant name instead.
 *
 * Flattening the whole board into a single message with no participant would
 * be wrong twice over. It cannot be delivered — resolveRecipient reads a
 * participant profile Item, found by profile id or else by participant display
 * name (KAN-272: Case A/AA/B off that profile's Billing Email, falling back to
 * their own Email), so a group with neither has no profile to read and
 * resolveRecipient answers no_participant_name every time. And if it had resolved, one message
 * carrying every participant's invoices addressed to one of them is a
 * cross-client data leak.
 *
 * There is no board-level or workspace-level billing contact to send that
 * shared message to: selectProfileAddress reads a participant profile, and
 * Business.email is the provider's own address, not the client's.
 *
 * A row with no participant collects under a null key rather than being
 * dropped; the generators always carry one, so this is a floor, not a path.
 */
function deliveryGroups(results) {
  const byRecipient = new Map();
  for (const doc of results) {
    // KAN-293: an item belongs to one Participant Profile and a profile has one
    // address, so a document that knows its profile is grouped, and addressed,
    // by it. The name is only the label: two clients can share one. Documents
    // with no profile id (statements) are grouped by name, as they always were.
    const key = doc.profileId ? `profile:${doc.profileId}` : `name:${doc.participant ?? ''}`;
    if (!byRecipient.has(key)) {
      byRecipient.set(key, { participant: doc.participant ?? null, profileId: doc.profileId, results: [] });
    }
    byRecipient.get(key).results.push(doc);
  }
  return [...byRecipient.values()];
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
  kind, workspaceId, boardId, periodKey, block, businessName, boardName, group,
  bypassEmail = null,
}) {
  const vars = buildTemplateVars({ businessName, results: group.results });
  const attachments = group.results.map((doc) => doc.pdfUrl);

  const result = await deliverEmail({
    kind,
    workspaceId,
    boardId,
    periodKey,
    recipientKey: group.participant,
    // Absent for a document that carries no profile (a statement): the recipient
    // is then found by name, as before.
    ...(group.profileId ? { recipientProfileId: group.profileId } : {}),
    block: composeBlock(block, vars),
    attachments,
    // Context for the default subject and body, used only when the workspace
    // has written none of its own.
    businessName,
    boardName,
    documentNumbers: group.results
      .map((doc) => doc.invoiceNumber || doc.statementNumber)
      .filter(Boolean),
    // Absent on an ordinary run; when the tick set it, the backend sends here
    // instead of resolving the participant's billing address.
    ...(bypassEmail ? { bypassEmail } : {}),
  });
  // A backend that refuses names a reason, and every reason here is data an
  // operator has to go and fix on a profile — so it is an error, not the info
  // line a successful hand-over gets. The documents survive: their PDFLink rows
  // carry this slot's periodKey, so the next run hands back the same documents
  // rather than minting new invoice numbers. Nothing is thrown: the other
  // participants' messages have already gone, and a BullMQ retry would send
  // them a second time to fix a profile it cannot reach.
  //
  // The documents are also STAMPED, which they previously were not. Leaving
  // them at the default 'generated' meant the status panel — muted badge, and
  // deliberately "never as an error" — reported a run that reached nobody as
  // healthy. A refusal is exactly the delivery problem Epic 5 asks to be
  // flagged against the send, so it is recorded where the client reads it and
  // not only in a log they cannot see. A later successful re-send clears it.
  if (result.delivered === false && result.reason) {
    error('Automation', 'Automation email was not delivered; documents kept for a re-send', {
      kind, workspaceId, boardId, periodKey,
      backend: result.backend,
      reason: result.reason,
      participant: group.participant,
      documents: attachments.length,
    });
    await recordEmailFailure({ workspaceId, documentUrls: attachments, reason: result.reason });
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
 * Only invoices. Xero has no statement to create here. The settings API has
 * refused 'accounting' on a statement since KAN-44, but a row saved before
 * that can still carry it — those runs email, and say so once in the log
 * rather than silently ignoring the setting.
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
    return { skipReason: SKIP_ACCOUNTING_NOT_CONNECTED };
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
  // No recipient: this route creates drafts in Xero and emails nobody. It
  // still says why it was quiet (KAN-267), or System Health shows the bare
  // "No emails were sent for this run" for a run that did exactly its job.
  return {
    recipient: null,
    outcomeReason: results.length === 0 ? OUTCOME_NO_DOCUMENTS : OUTCOME_NO_EMAILS_SENT,
  };
}

async function composeAndDeliver(job) {
  const { kind, workspaceId, boardId, periodKey } = job.data;

  const settings = await AutomationSettings.findOne({ workspaceId: mongoEq(workspaceId) }).lean();
  const block = settings?.[BLOCK_FOR_KIND[kind]];
  if (!block?.enabled) {
    warn('Automation', 'Job fired with no enabled settings block; nothing composed', {
      kind, workspaceId, boardId, periodKey,
    });
    return { skipReason: SKIP_SETTINGS_DISABLED };
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
    return { skipReason: SKIP_NO_EMAIL_BACKEND };
  }

  // There is deliberately no second, pre-generation check that the recipients
  // resolve. A recipient is a participant, and the participants are what
  // generation discovers — so the only way to ask beforehand is to run the
  // generators' list step twice. An address that turns out to be missing is
  // handled per message in deliverGroup instead, where the documents are
  // already durable and re-sendable.
  const results = await generateDocumentResults(job);
  const business = await Business.findOne({ workspaceId: mongoEq(String(workspaceId)) }).lean();
  // The board's own name, for the default subject and body. `label` is the
  // billing-facing name ("Care Management - NDIS - Certification") and `name`
  // the display one; either beats the boardId these emails used to quote.
  const board = await Board.findOne({ boardId: mongoEq(String(boardId)) }).lean();

  const groups = deliveryGroups(results);

  // KAN-267. A run that generated nothing closes Succeeded and is silent —
  // correctly — so it says so, instead of System Health showing a bare "No
  // emails were sent for this run". That is by far the common case and the
  // one the ticket was raised for. Documents that were generated always have
  // a delivery group here (deliveryGroups makes one per document); the other
  // quiet outcome, documents that went to the accounting platform, is
  // reported by deliverToAccountingPlatform, which returns before this point.
  const outcomeReason = results.length === 0 ? OUTCOME_NO_DOCUMENTS : null;
  for (const group of groups) {
    await deliverGroup({
      kind,
      workspaceId,
      boardId,
      periodKey,
      block,
      businessName: business?.name,
      boardName: board?.label || board?.name || null,
      group,
      bypassEmail: job.data.bypassEmail ?? null,
    });
  }

  // The recipient KEY this run delivered under, not an address: deliverEmail
  // resolves addresses inside the backend and does not hand one back. Null for
  // the billing-contact route, which is one message with no per-person key.
  return {
    recipient: distinctValues(groups.map((g) => g.participant)).join(', ') || null,
    outcomeReason,
  };
}

/**
 * Close the AutomationRun this job was recorded under.
 *
 * The bookkeeping is deliberately outside composeAndDeliver: that function's
 * job is to generate and send, and threading a run id through every early
 * return would put it in the business of its own audit trail.
 *
 * Failure is recorded only on the LAST attempt. closeRun refuses to overwrite
 * a terminal row (services/automation/runs.js), so marking failed on attempt 1
 * of 3 would lock the run as failed even when attempt 2 delivers — the run
 * history would then contradict the mail the client actually received.
 */
async function processAutomationJob(job) {
  const attemptsTotal = job.opts?.attempts ?? 1;
  // attemptsMade is absent on a hand-built job object; 0 makes this the first
  // AND last attempt, which is what a single-shot dispatch is.
  const isLastAttempt = (job.attemptsMade ?? 0) + 1 >= attemptsTotal;

  try {
    const outcome = await composeAndDeliver(job);
    if (outcome?.skipReason) {
      await markRunSkipped({ jobId: job.id, skipReason: outcome.skipReason });
    } else {
      await markRunSucceeded({
        jobId: job.id,
        recipient: outcome?.recipient ?? null,
        outcomeReason: outcome?.outcomeReason ?? null,
      });
    }
  } catch (err) {
    if (isLastAttempt) await markRunFailed({ jobId: job.id, error: err.message });
    // Rethrown either way: BullMQ owns the retry decision, and swallowing here
    // would retire a job that never did its work.
    throw err;
  }
}

export function startAutomationWorker() {
  const worker = new Worker(
    AUTOMATION_QUEUE_NAME,
    (job) => processAutomationJob(job),
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
