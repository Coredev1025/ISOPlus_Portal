import Board from '../../models/Board.js';
import Item from '../../models/Item.js';
import PDFLink from '../../models/PDFLink.js';
import { PDFLINK_TYPE_MONTHLY_STATEMENT } from '../../constants/automation.js';
import { ATTRIBUTE_NAMES } from '../../constants/monthlyStatementAttributes.js';
import { canGenerateMonthlyStatement } from '../../utils/automationBoardFlags.js';
import { previousCalendarMonth } from '../../utils/automationPreviousMonth.js';
import { renderMonthlyStatementPdf } from '../../utils/webhookMonthlyStatementPdfHelpers.js';
import { liveMonthlyStatementDeps } from '../../routes/webhook.js';
import { claimDocumentNumber } from '../../utils/documentNumberAllocator.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { info, warn } from '../../utils/logger.js';

export async function listStatementParticipants(workspaceId, boardId) {
  const items = await Item.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
  }).select('data').lean();
  const names = new Set();
  for (const item of items) {
    const name = item.data?.[ATTRIBUTE_NAMES.FULL_NAME];
    if (typeof name === 'string' && name.trim()) names.add(name.trim());
  }
  return [...names].sort();
}

function statementItemId(boardId, participant) {
  return `statement:${boardId}:${participant}`;
}

async function existingStatementLinks(workspaceId, periodKey) {
  const existing = await PDFLink.find({
    workspaceId: mongoEq(String(workspaceId)),
    periodKey: mongoEq(String(periodKey)),
    type: PDFLINK_TYPE_MONTHLY_STATEMENT,
  }).lean();
  return new Map(existing.map((link) => [link.itemId, link]));
}

/**
 * Claim the next statement number for this workspace, atomically.
 *
 * The claim lives in utils/documentNumberAllocator.js, shared with both invoice
 * generators. Empty string rather than a throw for a workspace with no Business
 * row: a statement number is a nicety ({{statement_number}} survives verbatim
 * without one), where an invoice cannot go out unnumbered.
 *
 * A run that fails after claiming leaves a gap in the sequence. A gap is
 * cosmetic; a duplicate is a document-identity bug.
 */
async function allocateStatementNumber(workspaceId) {
  return (await claimDocumentNumber(workspaceId, 'statement')) ?? '';
}

async function generateOneStatement({
  workspaceId, boardId, participant, period, timezone, periodKey, deps,
}) {
  const statementNumber = await allocateStatementNumber(workspaceId);
  const upload = await renderMonthlyStatementPdf({
    workspaceId,
    boardId,
    statementData: {
      participant,
      participantProfile: participant,
      month: period.monthLabel,
      monthNumber: period.monthNumber,
      year: period.year,
    },
    timezone,
    deps,
  });
  const itemId = statementItemId(boardId, participant);
  await PDFLink.create({
    workspaceId,
    itemId,
    type: PDFLINK_TYPE_MONTHLY_STATEMENT,
    periodKey,
    // invoiceNumber carries whichever document the row is for: the invoice
    // path writes an invoice number here, this one writes a statement number.
    // Persisting it is what lets a replayed slot hand back the number already
    // on the customer's PDF instead of claiming a second one.
    invoiceNumber: statementNumber,
    pdfLink: upload.fileUrl,
    createdBy: '',
    isDeleted: false,
    SignatureStatus: 'Unsigned',
  });
  info('Automation', 'Scheduled monthly statement PDF written', {
    workspaceId, boardId, periodKey, participant, statementNumber,
  });
  return { itemId, participant, pdfUrl: upload.fileUrl, statementNumber };
}

export async function generateStatementsForBoard({
  workspaceId, boardId, slot, timezone, periodKey,
}) {
  const board = await Board.findOne({ boardId: mongoEq(String(boardId)) }).lean();
  const label = board?.label || '';
  if (!canGenerateMonthlyStatement(label)) {
    warn('Automation', 'Board is not eligible for monthly statements; skipping', {
      workspaceId, boardId, label,
    });
    return [];
  }

  const existingByItemId = await existingStatementLinks(workspaceId, periodKey);
  const period = previousCalendarMonth(slot, timezone);
  const participants = await listStatementParticipants(workspaceId, boardId);
  const deps = liveMonthlyStatementDeps();
  const results = [];

  for (const participant of participants) {
    const itemId = statementItemId(boardId, participant);
    const existing = existingByItemId.get(itemId);
    if (existing) {
      const row = { itemId, participant, pdfUrl: existing.pdfLink };
      // Absent rather than empty for a row written before statements were
      // numbered, so {{statement_number}} survives verbatim instead of
      // rendering blank.
      if (existing.invoiceNumber) row.statementNumber = existing.invoiceNumber;
      results.push(row);
      continue;
    }
    results.push(await generateOneStatement({
      workspaceId, boardId, participant, period, timezone, periodKey, deps,
    }));
  }
  return results;
}
