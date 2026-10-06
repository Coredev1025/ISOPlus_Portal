import Item from '../../models/Item.js';
import { INVOICE_SOURCE, INVOICE_TRIGGER, LEGACY_SUFFIX } from '../../constants/invoiceLedger.js';
import { PROVISIONAL_CLAIM_PREFIX } from '../../constants/invoiceSelection.js';
import { warn } from '../logger.js';
import { mongoEq } from '../securityHelpers.js';
import { invoiceLedgerWriteEnabled } from './flags.js';
import { commitInvoice, ownMarkers } from './issue.js';
import { activeForItems, stampXero } from './read.js';

/**
 * The manual Xero routes, and through them the scheduled Xero draft push, create an
 * invoice in Xero for a set of items (KAN-308). What that means for the ledger depends
 * on what the items already are:
 *
 *   - on one portal invoice that lists all of them: the Xero number is attached to that
 *     invoice (decision D8). Nothing new is billed.
 *   - on a portal invoice but not exactly one that lists all of them: reported and left
 *     alone, because a new invoice would be a second charge for the same work.
 *   - on no portal invoice: a Xero-source invoice is recorded, with the Xero number, but
 *     only when no item is marked as billed by some other invoice the ledger does not hold
 *     yet (an invoice from before the write flag was on). Recording then would put the item
 *     on two invoices; the backfill places it by the rule for markers.
 *   - a portal invoice that already carries a different Xero number is left alone: the
 *     earlier number would be lost and a real duplicate in Xero would become invisible.
 *
 * With the write flag off it does nothing. It never throws: the Xero invoice already
 * exists, so a failure is warned about and left for the backfill and the audit.
 */

const totalOf = (created, lineAmounts) => {
  const fromXero = Number(created?.total);
  if (created?.total !== undefined && created?.total !== null && Number.isFinite(fromXero)) return fromXero;
  const summed = Object.values(lineAmounts || {}).reduce((sum, amount) => sum + amount, 0);
  return Math.round(summed * 100) / 100;
};

/**
 * What a single-item Xero invoice billed: the total Xero returned, else the sum of the
 * lines it was built from. The job route has no per-row amounts of its own.
 */
export function billedTotal(created, lineItems) {
  const fromXero = Number(created?.total);
  if (created?.total !== undefined && created?.total !== null && Number.isFinite(fromXero)) return fromXero;
  const summed = (lineItems || []).reduce((sum, line) => sum + Number(line.quantity) * Number(line.unitAmount), 0);
  return Math.round(summed * 100) / 100;
}

/** The distinct issued portal invoices that list any of these items. */
async function portalInvoicesFor(workspaceId, itemIds) {
  const active = await activeForItems(workspaceId, itemIds);
  const byId = new Map();
  for (const invoice of active.values()) {
    if (invoice.source === INVOICE_SOURCE.PORTAL) byId.set(String(invoice._id), invoice);
  }
  return [...byId.values()];
}

const listsAll = (invoice, itemIds) => {
  const have = new Set(invoice.lines.map((l) => l.itemId));
  return itemIds.every((id) => have.has(id));
};

/** Items whose marker names an invoice other than this Xero one: billed, but not in the ledger. */
async function markedByOtherInvoices(workspaceId, boardId, itemIds, xeroMarker) {
  const items = await Item.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    itemId: { $in: itemIds.map((id) => mongoEq(id)) },
  }).select('itemId invoicedBy').lean();
  return items.filter((item) => item.invoicedBy
    && item.invoicedBy !== xeroMarker
    && !String(item.invoicedBy).startsWith(PROVISIONAL_CLAIM_PREFIX));
}

async function pointItems(invoice, itemIds) {
  await Item.updateMany(
    {
      workspaceId: mongoEq(invoice.workspaceId),
      boardId: mongoEq(invoice.boardId),
      itemId: { $in: itemIds.map((id) => mongoEq(id)) },
      invoicedBy: { $in: ownMarkers(invoice) },
    },
    { $set: { activeInvoiceId: invoice._id } },
  );
}

/** Attach the Xero number, unless the invoice already carries a different one. */
async function stampOnce(portalInvoice, created) {
  const existing = portalInvoice.xero?.invoiceNumber;
  if (existing && existing !== String(created.invoiceNumber)) {
    warn('InvoiceLedger', 'A portal invoice already carries a different Xero number; not overwritten', {
      reason: 'xero-already-attached',
      invoice: portalInvoice.number, existing, xeroInvoiceNumber: created.invoiceNumber,
    });
    return null;
  }
  return stampXero(portalInvoice._id, created.invoiceNumber, created.invoiceID);
}

export async function recordXeroInvoice({
  workspaceId, boardId, itemIds: rawItemIds, created, kind, participant, lineAmounts, lowCat, invoiceDate, dueDate,
}) {
  if (!invoiceLedgerWriteEnabled()) return null;
  const itemIds = [...new Set(rawItemIds.map(String))];
  try {
    const portal = await portalInvoicesFor(workspaceId, itemIds);
    if (portal.length > 0) {
      if (portal.length === 1 && listsAll(portal[0], itemIds)) return await stampOnce(portal[0], created);
      warn('InvoiceLedger', 'A Xero invoice spans more than one portal invoice, or only some of one; nothing recorded', {
        reason: 'xero-spans-invoices',
        workspaceId, boardId, xeroInvoiceNumber: created.invoiceNumber, portalInvoices: portal.map((p) => p.number),
      });
      return null;
    }

    const xeroMarker = `${created.invoiceNumber}${LEGACY_SUFFIX.XERO}`;
    const others = await markedByOtherInvoices(workspaceId, boardId, itemIds, xeroMarker);
    if (others.length > 0) {
      warn('InvoiceLedger', 'A Xero invoice covers items already billed by an invoice the ledger does not hold; nothing recorded', {
        reason: 'xero-on-unrecorded-invoice',
        workspaceId, boardId, xeroInvoiceNumber: created.invoiceNumber, items: others.map((i) => `${i.itemId}:${i.invoicedBy}`),
      });
      return null;
    }

    const invoice = await commitInvoice({
      workspaceId,
      boardId,
      itemIds,
      source: INVOICE_SOURCE.XERO,
      generated: {
        invoiceNumber: xeroMarker,
        invoiceTotal: totalOf(created, lineAmounts),
      },
      kind,
      lowCat,
      participant: { name: participant?.name?.trim() || 'Participant' },
      trigger: INVOICE_TRIGGER.MANUAL,
      lineAmounts,
      invoiceDate,
      dueDate,
    });
    await pointItems(invoice, itemIds);
    return invoice;
  } catch (err) {
    warn('InvoiceLedger', 'Xero invoice record not recorded; the backfill will find it', {
      workspaceId, boardId, xeroInvoiceNumber: created?.invoiceNumber, message: err.message,
    });
    return null;
  }
}
