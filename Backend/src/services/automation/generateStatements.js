import Board from '../../models/Board.js';
import Item from '../../models/Item.js';
import PDFLink from '../../models/PDFLink.js';
import {
  PDFLINK_TYPE_MONTHLY_STATEMENT,
  PDFLINK_TYPE_STATEMENT_OF_ACCOUNT,
} from '../../constants/automation.js';
import { ATTRIBUTE_NAMES } from '../../constants/monthlyStatementAttributes.js';
import { canGenerateMonthlyStatement } from '../../utils/automationBoardFlags.js';
import { statementPeriodForSchedule } from '../../utils/automationStatementPeriod.js';
import {
  generateStatementOfAccount,
  statementOfAccountItemId,
} from './generateStatementOfAccount.js';
import { renderMonthlyStatementPdf } from '../../utils/webhookMonthlyStatementPdfHelpers.js';
import { liveMonthlyStatementDeps } from '../../routes/webhook.js';
import { claimDocumentNumber } from '../../utils/documentNumberAllocator.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { error, info, warn } from '../../utils/logger.js';

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

async function existingStatementLinks(workspaceId, periodKey, type) {
  const existing = await PDFLink.find({
    workspaceId: mongoEq(String(workspaceId)),
    periodKey: mongoEq(String(periodKey)),
    type,
  }).lean();
  return new Map(existing.map((link) => [link.itemId, link]));
}

/**
 * The result row for a slot already written, handing back the number on the
 * customer's PDF rather than claiming a second one. Absent rather than empty
 * for a row written before statements were numbered, so {{statement_number}}
 * survives verbatim instead of rendering blank.
 */
function replayRow(existing, itemId, participant) {
  const row = { itemId, participant, pdfUrl: existing.pdfLink };
  if (existing.invoiceNumber) row.statementNumber = existing.invoiceNumber;
  return row;
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

/**
 * The statement of account's own sequence, separate from the budget
 * statement's.
 *
 * They shared one until a client asked why an email carried two documents
 * numbered one apart that were different things. A statement number should
 * identify a single series; two document types drawing from one made STM-84
 * and STM-85 read as the same kind of document wherever they were listed.
 */
async function allocateStatementOfAccountNumber(workspaceId) {
  return (await claimDocumentNumber(workspaceId, 'statementOfAccount')) ?? '';
}

async function generateOneStatement({
  workspaceId, boardId, participant, period, timezone, periodKey, deps,
}) {
  // Render before claiming a number. `skipWhenEmpty` hands back null for a
  // client with no budget and no services, whose statement would read $0.00 on
  // every line, and the sequence must not advance for a document that is never
  // issued — the same rule the statement of account states by taking
  // `claimStatementNumber` as a function rather than a number.
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
    skipWhenEmpty: true,
  });
  if (!upload) {
    info('Automation', 'No budget and no services; no monthly statement', {
      workspaceId, boardId, periodKey, participant,
    });
    return null;
  }

  const statementNumber = await allocateStatementNumber(workspaceId);
  const itemId = statementItemId(boardId, participant);
  await PDFLink.create({
    workspaceId,
    itemId,
    // Who the statement is for. The client panel reads this to render
    // "For <name>" beside the document, and without it every budget statement
    // showed "No client recorded" while the statement of account next to it
    // named the person — the two were indistinguishable in the panel and in
    // the inbox. The statement of account path has always stored it.
    participant,
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

/**
 * The statement of account for one participant, or null when there is nothing
 * to state.
 *
 * A replayed slot hands back the row already written rather than claiming a
 * second statement number and uploading a second PDF to the client — the same
 * rule the budget statement above follows, keyed on its own itemId so the two
 * documents replay independently.
 */
async function statementOfAccountFor({
  workspaceId, boardId, participant, timezone, periodKey, accountPeriod, existingAccounts,
}) {
  const itemId = statementOfAccountItemId(boardId, participant);
  const existing = existingAccounts.get(itemId);
  if (existing) return replayRow(existing, itemId, participant);
  return generateStatementOfAccount({
    workspaceId,
    boardId,
    participant,
    period: accountPeriod,
    timezone,
    periodKey,
    claimStatementNumber: () => allocateStatementOfAccountNumber(workspaceId),
    // Shifts carry Participant Full Name. Full Name/Preferred Name is the
    // profile field `listStatementParticipants` already used to find who to
    // state — looking payments up by it never sees Amount Received.
    nameField: ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME,
  });
}

/**
 * One participant's budget statement, or null when the period is not a
 * calendar month and the document therefore cannot be issued for it.
 *
 * A replayed slot hands back the row already written rather than claiming a
 * second statement number and uploading a second PDF.
 */
async function budgetStatementFor({
  workspaceId, boardId, participant, period, timezone, periodKey, deps, existingByItemId,
}) {
  if (!period) return null;
  const itemId = statementItemId(boardId, participant);
  const existing = existingByItemId.get(itemId);
  if (existing) return replayRow(existing, itemId, participant);
  return generateOneStatement({
    workspaceId, boardId, participant, period, timezone, periodKey, deps,
  });
}

export async function generateStatementsForBoard({
  workspaceId, boardId, slot, timezone, periodKey, schedule,
}) {
  const board = await Board.findOne({ boardId: mongoEq(String(boardId)) }).lean();
  const label = board?.label || '';
  if (!canGenerateMonthlyStatement(label)) {
    warn('Automation', 'Board is not eligible for monthly statements; skipping', {
      workspaceId, boardId, label,
    });
    return [];
  }

  const existingByItemId = await existingStatementLinks(
    workspaceId, periodKey, PDFLINK_TYPE_MONTHLY_STATEMENT,
  );
  const existingAccounts = await existingStatementLinks(
    workspaceId, periodKey, PDFLINK_TYPE_STATEMENT_OF_ACCOUNT,
  );
  // Section 4.1: the period follows the configured cadence, not the calendar.
  // The statement of account works in instants, so it takes the window as it
  // is; the budget statement works in a month label and a year, and has one
  // only when the period is a whole calendar month.
  const { window, budgetPeriod } = statementPeriodForSchedule(slot, timezone, schedule);
  const accountPeriod = { start: window.serviceDeliveryStart, end: window.serviceDeliveryEnd };
  if (!budgetPeriod) {
    info('Automation', 'Statement period is not a calendar month; budget statement not issued', {
      workspaceId, boardId, periodKey, every: schedule?.every, window,
    });
  }
  const participants = await listStatementParticipants(workspaceId, boardId);
  const deps = liveMonthlyStatementDeps();
  const results = [];

  for (const participant of participants) {
    const budget = await budgetStatementFor({
      workspaceId,
      boardId,
      participant,
      period: budgetPeriod,
      timezone,
      periodKey,
      deps,
      existingByItemId,
    });
    if (budget) results.push(budget);

    const account = await settledStatementOfAccount({
      workspaceId, boardId, participant, timezone, periodKey, accountPeriod, existingAccounts,
    });
    if (account) results.push(account);
  }
  return results;
}

/**
 * One participant's statement of account, or null if it could not be stated.
 *
 * The account refuses to render when its own figures disagree — section 4.3's
 * check, which a payment against an invoice the ledger has no row for can
 * trip. That is one ISO+ record for an operator to fix, and it must not take
 * the rest of the board with it: thrown from here it failed the BullMQ job,
 * every participant after this one got no budget statement either, and the
 * same record failed every retry. Logged as an error, because it is one, and
 * the run carries on; the budget statement for this participant has already
 * been written above.
 */
async function settledStatementOfAccount(args) {
  try {
    return await statementOfAccountFor(args);
  } catch (err) {
    error('Automation', 'Statement of account could not be stated; continuing with the board', {
      workspaceId: args.workspaceId,
      boardId: args.boardId,
      participant: args.participant,
      periodKey: args.periodKey,
      reason: err?.message,
    });
    return null;
  }
}
