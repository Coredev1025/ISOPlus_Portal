/**
 * The invoiced marker: recording that a specific item has been billed.
 *
 * Section 3.2 of the invoice selection spec calls for two mechanisms, and this
 * is the second one. The first — a period constraint on the document ledger —
 * stops a period being invoiced twice; this stops a single item being claimed
 * by two different invoices, which the period constraint cannot see.
 *
 * ## Why a claim and a release rather than a transaction
 *
 * Section 3.4 wants the invoice write and the item marking to succeed or fail
 * together. They cannot literally share a commit here: this codebase opens no
 * Mongo sessions anywhere and is not guaranteed a replica set, so
 * `withTransaction` is not available to us.
 *
 * What is available is a conditional update, which is atomic per document.
 * So the automated path claims first, generates second, and releases the claim
 * if generation fails:
 *
 *   1. claimItemsForInvoice  — conditional, only takes items nobody holds
 *   2. render, upload, record the PDF
 *   3. releaseItemClaim on failure — scoped to this invoice number
 *
 * The window that remains is a crash between 1 and 3, which leaves items
 * marked but unbilled. That is the direction section 3.4 asks us to fail in:
 * "prefer leaving items unbilled ... a double-billed participant is not
 * recoverable". Those items are visible — they carry an `invoicedBy` with no
 * matching PDFLink row — and are recoverable by clearing the marker.
 */

import Item from '../models/Item.js';
import { mongoEq } from '../utils/securityHelpers.js';

/**
 * Take the items nobody else has claimed.
 *
 * The filter matches an item that is unclaimed *or* already claimed by this
 * same invoice number. The second half is what makes a retried run idempotent:
 * a job that claimed, then failed after the PDF was written, must be able to
 * run again and see its own claim rather than deadlocking against it.
 *
 * `{ invoicedBy: null }` matches both an explicit null and an absent field, so
 * items that predate this feature need no backfill.
 *
 * Returns which ids were taken and which were refused. The caller decides what
 * a refusal means — for a scheduled run it means another invoice got there
 * first, which is exactly the double bill this exists to prevent.
 */
export async function claimItemsForInvoice({
  workspaceId, boardId, itemIds, invoiceNumber, periodKey,
}) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) return { claimed: [], rejected: [] };

  const scope = {
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    itemId: { $in: itemIds.map((id) => mongoEq(String(id))) },
  };

  await Item.updateMany(
    {
      ...scope,
      $or: [{ invoicedBy: null }, { invoicedBy: mongoEq(String(invoiceNumber)) }],
    },
    {
      $set: {
        invoicedBy: String(invoiceNumber),
        invoicedPeriodKey: periodKey ? String(periodKey) : null,
        invoicedAt: new Date(),
      },
    },
  );

  // Read back rather than trusting modifiedCount: an item already claimed by
  // this same invoice number reports as matched-but-unmodified, and it is
  // claimed. The read is the only thing that distinguishes that from a refusal.
  const held = await Item.find({ ...scope, invoicedBy: mongoEq(String(invoiceNumber)) })
    .select('itemId').lean();
  const claimed = held.map((row) => row.itemId);
  const claimedSet = new Set(claimed);
  return {
    claimed,
    rejected: itemIds.filter((id) => !claimedSet.has(id)),
  };
}

/**
 * Give back a claim this invoice made.
 *
 * Scoped to `invoiceNumber` deliberately: an unscoped clear would release
 * whatever claim happens to be on the item, including one a different — and
 * successful — invoice holds, which would hand those items to the next run and
 * bill them twice. The failure this compensates for must not be able to cause
 * the failure it exists to prevent.
 */
export async function releaseItemClaim({ itemIds, invoiceNumber }) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) return;
  await Item.updateMany(
    {
      itemId: { $in: itemIds.map((id) => mongoEq(String(id))) },
      invoicedBy: mongoEq(String(invoiceNumber)),
    },
    { $unset: { invoicedBy: '', invoicedPeriodKey: '', invoicedAt: '' } },
  );
}

/**
 * Mark items as invoiced, unconditionally.
 *
 * This is the manual path of section 3.3. Manual invoicing is how a late or
 * corrected item gets billed, and if it did not set the same marker the next
 * scheduled run would find those items unmarked and bill them a second time.
 *
 * Unconditional, unlike the claim: the operator has chosen these items and
 * produced a document for them, so the most recent invoice is the one that
 * owns them. Refusing here would leave the marker disagreeing with the invoice
 * the participant actually received.
 */
export async function markItemsInvoiced({
  workspaceId, boardId, itemIds, invoiceNumber, periodKey = null,
}) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) return;
  await Item.updateMany(
    {
      workspaceId: mongoEq(String(workspaceId)),
      boardId: mongoEq(String(boardId)),
      itemId: { $in: itemIds.map((id) => mongoEq(String(id))) },
    },
    {
      $set: {
        invoicedBy: String(invoiceNumber),
        invoicedPeriodKey: periodKey ? String(periodKey) : null,
        invoicedAt: new Date(),
      },
    },
  );
}
