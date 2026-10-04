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
import { issueInvoice } from '../../utils/invoiceLedger/issue.js';
import { lineAmountsFrom } from '../../utils/invoiceLedger/lineAmounts.js';
import { INVOICE_KIND, INVOICE_TRIGGER } from '../../constants/invoiceLedger.js';
import {
  attachProfileIds,
  generateGroupsIsolated,
  groupBillableRowsByProfile,
} from '../../utils/automationInvoiceProfiles.js';
import { selectBillableItemIds } from '../../utils/automationItemSelection.js';
import { invoiceTypeFromBoardLabel } from '../../utils/invoiceTypeFromLabel.js';
import { reportStaleClaims } from '../../utils/staleInvoiceClaims.js';
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

/**
 * The listed rows that selection says are billable, in the order they were
 * listed.
 *
 * The list query decides what the period CONTAINS; section 2's date-and-status
 * conditions decide what of it is BILLABLE. Applied here, once, in front of
 * both generators, so neither has to know the rule.
 */
async function billableRows({
  workspaceId, boardId, rows, idKey, invoiceType, period,
}) {
  const billable = new Set(await selectBillableItemIds({
    workspaceId,
    boardId,
    itemIds: rows.map((row) => row[idKey]),
    invoiceType,
    period,
  }));
  return rows.filter((row) => billable.has(row[idKey]));
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
    if (link.profileId) row.profileId = link.profileId;
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
  return attachProfileIds(workspaceId, boardId, uniquePdfResults(links));
}

/**
 * `period` and `invoiceType` are the audit trail of section 3.2: periodKey is
 * the slot's identity, these are the bounds selection actually ran against and
 * the conditions it ran under. A schedule that later changes cadence cannot be
 * used to re-derive them, so they are stored rather than recomputed.
 *
 * The unique index automation_period_item_unique makes a duplicate row here
 * throw rather than silently double-record. That is the intended behaviour: a
 * replayed slot should have been caught by existingSlotResults before reaching
 * this point, so a collision means something upstream is wrong and the job
 * should fail visibly.
 */
export async function recordPdfLinks({
  workspaceId, boardId, itemIds, periodKey, invoiceNumber, participant, pdfUrl, type,
  period, invoiceType, invoiceTotal, invoiceDate,
}) {
  await Promise.all(itemIds.map((itemId) => PDFLink.create({
    workspaceId,
    boardId,
    itemId,
    type,
    periodKey,
    periodStart: period?.start ? new Date(period.start) : undefined,
    periodEnd: period?.end ? new Date(period.end) : undefined,
    invoiceType: invoiceType ?? undefined,
    // The figure the invoice billed, so the statement never has to recompute
    // it — the Age Care total in particular depends on whether the board is
    // Low Cat. It is the whole document's total and it is stamped on every one
    // of the invoice's rows, because there is one row per itemId and no row
    // that stands for the document on its own. Any reader summing these must
    // therefore dedupe by `pdfLink` first; `participantInvoices` does.

    invoiceTotal: Number.isFinite(Number(invoiceTotal)) ? Number(invoiceTotal) : undefined,
    invoiceNumber,
    // The date printed on the invoice, which is the slot this run billed.
    // Stored so the statement dates the charge by the document rather than by
    // the moment this row was written — they differ for any slot that did not
    // fire on time.
    invoiceDate: invoiceDate ? new Date(invoiceDate) : undefined,
    participant,
    pdfLink: pdfUrl,
    createdBy: '',
    isDeleted: false,
    SignatureStatus: 'Unsigned',
  })));
}

/**
 * Section 3.5: a period with nothing to bill produces no invoice and no email,
 * and the decision is logged. Both empty-selection exits used to return in
 * silence while the early exits above them logged, so a period that correctly
 * had nothing to bill read exactly like one that selected nothing because a
 * status alias or a date field was missing — the run closes Succeeded either
 * way, and the under-billing goes unnoticed.
 *
 * `listed` is the size of the list the window returned before selection ran,
 * which is what separates the two: 0 means the period was empty, a positive
 * number means selection rejected everything in it.
 */
function logEmptySelection({ workspaceId, boardId, periodKey, period, invoiceType, listed }) {
  info('Automation', 'No billable items for the period; no invoice and no email', {
    workspaceId,
    boardId,
    periodKey,
    invoiceType,
    periodStart: period?.start,
    periodEnd: period?.end,
    listed,
  });
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

  // Before selecting anything, say what this run is about to skip and cannot
  // bill. A `pending:` token older than the cutoff belongs to a run that died
  // between its claim and its release (utils/staleInvoiceClaims.js), and those
  // items are excluded from this invoice and from every one after it. The run
  // continues — the rest of the period is still billable, and clearing the
  // token automatically would risk double billing a run that is merely slow.
  await reportStaleClaims({ workspaceId, boardId });

  const board = await Board.findOne({ boardId: mongoEq(String(boardId)) }).lean();
  const label = board?.label || '';
  const dates = invoiceDatesFromSlot(slot, business.bankDetails?.accountsReceivableTerms);

  // The same window the list query filters on, kept so the bounds selection ran
  // against can be stored on each document. Recomputed rather than threaded out
  // of invoiceGeneratorListQuery because the call is pure and cheap, and
  // changing that function's signature would churn its callers and tests.
  const window = schedulePeriodServiceDeliveryWindow(slot, timezone, schedule);
  const period = { start: window.serviceDeliveryStart, end: window.serviceDeliveryEnd };
  const invoiceType = invoiceTypeFromBoardLabel(label);

  if (isNdisBoardLabel(label)) {
    return generateNdisGeneratorInvoices({
      workspaceId, boardId, periodKey, dates, period, invoiceType,
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
    workspaceId, boardId, periodKey, dates, business, label, period, invoiceType,
    listQuery: invoiceGeneratorListQuery(slot, timezone, schedule, { status: 'all' }),
  });
}

async function generateNdisGeneratorInvoices({
  workspaceId, boardId, periodKey, dates, listQuery, period, invoiceType,
}) {
  const existing = await existingSlotResults(
    workspaceId, boardId, periodKey, PDFLINK_TYPE_NDIS_INVOICE,
  );
  const listed = await getNdisInvoiceGeneratorData(
    { workspaceId, boardId, query: listQuery, req: null },
    ndisInvoiceGeneratorListDeps(),
  );
  assertListNotTruncated(listed, { boardId, periodKey });
  const selected = await billableRows({
    workspaceId, boardId, rows: listed.items || [], idKey: 'sourceItemId', invoiceType, period,
  });
  const groups = await groupBillableRowsByProfile({
    workspaceId, boardId, periodKey, rows: selected, idKey: 'sourceItemId',
  });
  if (groups.length === 0) {
    logEmptySelection({
      workspaceId, boardId, periodKey, period, invoiceType, listed: (listed.items || []).length,
    });
    return existing;
  }

  const results = [...existing];
  // What each item billed, for the invoice record's lines.
  const lineAmounts = lineAmountsFrom(selected, 'sourceItemId', (row) => row.totalAmount);
  await generateGroupsIsolated(groups, async (group) => {
    // The claim is what stops a second run billing these items again, and it
    // hands the generator only the items it actually took — anything another
    // invoice already holds is left off this PDF rather than double billed.
    const generated = await issueInvoice({
      workspaceId,
      boardId,
      itemIds: group.itemIds,
      type: PDFLINK_TYPE_NDIS_INVOICE,
      periodKey,
      participant: { profileId: group.profileId, name: group.participant },
      kind: INVOICE_KIND.NDIS,
      trigger: INVOICE_TRIGGER.AUTOMATION,
      lineAmounts,
      invoiceDate: dates.invoiceDate,
      dueDate: dates.dueDate,
      periodStart: period?.start,
      periodEnd: period?.end,
      produce: (claimedItemIds) => generateNdisInvoiceGeneratorPdf({
        workspaceId,
        boardId,
        masterItemIds: claimedItemIds,
        participantName: group.participant,
        invoiceDate: dates.invoiceDate,
        dueDate: dates.dueDate,
        period,
      }),
      // Written while the provisional token is still held, so the marker never
      // names a document the ledger has no row for.
      record: (document, claimedItemIds) => recordPdfLinks({
        workspaceId,
        boardId,
        itemIds: claimedItemIds,
        periodKey,
        period,
        invoiceType,
        invoiceNumber: document.invoiceNumber,
        invoiceTotal: document.invoiceTotal,
        invoiceDate: dates.invoiceDate,
        participant: group.participant,
        pdfUrl: document.fileUrl,
        type: PDFLINK_TYPE_NDIS_INVOICE,
      }),
    });
    // Null covers both "everything was already invoiced" and "the generator
    // found nothing billable". Section 3.5: no invoice, no email, and the run
    // still completes so the period is not retried forever.
    if (!generated) return;
    info('Automation', 'Scheduled Invoice Generator PDF written', {
      workspaceId, boardId, periodKey, invoiceNumber: generated.invoiceNumber,
    });
    results.push({
      itemId: generated.itemIds[0],
      invoiceNumber: generated.invoiceNumber,
      participant: group.participant,
      profileId: group.profileId,
      pdfUrl: generated.fileUrl,
    });
  });
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

/**
 * One Age Care participant tax invoice, shaped like the NDIS generator's
 * return value so both can run through generateUnderClaim.
 *
 * `generateParticipantTaxInvoicePdf` answers through an Express-style `res`
 * rather than returning, which is why captureRes exists. Normalising it here
 * keeps that quirk out of the claim helper.
 */
async function produceAgeCareInvoice({
  workspaceId, boardId, business, dates, isLowCatBoard, itemIds, period = null,
}) {
  const dbItems = await Item.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    itemId: { $in: itemIds.map((id) => mongoEq(String(id))) },
  }).lean();
  if (dbItems.length === 0) return { empty: true };

  const { res, captured } = captureRes();
  await generateParticipantTaxInvoicePdf({
    req: { body: { invoiceDate: dates.invoiceDate, dueDate: dates.dueDate, period } },
    res,
    workspaceId,
    boardId,
    business,
    dbItems,
    isLowCatBoard,
    ...liveParticipantTaxDeps(),
  });
  const body = captured.body;
  if (!body?.fileUrl) return { empty: true };
  return {
    invoiceNumber: body.invoiceNumber,
    fileUrl: body.fileUrl,
    invoiceTotal: body.invoiceTotal,
  };
}

async function generateAgeCareGeneratorInvoices({
  workspaceId, boardId, periodKey, dates, business, label, listQuery, period, invoiceType,
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
  const selected = await billableRows({
    workspaceId, boardId, rows: pending, idKey: 'id', invoiceType, period,
  });
  const groups = await groupBillableRowsByProfile({
    workspaceId, boardId, periodKey, rows: selected, idKey: 'id',
  });
  if (groups.length === 0) {
    logEmptySelection({
      workspaceId, boardId, periodKey, period, invoiceType, listed: pending.length,
    });
    return existing;
  }

  const results = [...existing];
  const isLowCatBoard = isLowCatCareManagementLabel(label);
  // Low Cat bills the full amount, every other Age Care board the participant contribution.
  const lineAmounts = lineAmountsFrom(
    selected, 'id', (row) => (isLowCatBoard ? row.totalAmount : row.participantContribution),
  );
  await generateGroupsIsolated(groups, async (group) => {
    const generated = await issueInvoice({
      workspaceId,
      boardId,
      itemIds: group.itemIds,
      type: PDFLINK_TYPE_AGE_CARE_INVOICE,
      periodKey,
      participant: { profileId: group.profileId, name: group.participant },
      kind: INVOICE_KIND.AGE_CARE,
      trigger: INVOICE_TRIGGER.AUTOMATION,
      lowCat: isLowCatBoard,
      lineAmounts,
      invoiceDate: dates.invoiceDate,
      dueDate: dates.dueDate,
      periodStart: period?.start,
      periodEnd: period?.end,
      produce: (claimedItemIds) => produceAgeCareInvoice({
        workspaceId, boardId, business, dates, isLowCatBoard, itemIds: claimedItemIds, period,
      }),
      record: (document, claimedItemIds) => recordPdfLinks({
        workspaceId,
        boardId,
        itemIds: claimedItemIds,
        periodKey,
        period,
        invoiceType,
        invoiceNumber: document.invoiceNumber,
        invoiceTotal: document.invoiceTotal,
        invoiceDate: dates.invoiceDate,
        participant: group.participant,
        pdfUrl: document.fileUrl,
        type: PDFLINK_TYPE_AGE_CARE_INVOICE,
      }),
    });
    if (!generated) return;
    results.push({
      itemId: generated.itemIds[0],
      invoiceNumber: generated.invoiceNumber,
      participant: group.participant,
      profileId: group.profileId,
      pdfUrl: generated.fileUrl,
    });
  });
  return uniquePdfResults(results);
}
