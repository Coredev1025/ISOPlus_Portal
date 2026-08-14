// Scheduled invoices call the same Invoice Generator list + PDF pipelines the
// portal uses. The list window comes from the claimed ScheduledJob picker
// (service delivery dates for the completed schedule period), not leftover
// Invoice Generator UI filters. Quote-shaped items without an approved
// timesheet are not billed. findBillableItems stays for the Xero draft path.

import Board from '../../models/Board.js';
import Business from '../../models/Business.js';
import Item from '../../models/Item.js';
import PDFLink from '../../models/PDFLink.js';
import {
  GENERATOR_LIST_LIMIT,
  INVOICE_NUMBER_TYPE_PDF,
  PDFLINK_TYPE_AGE_CARE_INVOICE,
  PDFLINK_TYPE_NDIS_INVOICE,
} from '../../constants/automation.js';
import { automationPeriodKey } from '../../utils/automationPeriodKey.js';
import { isNdisBoardLabel } from '../../utils/automationBoardFlags.js';
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
import { formatValue } from '../../routes/webhook.js';
import { buildNdisQuotePdfOrders } from '../../utils/ndisQuoteLineHelpers.js';

function invoiceGeneratorListQuery(slot, timezone, schedule, { status = 'pending' } = {}) {
  return {
    status,
    sortBy: 'scheduledServiceDate',
    sortOrder: 'asc',
    page: 1,
    limit: GENERATOR_LIST_LIMIT,
    ...schedulePeriodServiceDeliveryWindow(slot, timezone, schedule),
  };
}

export async function findBillableItems(boardId) {
  const items = await Item.find({ boardId: mongoEq(String(boardId)) }).lean();
  return items.filter((item) => {
    const { ordersArr } = buildNdisQuotePdfOrders(item.data ?? {}, [], formatValue);
    return ordersArr.length > 0;
  });
}

function uniquePdfResults(links) {
  const seen = new Set();
  const results = [];
  for (const link of links) {
    if (!link?.pdfLink || seen.has(link.pdfLink)) continue;
    seen.add(link.pdfLink);
    results.push({
      itemId: link.itemId,
      invoiceNumber: link.invoiceNumber,
      pdfUrl: link.pdfLink,
    });
  }
  return results;
}

async function existingSlotResults(workspaceId, periodKey, type) {
  const links = await PDFLink.find({
    workspaceId: mongoEq(String(workspaceId)),
    periodKey: mongoEq(String(periodKey)),
    type,
  }).lean();
  return uniquePdfResults(links);
}

async function recordPdfLinks({
  workspaceId, itemIds, periodKey, invoiceNumber, pdfUrl, type,
}) {
  await Promise.all(itemIds.map((itemId) => PDFLink.create({
    workspaceId,
    itemId,
    type,
    periodKey,
    invoiceNumber,
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
  return generateAgeCareGeneratorInvoices({
    workspaceId, boardId, periodKey, dates, business, label,
    listQuery: invoiceGeneratorListQuery(slot, timezone, schedule, { status: 'all' }),
  });
}

async function generateNdisGeneratorInvoices({ workspaceId, boardId, periodKey, dates, listQuery }) {
  const existing = await existingSlotResults(workspaceId, periodKey, PDFLINK_TYPE_NDIS_INVOICE);
  const listed = await getNdisInvoiceGeneratorData(
    { workspaceId, boardId, query: listQuery, req: null },
    ndisInvoiceGeneratorListDeps(),
  );
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
      itemIds: group.itemIds,
      periodKey,
      invoiceNumber: generated.invoiceNumber,
      pdfUrl: generated.fileUrl,
      type: PDFLINK_TYPE_NDIS_INVOICE,
    });
    info('Automation', 'Scheduled Invoice Generator PDF written', {
      workspaceId, boardId, periodKey, invoiceNumber: generated.invoiceNumber,
    });
    results.push({
      itemId: group.itemIds[0],
      invoiceNumber: generated.invoiceNumber,
      pdfUrl: generated.fileUrl,
    });
  }
  return uniquePdfResults(results.map((row) => ({
    itemId: row.itemId,
    invoiceNumber: row.invoiceNumber,
    pdfLink: row.pdfUrl,
  })));
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
  const existing = await existingSlotResults(workspaceId, periodKey, PDFLINK_TYPE_AGE_CARE_INVOICE);
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
  const pending = (listed.items || []).filter((row) => !row.invoiceNumber);
  const groups = groupItemIdsByParticipant(pending, { idKey: 'id', participantKey: 'participant' });
  if (groups.length === 0) return existing;

  const results = [...existing];
  const isLowCatBoard = label === 'Care Management - SaH - Low Cat';
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
      itemIds: group.itemIds,
      periodKey,
      invoiceNumber: body.invoiceNumber,
      pdfUrl: body.fileUrl,
      type: PDFLINK_TYPE_AGE_CARE_INVOICE,
    });
    results.push({
      itemId: group.itemIds[0],
      invoiceNumber: body.invoiceNumber,
      pdfUrl: body.fileUrl,
    });
  }
  return uniquePdfResults(results.map((row) => ({
    itemId: row.itemId,
    invoiceNumber: row.invoiceNumber,
    pdfLink: row.pdfUrl,
  })));
}
