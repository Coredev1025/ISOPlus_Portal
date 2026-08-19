/**
 * "Send from Accounting Platform" delivery: a slot's generated invoices land in
 * the workspace's Xero as DRAFTs, and no email is sent for that run.
 *
 * DRAFT, never AUTHORISED. A scheduled job must not put an approved invoice in
 * front of a client's accountant without a human having seen it.
 *
 * The draft itself is built by handleXeroInvoicendisInvoiceGenerator — the same
 * handler POST /api/xero/:workspaceId/:boardId/invoicendis-invoice-generator
 * calls, so a scheduled draft carries the same contact, the same line rows and
 * the same Finance Settings account/tax mapping as one pushed from the Invoice
 * Generator page. That reuse is the point: this module resolves which invoices
 * to push and records that they were pushed, and owns no line-item logic of its
 * own. (The version of this file deleted in 6b8726f built its own ACCREC lines
 * from quote-shaped item data — a contract that stopped existing when
 * 2026-08-14 bound generation to the Invoice Generator pipelines.)
 */

import Board from '../../models/Board.js';
import Business from '../../models/Business.js';
import PDFLink from '../../models/PDFLink.js';
import {
  isCareManagementLabel,
  isLowCatCareManagementLabel,
  isNdisBoardLabel,
} from '../../utils/automationBoardFlags.js';
import { invoiceDatesFromSlot } from '../../utils/automationInvoiceDates.js';
import { ageCareInvoiceGeneratorListDeps } from '../../utils/automationInvoiceGeneratorDeps.js';
import {
  captureRouteRes,
  isXeroConnectedBusiness,
  xeroPushDocuments,
} from '../../utils/automationXeroInvoiceHelpers.js';
import { getInvoiceGeneratorData } from '../../utils/invoiceGeneratorRouteHelpers.js';
import { saveInvoiceNumber } from '../../utils/invoicePdfSupport.js';
import { formatDdMmYyyy } from '../../utils/ndisServiceRecords.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import {
  appendXeroLineDateSuffix,
  xeroRound2,
  xeroRound4,
  xeroServiceRowDate,
} from '../../utils/xeroLineFormatting.js';
import {
  handleXeroInvoiceParticipantTax,
  handleXeroInvoicendisInvoiceGenerator,
} from '../../utils/xeroNdisRouteHandlers.js';
import { assertListNotTruncated, invoiceGeneratorListQuery } from './generateDocuments.js';
import { error, info } from '../../utils/logger.js';

/**
 * Can this board's invoices be delivered to Xero at all?
 *
 * Asked BEFORE generation, exactly as the worker asks activeEmailBackendName()
 * on the email route, because generation is irreversible: it claims invoice
 * numbers off Business.documentNumbering and writes PDFLink rows keyed on
 * periodKey. Discovering afterwards that there is no way to deliver burns real
 * numbers on documents nobody receives.
 *
 * Returns a reason rather than throwing. Only a human can connect Xero or
 * change a board's label, so three BullMQ attempts would only repeat the log.
 */
export async function xeroDeliveryPreflight({ workspaceId, boardId }) {
  const business = await Business.findOne({
    workspaceId: mongoEq(String(workspaceId)),
  }).lean();
  if (!isXeroConnectedBusiness(business)) {
    return { ok: false, reason: 'Xero is not connected for this workspace' };
  }

  // Both generator branches are wired now. This used to refuse anything but an
  // NDIS board, because the Age Care handler wants the Invoice Generator's own
  // row objects rather than the item ids PDFLink stores — so a workspace that
  // chose "Send from Accounting Platform" on an Age Care board generated
  // nothing, month after month, with only a line in the log to say why. The
  // rows are re-read from the generator now (see ageCareRowsForSlot).
  //
  // A board that is neither is still refused: there is no generator for it, so
  // there is nothing to push.
  const board = await Board.findOne({ boardId: mongoEq(String(boardId)) }).lean();
  if (!isCareManagementLabel(board?.label || '')) {
    return {
      ok: false,
      reason: 'Accounting delivery supports Care Management boards only',
    };
  }
  return { ok: true };
}

/** The board item ids one generated invoice covers, from its own PDFLink rows. */
async function coveredItemIds({ workspaceId, boardId, periodKey, invoiceNumber }) {
  const links = await PDFLink.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    periodKey: mongoEq(String(periodKey)),
    invoiceNumber: mongoEq(String(invoiceNumber)),
  }).lean();
  return {
    itemIds: [...new Set(links.map((link) => String(link.itemId)))],
    alreadyPushed: links.some((link) => Boolean(link.xeroInvoiceNumber)),
  };
}

/**
 * The Invoice Generator rows for this slot, re-read rather than carried.
 *
 * The Age Care handler builds its Xero lines from the generator's own row
 * objects — quantity, unit price, participant contribution, service — where the
 * NDIS one rebuilds everything from item ids. Threading those rows out of
 * generateDocuments would have looked simpler and been wrong: a retry, or any
 * replay of the slot, takes the `existingSlotResults` path and hands back
 * PDFLink rows, which carry no such fields. Re-reading gives the same answer on
 * the first attempt and on the third.
 *
 * `status: 'all'`, because by the time a push happens the rows have been
 * invoiced and a `pending` list would be empty. Same window generation used —
 * that is why the caller passes timezone and schedule through.
 */
async function ageCareRowsForSlot({ workspaceId, boardId, slot, timezone, schedule, periodKey }) {
  const listed = await getInvoiceGeneratorData(
    {
      workspaceId,
      boardId,
      query: invoiceGeneratorListQuery(slot, timezone, schedule, { status: 'all' }),
      req: null,
    },
    ageCareInvoiceGeneratorListDeps(),
  );
  if (listed.error) {
    throw new Error(`Invoice Generator list failed: ${listed.error?.body?.message || 'unknown error'}`);
  }
  assertListNotTruncated(listed, { boardId, periodKey });
  return listed.items || [];
}

/** The deps routes/xero.js hands the same handler, minus the router. */
function participantTaxHandlerDeps() {
  return {
    saveInvoiceNumber,
    getXeroServiceRowDate: xeroServiceRowDate,
    appendDateSuffix: appendXeroLineDateSuffix,
    formatDdMmYyyy,
    round2: xeroRound2,
    round4: xeroRound4,
    error,
  };
}

/**
 * One Xero DRAFT, through whichever shipping handler the board's generator
 * feeds. Both are the same handlers their Invoice Generator page buttons call,
 * so a scheduled draft carries the same contact, lines and account/tax mapping
 * as one pushed by hand.
 */
async function createDraft({ workspaceId, boardId, itemIds, participant, dates, board, rows }) {
  const { res, captured } = captureRouteRes();
  const label = board?.label || '';

  if (isNdisBoardLabel(label)) {
    await handleXeroInvoicendisInvoiceGenerator({
      req: {
        body: {
          itemIds,
          participantName: participant,
          invoiceDate: dates.invoiceDate,
          dueDate: dates.dueDate,
        },
      },
      res,
      workspaceId,
      boardId,
      saveInvoiceNumber,
      appendDateSuffix: appendXeroLineDateSuffix,
      error,
    });
  } else {
    const covered = new Set(itemIds.map(String));
    const items = rows.filter((row) => covered.has(String(row?.id)));
    if (items.length === 0) {
      throw new Error(
        `Invoice ${participant || boardId} has no Invoice Generator rows for slot ${dates.invoiceDate}`,
      );
    }
    await handleXeroInvoiceParticipantTax({
      req: {
        body: {
          items,
          participantName: participant,
          invoiceDate: dates.invoiceDate,
          dueDate: dates.dueDate,
          isLowCat: isLowCatCareManagementLabel(label),
        },
      },
      res,
      workspaceId,
      boardId,
      ...participantTaxHandlerDeps(),
    });
  }

  const xeroInvoiceNumber = captured.body?.invoiceNumber;
  if (!xeroInvoiceNumber) {
    throw new Error(
      `Xero draft was not created: ${captured.body?.message || 'no invoice number returned'}`,
    );
  }
  return xeroInvoiceNumber;
}

async function pushDocument({ workspaceId, boardId, periodKey, document, dates, board, rows }) {
  const { invoiceNumber, participant } = document;
  const { itemIds, alreadyPushed } = await coveredItemIds({
    workspaceId, boardId, periodKey, invoiceNumber,
  });
  // A replayed slot hands back the documents it already generated. Without
  // this the accountant gets a second draft for an invoice already in Xero.
  if (alreadyPushed) return null;
  if (itemIds.length === 0) {
    throw new Error(`Invoice ${invoiceNumber} has no PDFLink rows for slot ${periodKey}`);
  }

  const xeroInvoiceNumber = await createDraft({
    workspaceId, boardId, itemIds, participant, dates, board, rows,
  });
  await PDFLink.updateMany(
    {
      workspaceId: mongoEq(String(workspaceId)),
      boardId: mongoEq(String(boardId)),
      periodKey: mongoEq(String(periodKey)),
      invoiceNumber: mongoEq(String(invoiceNumber)),
    },
    { $set: { xeroInvoiceNumber } },
  );

  info('Automation', 'Scheduled invoice pushed to Xero as a draft', {
    workspaceId, boardId, periodKey, invoiceNumber, xeroInvoiceNumber, items: itemIds.length,
  });
  return { invoiceNumber, xeroInvoiceNumber };
}

export async function pushDraftInvoicesToXero({
  workspaceId,
  boardId,
  slot,
  timezone,
  schedule,
  periodKey,
  documents,
}) {
  const toPush = xeroPushDocuments(documents);
  if (toPush.length === 0) return [];

  const business = await Business.findOne({
    workspaceId: mongoEq(String(workspaceId)),
  }).lean();
  // The same dates the PDF carries, so the draft is dated on the claimed slot
  // rather than on whenever the worker happened to drain the queue.
  const dates = invoiceDatesFromSlot(slot, business?.bankDetails?.accountsReceivableTerms);

  const board = await Board.findOne({ boardId: mongoEq(String(boardId)) }).lean();
  // Listed once for the whole board, not once per participant: the query is the
  // same for every document in the slot, and it is the expensive part.
  const rows = isNdisBoardLabel(board?.label || '')
    ? []
    : await ageCareRowsForSlot({ workspaceId, boardId, slot, timezone, schedule, periodKey });

  const pushed = [];
  for (const document of toPush) {
    const result = await pushDocument({
      workspaceId, boardId, periodKey, document, dates, board, rows,
    });
    if (result) pushed.push(result);
  }
  return pushed;
}
