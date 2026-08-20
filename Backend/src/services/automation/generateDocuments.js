// Scheduled invoices call the same Invoice Generator list + PDF pipelines the
// portal uses. The list window comes from the claimed ScheduledJob picker
// (service delivery dates for the completed schedule period), not leftover
// Invoice Generator UI filters. Quote-shaped items without an approved
// timesheet are not billed.

import Board from '../../models/Board.js';
import Business from '../../models/Business.js';
import Item from '../../models/Item.js';
import PDFLink from '../../models/PDFLink.js';
import {
  GENERATOR_LIST_LIMIT,
  PDFLINK_TYPE_AGE_CARE_INVOICE,
  PDFLINK_TYPE_NDIS_INVOICE,
} from '../../constants/automation.js';
import { automationPeriodKey } from '../../utils/automationPeriodKey.js';
import {
  isCareManagementLabel,
  isLowCatCareManagementLabel,
  isNdisBoardLabel,
} from '../../utils/automationBoardFlags.js';
import { invoiceDatesFromSlot } from '../../utils/automationInvoiceDates.js';
import { groupItemIdsByParticipant } from '../../utils/automationInvoiceGrouping.js';
import { schedulePeriodServiceDeliveryWindow } from '../../utils/automationScheduleWindow.js';
import {
  ageCareInvoiceGeneratorListDeps,
  ndisInvoiceGeneratorListDeps,
} from '../../utils/automationInvoiceGeneratorDeps.js';
import { getNdisInvoiceGeneratorData } from '../../utils/ndisInvoiceGeneratorRouteHelpers.js';
import { getInvoiceGeneratorData } from '../../utils/invoiceGeneratorRouteHelpers.js';
import { generateNdisInvoiceGeneratorPdf } from './ndisInvoiceGeneratorPdf.js';
import { generateParticipantTaxInvoicePdf } from '../../utils/webhookParticipantTaxPdfHelpers.js';
import { liveParticipantTaxDeps } from '../../routes/webhook.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { info, warn } from '../../utils/logger.js';

/**
 * The list window for one claimed slot. `limit` is GENERATOR_LIST_LIMIT — the
 * helpers' "do not paginate" sentinel — because a scheduled run has no Next
 * button: every billable row in the period has to be on the invoice or it is
 * never billed at all.
 */
export function invoiceGeneratorListQuery(slot, timezone, schedule, { status = 'pending' } = {}) {
  return {
    status,
    sortBy: 'scheduledServiceDate',
    sortOrder: 'asc',
    page: 1,
    limit: GENERATOR_LIST_LIMIT,
    ...schedulePeriodServiceDeliveryWindow(slot, timezone, schedule),
  };
}

/**
 * A tripwire, not a filter. Both list helpers report `total` as the size of the
 * filtered set before pagination, so a shorter `items` means the run is looking
 * at part of the period — which is exactly the silent under-billing
 * GENERATOR_LIST_LIMIT exists to prevent.
 *
 * It throws rather than billing what it can see. A partial invoice reads as a
 * complete one to whoever receives it, and the rows it left out fall outside
 * the next run's window, so nothing ever picks them up. A thrown job retries,
 * fails visibly, and leaves the slot unbilled — recoverable, where a
 * half-billed period is not.
 */
export function assertListNotTruncated(listed, context) {
  const returned = (listed?.items || []).length;
  const total = Number(listed?.total ?? returned);
  if (Number.isFinite(total) && total > returned) {
    throw new Error(
      `automation: invoice generator returned ${returned} of ${total} rows for `
      + `board ${context.boardId} slot ${context.periodKey}; refusing to bill part of a period`,
    );
  }
  return returned;
}

function uniquePdfResults(links) {
  const seen = new Set();
  const results = [];
  for (const link of links) {
    const pdfUrl = link?.pdfUrl ?? link?.pdfLink;
    if (!pdfUrl || seen.has(pdfUrl)) continue;
    seen.add(pdfUrl);
    const row = {
      itemId: link.itemId,
      invoiceNumber: link.invoiceNumber,
      pdfUrl,
    };
    // Absent rather than empty: the worker only sets a template var for a value
    // that exists, so {{client_name}} survives verbatim instead of rendering blank.
    if (link.participant) row.participant = link.participant;
    results.push(row);
  }
  return results;
}

/**
 * The slot's already-generated PDFs for one board.
 *
 * `boardId` is matched exactly, which excludes rows written before the field
 * existed: a legacy row sharing this periodKey is the cross-board bleed that
 * attached one board's invoices to another board's email. The cost is that a
 * slot generated before this change regenerates on a replay.
 */
async function existingSlotResults(workspaceId, boardId, periodKey, type) {
  const links = await PDFLink.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    periodKey: mongoEq(String(periodKey)),
    type,
  }).lean();
  return uniquePdfResults(links);
}

async function recordPdfLinks({
  workspaceId, boardId, itemIds, periodKey, invoiceNumber, participant, pdfUrl, type,
}) {
  await Promise.all(itemIds.map((itemId) => PDFLink.create({
    workspaceId,
    boardId,
    itemId,
    type,
    periodKey,
    invoiceNumber,
    participant,
    pdfLink: pdfUrl,
    createdBy: '',
    isDeleted: false,
    SignatureStatus: 'Unsigned',
  })));
}

export async function generateInvoicesForBoard({
  workspaceId, boardId, slot, timezone, periodKey: periodKeyOverride, schedule,
}) {
  const business = await Business.findOne({ workspaceId: mongoEq(String(workspaceId)) });
  if (!business) {
    warn('Automation', 'No business for workspace; nothing generated', { workspaceId, boardId });
    return [];
  }

  const periodKey = periodKeyOverride ?? automationPeriodKey({ slot, timezone });
  const board = await Board.findOne({ boardId: mongoEq(String(boardId)) }).lean();
  const label = board?.label || '';
  const dates = invoiceDatesFromSlot(slot, business.bankDetails?.accountsReceivableTerms);

  if (isNdisBoardLabel(label)) {
    return generateNdisGeneratorInvoices({
      workspaceId, boardId, periodKey, dates,
      listQuery: invoiceGeneratorListQuery(slot, timezone, schedule),
    });
  }
  // Fail closed: a renamed board, an unset label or one deleted between fan-out
  // and processing must not fall through into Age Care participant-tax
  // generation — different template, different pricing, different GST.
  if (!isCareManagementLabel(label)) {
    warn('Automation', 'Board label is not an invoiceable label; skipping', {
      workspaceId, boardId, label,
    });
    return [];
  }
  return generateAgeCareGeneratorInvoices({
    workspaceId, boardId, periodKey, dates, business, label,
    listQuery: invoiceGeneratorListQuery(slot, timezone, schedule, { status: 'all' }),
  });
}

async function generateNdisGeneratorInvoices({ workspaceId, boardId, periodKey, dates, listQuery }) {
  const existing = await existingSlotResults(
    workspaceId, boardId, periodKey, PDFLINK_TYPE_NDIS_INVOICE,
  );
  const listed = await getNdisInvoiceGeneratorData(
    { workspaceId, boardId, query: listQuery, req: null },
    ndisInvoiceGeneratorListDeps(),
  );
  assertListNotTruncated(listed, { boardId, periodKey });
  const groups = groupItemIdsByParticipant(listed.items || [], {
    idKey: 'sourceItemId',
    participantKey: 'participant',
  });
  if (groups.length === 0) return existing;

  const results = [...existing];
  for (const group of groups) {
    const generated = await generateNdisInvoiceGeneratorPdf({
      workspaceId,
      boardId,
      masterItemIds: group.itemIds,
      participantName: group.participant,
      invoiceDate: dates.invoiceDate,
      dueDate: dates.dueDate,
    });
    if (generated.empty) continue;
    await recordPdfLinks({
      workspaceId,
      boardId,
      itemIds: group.itemIds,
      periodKey,
      invoiceNumber: generated.invoiceNumber,
      participant: group.participant,
      pdfUrl: generated.fileUrl,
      type: PDFLINK_TYPE_NDIS_INVOICE,
    });
    info('Automation', 'Scheduled Invoice Generator PDF written', {
      workspaceId, boardId, periodKey, invoiceNumber: generated.invoiceNumber,
    });
    results.push({
      itemId: group.itemIds[0],
      invoiceNumber: generated.invoiceNumber,
      participant: group.participant,
      pdfUrl: generated.fileUrl,
    });
  }
  return uniquePdfResults(results);
}

function captureRes() {
  const captured = { body: null };
  return {
    captured,
    res: {
      status() { return this; },
      json(body) { captured.body = body; return this; },
    },
  };
}

async function generateAgeCareGeneratorInvoices({
  workspaceId, boardId, periodKey, dates, business, label, listQuery,
}) {
  const existing = await existingSlotResults(
    workspaceId, boardId, periodKey, PDFLINK_TYPE_AGE_CARE_INVOICE,
  );
  const listed = await getInvoiceGeneratorData(
    {
      workspaceId,
      boardId,
      query: listQuery,
      req: null,
    },
    ageCareInvoiceGeneratorListDeps(),
  );
  if (listed.error) {
    warn('Automation', 'Invoice Generator list failed', {
      workspaceId, boardId, message: listed.error?.body?.message,
    });
    return existing;
  }
  assertListNotTruncated(listed, { boardId, periodKey });
  const pending = (listed.items || []).filter((row) => !row.invoiceNumber);
  const groups = groupItemIdsByParticipant(pending, { idKey: 'id', participantKey: 'participant' });
  if (groups.length === 0) return existing;

  const results = [...existing];
  const isLowCatBoard = isLowCatCareManagementLabel(label);
  for (const group of groups) {
    const dbItems = await Item.find({
      workspaceId: mongoEq(String(workspaceId)),
      boardId: mongoEq(String(boardId)),
      itemId: { $in: group.itemIds },
    }).lean();
    if (dbItems.length === 0) continue;
    const { res, captured } = captureRes();
    await generateParticipantTaxInvoicePdf({
      req: { body: { invoiceDate: dates.invoiceDate, dueDate: dates.dueDate } },
      res,
      workspaceId,
      boardId,
      business,
      dbItems,
      isLowCatBoard,
      ...liveParticipantTaxDeps(),
    });
    const body = captured.body;
    if (!body?.fileUrl) continue;
    await recordPdfLinks({
      workspaceId,
      boardId,
      itemIds: group.itemIds,
      periodKey,
      invoiceNumber: body.invoiceNumber,
      participant: group.participant,
      pdfUrl: body.fileUrl,
      type: PDFLINK_TYPE_AGE_CARE_INVOICE,
    });
    results.push({
      itemId: group.itemIds[0],
      invoiceNumber: body.invoiceNumber,
      participant: group.participant,
      pdfUrl: body.fileUrl,
    });
  }
  return uniquePdfResults(results);
}
