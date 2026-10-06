/**
 * Putting the selection rule in front of a scheduled run.
 *
 * `utils/invoiceItemSelection.js` is the rule from section 2 of the invoice
 * selection spec — an item is billable when its status is one of its type's
 * qualifying values AND either of its two date fields falls in the period. It
 * is pure, and it works on stored `Item` documents.
 *
 * Generation does not start from stored items: both paths start from an Invoice
 * Generator list, which returns rows shaped for the UI and keyed by id. This is
 * the seam between the two. The list decides what a period CONTAINS; the rule
 * decides what of it is BILLABLE under the board's invoice type.
 *
 * ## The failure direction, and why every drop is logged
 *
 * The claim protocol fails towards leaving items unbilled, because a double
 * bill is not recoverable. Selection has the same bias for the same reason —
 * but here under-billing is the *likely* mistake rather than the safe one: if
 * the spec's table and the list query's window ever disagree, this silently
 * removes work from an invoice and nothing downstream can tell. So a run that
 * drops anything says so, with counts, at warn.
 */

import Item from '../models/Item.js';
import { PROVISIONAL_CLAIM_PREFIX } from '../constants/invoiceSelection.js';
import { selectInvoiceableItems } from './invoiceItemSelection.js';
import { mongoEq } from './securityHelpers.js';
import { warn } from './logger.js';

/**
 * A `pending:` token as selection should see it: not invoiced.
 *
 * The marker means two different things. A real invoice number says the item
 * has been billed and must never be billed again — selection is right to skip
 * it. A `pending:` token says a run is *currently working on it*, and only
 * `claimItemsForInvoice` can say whether this run is that run: it takes an item
 * back when the token is its own, which is the whole reason the token is
 * deterministic. Treating a provisional claim as invoiced here would break
 * exactly the retry the token exists for — a job that failed after claiming
 * would never see its own items again.
 *
 * A copy, never a mutation: the caller's documents are not selection's to edit.
 */
function withoutProvisionalClaim(item) {
  if (!String(item?.invoicedBy ?? '').startsWith(PROVISIONAL_CLAIM_PREFIX)) return item;
  return { ...item, invoicedBy: null };
}

/**
 * The listed ids that are actually billable, in the order they were listed.
 *
 * `invoiceType` is null for a board whose label is not one of the spec's five —
 * 'Care Management - NDIS - 2026 Pricing' matches `isNdisBoardLabel` and no row
 * of the selection table. Section 5 is explicit that conditions must not be
 * inferred for a type that has none, so the honest answer is to leave the list
 * query's own service-delivery window as the rule and say which board it
 * happened on. Refusing instead would stop billing a board that bills correctly
 * today.
 */
export async function selectBillableItemIds({
  workspaceId, boardId, itemIds, invoiceType, period,
}) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) return [];

  if (!invoiceType) {
    warn('Automation', 'Board has no selection conditions for its label; billing the listed period as-is', {
      workspaceId, boardId, listed: itemIds.length,
    });
    return itemIds;
  }

  const stored = await Item.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    itemId: { $in: itemIds.map((id) => mongoEq(String(id))) },
  }).lean();

  const billable = new Set(
    selectInvoiceableItems(stored.map(withoutProvisionalClaim), invoiceType, period)
      .map((item) => item.itemId),
  );
  // Filtered off the input rather than mapped off the selection, so the order
  // the list produced survives — it is the order the invoice rows appear in.
  const selected = itemIds.filter((id) => billable.has(id));

  if (selected.length < itemIds.length) {
    warn('Automation', 'Invoice selection removed listed items from this period', {
      workspaceId,
      boardId,
      invoiceType,
      listed: itemIds.length,
      selected: selected.length,
      dropped: itemIds.length - selected.length,
    });
  }
  return selected;
}
