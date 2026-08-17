import Board from '../../models/Board.js';
import Item from '../../models/Item.js';
import PDFLink from '../../models/PDFLink.js';
import { PDFLINK_TYPE_MONTHLY_STATEMENT } from '../../constants/automation.js';
import { ATTRIBUTE_NAMES } from '../../constants/monthlyStatementAttributes.js';
import { canGenerateMonthlyStatement } from '../../utils/automationBoardFlags.js';
import { previousCalendarMonth } from '../../utils/automationPreviousMonth.js';
import { renderMonthlyStatementPdf } from '../../utils/webhookMonthlyStatementPdfHelpers.js';
import { liveMonthlyStatementDeps } from '../../routes/webhook.js';
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

async function generateOneStatement({
  workspaceId, boardId, participant, period, timezone, periodKey, deps,
}) {
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
    pdfLink: upload.fileUrl,
    createdBy: '',
    isDeleted: false,
    SignatureStatus: 'Unsigned',
  });
  info('Automation', 'Scheduled monthly statement PDF written', {
    workspaceId, boardId, periodKey, participant,
  });
  return { itemId, participant, pdfUrl: upload.fileUrl };
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
      results.push({ itemId, participant, pdfUrl: existing.pdfLink });
      continue;
    }
    results.push(await generateOneStatement({
      workspaceId, boardId, participant, period, timezone, periodKey, deps,
    }));
  }
  return results;
}
