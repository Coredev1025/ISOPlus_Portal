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
import { info, warn, error } from '../utils/logger.js';

const LOG_LABEL = 'Automation-Worker';
const BLOCK_FOR_KIND = { [KIND_INVOICE]: 'invoice', [KIND_STATEMENT]: 'statement' };

// AutomationSettings.recipient. 'billing_contact' is one message for the whole
// board; this one is one message per participant.
const RECIPIENT_PER_PARTICIPANT = 'client_participant';

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
function buildTemplateVars({ businessName, results }) {
  const vars = {};
  if (businessName) vars.business_name = businessName;

  const invoiceNumbers = distinctValues(results.map((doc) => doc.invoiceNumber));
  if (invoiceNumbers.length > 0) vars.invoice_number = invoiceNumbers.join(', ');

  const clientNames = distinctValues(results.map((doc) => doc.participant));
  if (clientNames.length > 0) vars.client_name = clientNames.join(', ');

  return vars;
}

/**
 * How many messages one job produces, and what goes in each.
 *
 * The generators return one row per participant. Flattening all of them into a
 * single attachments array is correct for `billing_contact` — the provider's
 * own accounts inbox wants the whole board — and catastrophic for
 * `client_participant`, which is an address per person: every participant would
 * receive every other participant's statement, with everyone's names in
 * {{client_name}}. That recipient value is already in the model and the UI, so
 * the shape is fixed here now rather than after the first real send.
 *
 * Rows with no participant (an Age Care invoice group that could not be
 * attributed) collect under a single null key rather than being dropped: a
 * document that cannot be addressed to a person must still reach someone.
 */
function deliveryGroups(block, results) {
  if (block?.recipient !== RECIPIENT_PER_PARTICIPANT) {
    return [{ participant: null, results }];
  }

  const byParticipant = new Map();
  for (const doc of results) {
    const key = doc.participant ?? null;
    if (!byParticipant.has(key)) byParticipant.set(key, []);
    byParticipant.get(key).push(doc);
  }
  return [...byParticipant].map(([participant, rows]) => ({ participant, results: rows }));
}

/**
 * Substitute the dynamic fields at compose time.
 *
 * The subject is plain text and is substituted raw. The message is the
 * rich-text HTML authored in the Finance Settings automation tab and is
 * emailed as HTML, so its substituted values are escaped — a participant
 * named 'Tom & Jerry' must not become a broken entity, and one whose ISO+
 * record carries a stray '<' must not be able to inject markup into mail sent
 * from the provider's own domain. Only the values are escaped, never the
 * author's markup; see utils/emailTemplateHelpers.js.
 *
 * An empty/absent emailSubject stays falsy through substitution, so the
 * outbox's subject fallback (`kind + ' for board ...'`) still applies.
 */
function composeBlock(block, vars) {
  return {
    ...block,
    emailSubject: substituteEmailTemplate(block.emailSubject, vars),
    emailMessage: substituteEmailTemplate(block.emailMessage, vars, { escapeHtml: true }),
  };
}

async function deliverGroup({ kind, workspaceId, boardId, periodKey, block, businessName, group }) {
  const vars = buildTemplateVars({ businessName, results: group.results });
  const attachments = group.results.map((doc) => doc.pdfUrl);

  const { outboxKey } = await deliverEmail({
    kind,
    workspaceId,
    boardId,
    periodKey,
    // Null for a billing-contact run, which is one message per board and keeps
    // its historical key; set per participant so their previews cannot
    // overwrite one another.
    recipientKey: group.participant,
    block: composeBlock(block, vars),
    attachments,
  });
  info('Automation', 'Automation email composed to offline outbox', {
    kind, workspaceId, boardId, periodKey, outboxKey,
    participant: group.participant, attachments: attachments.length,
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

  // Deliverability is checked BEFORE anything is generated, and this ordering
  // is the whole point of the check.
  //
  // Generation is irreversible: it claims invoice numbers off
  // Business.documentNumbering, writes S3 objects and creates PDFLink rows keyed
  // on periodKey. Delivery is what the run is for. Generating first and only
  // then discovering there is no transport — which is what this did — burns
  // real invoice numbers on PDFs nobody receives, and leaves PDFLink rows that
  // make the re-run after SES lands hand back those same stale documents
  // instead of regenerating them.
  //
  // It resolves rather than throws: nothing irreversible happened, and three
  // BullMQ retries per board would only repeat this warning.
  if (!isOfflineMode()) {
    warn('Automation', 'No email transport (SES is Epic 5 part 4); generated nothing rather than discarding it', {
      kind, workspaceId, boardId, periodKey,
    });
    return;
  }

  const results = await generateDocumentResults(job);
  const business = await Business.findOne({ workspaceId: mongoEq(String(workspaceId)) }).lean();

  for (const group of deliveryGroups(block, results)) {
    await deliverGroup({
      kind, workspaceId, boardId, periodKey, block, businessName: business?.name, group,
    });
  }
}

export function startAutomationWorker() {
  const worker = new Worker(
    AUTOMATION_QUEUE_NAME,
    (job) => composeAndDeliver(job),
    {
      connection: buildRedisConnection(LOG_LABEL),
      // Chosen, not inherited. syncWorker.js runs 2; this runs 1 because one
      // automation job renders every PDF for a whole board — an unbounded
      // number of participants — and holds each rendered document in memory as
      // a Buffer before upload. Two of those in parallel on one Elastic
      // Beanstalk instance is how a large workspace exhausts the heap mid-run,
      // and a run that dies after claiming invoice numbers leaves gaps. Cross-
      // board parallelism already comes free from running several instances.
      concurrency: 1,
    },
  );

  // Required, not diagnostic: BullMQ re-emits connection failures as a Worker
  // 'error', and an EventEmitter 'error' with no listener terminates the
  // process — here, the API process src/index.js starts this worker in. Same
  // idiom as syncWorker.js.
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
