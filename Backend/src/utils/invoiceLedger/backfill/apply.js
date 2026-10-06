import mongoose from 'mongoose';

import Invoice from '../../../models/Invoice.js';
import Item from '../../../models/Item.js';
import PDFLink from '../../../models/PDFLink.js';
import { INVOICE_ORIGIN } from '../../../constants/invoiceLedger.js';
import { mongoEq } from '../../securityHelpers.js';

/**
 * Applies a backfill plan, and undoes one (KAN-311). Additive only: it creates invoices,
 * stamps `invoiceId` on ledger rows, sets `activeInvoiceId` and attaches Xero numbers. It
 * never edits a marker, a log row or any other field of an old store, so the old readers
 * keep answering exactly as before. Idempotent: an invoice is an upsert on the unique
 * number index, a stamp only fills an empty `invoiceId`.
 */

const NUMBER_INDEX = 'invoice_number_unique';
const objectId = (id) => new mongoose.Types.ObjectId(String(id));

/** The upsert is only idempotent under the unique index; without it a rerun could duplicate. */
async function assertNumberIndex() {
  const indexes = await Invoice.collection.indexes().catch(() => []);
  if (!indexes.some((index) => index.name === NUMBER_INDEX)) {
    throw new Error(`The invoices collection has no ${NUMBER_INDEX} index. Run the invoice-ledger-indexes migration before the backfill.`);
  }
}

/** Thrown when a number the plan would create already belongs to an invoice the backfill did not make. */
export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

const sameItems = (invoice, planned) => {
  const have = new Set((invoice.lines || []).map((l) => l.itemId));
  return planned.lines.length === have.size && planned.lines.every((l) => have.has(l.itemId));
};

/**
 * An invoice already holding the number is only the same record when the backfill made it
 * for the same items (a rerun). Anything else is a live invoice that appeared after the plan
 * and must not be stamped or pointed at as if it were ours.
 */
function assertOurs(existing, planned) {
  if (existing.origin !== INVOICE_ORIGIN.BACKFILL || !sameItems(existing, planned)) {
    throw new ConflictError(`Invoice ${planned.number} now exists and is not the one this plan describes; re-run the dry run.`);
  }
}

/** Create the planned invoices; returns the id of each by `ref`, and how many were new. */
async function createInvoices(invoices) {
  const ids = new Map();
  let created = 0;
  for (const { ref, ...doc } of invoices) {
    const result = await Invoice.findOneAndUpdate(
      {
        workspaceId: doc.workspaceId, source: doc.source, number: doc.number, duplicateOrdinal: doc.duplicateOrdinal,
      },
      { $setOnInsert: doc },
      { upsert: true, new: true, includeResultMetadata: true },
    );
    if (result.lastErrorObject?.upserted) created += 1;
    else assertOurs(result.value, doc);
    ids.set(ref, result.value._id);
  }
  return { ids, created };
}

const idOf = (target, ids) => (target.ref ? ids.get(target.ref) : objectId(target.invoiceId));

async function stampRows(stamps, ids) {
  if (stamps.length === 0) return 0;
  const result = await PDFLink.bulkWrite(stamps.map((stamp) => ({
    updateOne: {
      filter: { _id: objectId(stamp.ledgerRowId), invoiceId: { $exists: false } },
      update: { $set: { invoiceId: idOf(stamp, ids) } },
    },
  })));
  return result.modifiedCount;
}

/**
 * Set each item's active invoice, but only if it still has the pointer it had when planned
 * (usually none). A pointer a live writer set in the meantime is left alone and counted.
 */
async function pointItems(pointers, ids, workspaceId) {
  if (pointers.length === 0) return { pointed: 0, pointerSkipped: 0 };
  const result = await Item.bulkWrite(pointers.map((pointer) => ({
    updateOne: {
      filter: {
        workspaceId: mongoEq(String(workspaceId)),
        itemId: mongoEq(pointer.itemId),
        activeInvoiceId: pointer.expected ? objectId(pointer.expected) : null,
      },
      update: { $set: { activeInvoiceId: idOf(pointer, ids) } },
    },
  })));
  // An item already pointing at the target matches the filter too, so a rerun skips none.
  return { pointed: result.modifiedCount, pointerSkipped: pointers.length - result.matchedCount };
}

/** Xero numbers for invoices that already existed without one. Never overwrites. */
async function attachXero(attachments) {
  let attached = 0;
  for (const { invoiceId, xero } of attachments || []) {
    const result = await Invoice.updateOne({ _id: objectId(invoiceId), 'xero.invoiceNumber': { $exists: false } }, { $set: { xero } });
    attached += result.modifiedCount;
  }
  return attached;
}

/** Every planned record passes the model validation. Called for every workspace before the first write. */
export async function validatePlan(plan) {
  for (const { ref, ...doc } of plan.invoices) await new Invoice(doc).validate();
}

export async function applyPlan(plan, workspaceId) {
  await assertNumberIndex();
  await validatePlan(plan);

  const { ids, created } = await createInvoices(plan.invoices);
  return {
    created,
    stamped: await stampRows(plan.stamps, ids),
    ...await pointItems(plan.pointers, ids, workspaceId),
    xeroAttached: await attachXero(plan.xeroAttachments),
  };
}

const CHANGED_AFTER_MS = 1000;

/** A backfilled invoice live code has since updated (a Xero stamp, an adopted number). */
const changedSinceCreated = (invoice) => new Date(invoice.updatedAt) - new Date(invoice.createdAt) > CHANGED_AFTER_MS;

/**
 * Remove what the backfill made, for one workspace: the invoices with `origin: backfill`, the
 * `invoiceId` on the ledger rows pointing at them and the `activeInvoiceId` on the items
 * pointing at them. Live-issued invoices are never touched, and neither is a backfilled
 * invoice that has been updated since it was created (live code has adopted it: deleting it
 * would lose what it recorded); those are listed. Without `apply` it only counts. A Xero
 * number the backfill attached to an invoice that already existed is not removed (it is true
 * of that invoice).
 */
export async function undoBackfill(workspaceId, { apply = false } = {}) {
  const workspace = mongoEq(String(workspaceId));
  const made = await Invoice.find({ workspaceId: workspace, origin: INVOICE_ORIGIN.BACKFILL }).select('_id number createdAt updatedAt').lean();
  const skipped = made.filter(changedSinceCreated).map((i) => ({ number: i.number, reason: 'changed-since-created' }));
  const ids = made.filter((i) => !changedSinceCreated(i)).map((i) => i._id);
  const result = { invoices: ids.length, stamped: 0, pointed: 0, skipped, preview: !apply };
  if (ids.length === 0) return result;
  if (!apply) {
    result.stamped = await PDFLink.countDocuments({ invoiceId: { $in: ids } });
    result.pointed = await Item.countDocuments({ workspaceId: workspace, activeInvoiceId: { $in: ids } });
    return result;
  }

  const stamped = await PDFLink.updateMany({ invoiceId: { $in: ids } }, { $unset: { invoiceId: '' } });
  const pointed = await Item.updateMany({ workspaceId: workspace, activeInvoiceId: { $in: ids } }, { $unset: { activeInvoiceId: '' } });
  const removed = await Invoice.deleteMany({ _id: { $in: ids }, origin: INVOICE_ORIGIN.BACKFILL });
  return {
    ...result, invoices: removed.deletedCount, stamped: stamped.modifiedCount, pointed: pointed.modifiedCount,
  };
}
