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
import { isNdisBoardLabel } from '../../utils/automationBoardFlags.js';
import { invoiceDatesFromSlot } from '../../utils/automationInvoiceDates.js';
import {
  appendXeroLineDateSuffix,
  captureRouteRes,
  isXeroConnectedBusiness,
  xeroPushDocuments,
} from '../../utils/automationXeroInvoiceHelpers.js';
import { saveInvoiceNumber } from '../../utils/invoicePdfSupport.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { handleXeroInvoicendisInvoiceGenerator } from '../../utils/xeroNdisRouteHandlers.js';
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

  const board = await Board.findOne({ boardId: mongoEq(String(boardId)) }).lean();
  if (!isNdisBoardLabel(board?.label || '')) {
    // Age Care invoices go to Xero through handleXeroInvoiceParticipantTax,
    // which wants the Invoice Generator's own row objects rather than the item
    // ids PDFLink stores. Refusing here is what keeps a slot from minting
    // numbers for documents this path cannot deliver — see the report's
    // follow-ups.
    return { ok: false, reason: 'Accounting delivery currently supports NDIS boards only' };
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

async function createDraft({ workspaceId, boardId, itemIds, participant, dates }) {
  const { res, captured } = captureRouteRes();
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

  const xeroInvoiceNumber = captured.body?.invoiceNumber;
  if (!xeroInvoiceNumber) {
    throw new Error(
      `Xero draft was not created: ${captured.body?.message || 'no invoice number returned'}`,
    );
  }
  return xeroInvoiceNumber;
}

async function pushDocument({ workspaceId, boardId, periodKey, document, dates }) {
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
    workspaceId, boardId, itemIds, participant, dates,
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

  const pushed = [];
  for (const document of toPush) {
    const result = await pushDocument({
      workspaceId, boardId, periodKey, document, dates,
    });
    if (result) pushed.push(result);
  }
  return pushed;
}
