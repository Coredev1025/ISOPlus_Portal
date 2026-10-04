import Invoice from '../../models/Invoice.js';
import Item from '../../models/Item.js';
import PDFLink from '../../models/PDFLink.js';
import {
  INVOICE_KIND, INVOICE_ORIGIN, INVOICE_SOURCE, LEGACY_SUFFIX,
} from '../../constants/invoiceLedger.js';
import { generateUnderClaim, provisionalClaimToken } from '../automationInvoiceClaim.js';
import { warn } from '../logger.js';
import { mongoEq } from '../securityHelpers.js';
import { invoiceLedgerWriteEnabled } from './flags.js';
import { parseInvoiceNumber } from './numbers.js';

/**
 * Issuing an invoice (KAN-302): the existing claim protocol with the new invoice
 * record committed under the claim.
 *
 *   1. claim the items under a provisional token
 *   2. produce the document (the producer allocates the number and renders)
 *   3. record: the producer's own older writes, still under the token
 *   4. COMMIT the invoice record (only when INVOICE_LEDGER_WRITE is on)
 *   5. rewrite the marker to the real number
 *   6. point the items at the invoice
 *
 * Step 4 is the commit point. Before it, a failure either releases the claim
 * (produce failed) or keeps it pending (the older writes may be partly done, so
 * handing the items back could bill them twice), and no invoice exists. After it
 * the invoice is the truth: if step 5 fails, `repairInvoice` finishes it from the
 * invoice's lines; if step 6 fails the issue still succeeds and repair finishes that.
 *
 * With the flag off this is exactly `generateUnderClaim`.
 */

const NUMBER_INDEX = 'invoice_number_unique';
let numberIndexConfirmed = false;

/** Test hook: forget that the unique index was seen. */
export function resetIndexCheckForTests() {
  numberIndexConfirmed = false;
}

/**
 * The upsert is only idempotent under the unique index, and indexes on this
 * collection come from a migration, not from boot. Refuse to write without it, once
 * per process (a missing index is not cached, so building it fixes the next call).
 */
async function assertNumberIndex() {
  if (numberIndexConfirmed) return;
  const indexes = await Invoice.collection.indexes().catch(() => []);
  if (!indexes.some((i) => i.name === NUMBER_INDEX)) {
    throw new Error(
      `The invoices collection has no ${NUMBER_INDEX} index. Run the invoice-ledger-indexes migration before turning INVOICE_LEDGER_WRITE on.`,
    );
  }
  numberIndexConfirmed = true;
}

/** Two line lists name the same items, in any order. */
const sameItems = (lines, itemIds) => {
  const have = new Set(lines.map((l) => l.itemId));
  return have.size === itemIds.length && itemIds.every((id) => have.has(String(id)));
};

/** A participant is a name string (the scheduled generators) or `{ profileId, name }`. */
function normaliseParticipant(participant) {
  const name = typeof participant === 'string' ? participant : participant?.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('An invoice needs a participant name: it is part of the claim token, and without it every participant on a slot would share one');
  }
  return typeof participant === 'string' ? { name } : { profileId: participant.profileId, name };
}

function assertOneOf(label, value, allowed) {
  if (!Object.values(allowed).includes(value)) throw new Error(`Unknown invoice ${label}: ${value}`);
}

/** The fields of an invoice that come from what the producer generated. */
function invoiceDocument({
  workspaceId, boardId, itemIds, generated, kind, source, participant, trigger, periodKey, lowCat, lineAmounts, claimToken,
}) {
  const parsed = parseInvoiceNumber(generated.invoiceNumber);
  if (!parsed) throw new Error(`Cannot record an invoice without a usable number: ${generated.invoiceNumber}`);
  return {
    workspaceId: String(workspaceId),
    boardId: boardId ? String(boardId) : undefined,
    number: parsed.number,
    source: parsed.source === INVOICE_SOURCE.XERO ? INVOICE_SOURCE.XERO : source,
    legacyNumbers: parsed.legacyNumbers,
    kind,
    ...(typeof lowCat === 'boolean' ? { lowCat } : {}),
    participant: normaliseParticipant(participant),
    lines: itemIds.map((itemId) => ({ itemId: String(itemId), amount: lineAmounts?.[itemId] ?? 0 })),
    total: generated.invoiceTotal,
    issuedAt: generated.invoiceDate ?? new Date(),
    dueDate: generated.dueDate,
    periodKey: periodKey ?? undefined,
    periodStart: generated.periodStart,
    periodEnd: generated.periodEnd,
    trigger,
    claimToken,
    pdf: { pdfLink: generated.fileUrl },
    origin: INVOICE_ORIGIN.LIVE,
  };
}

const ownerFilter = (doc) => ({
  workspaceId: doc.workspaceId, source: doc.source, number: doc.number, duplicateOrdinal: 0,
});

/** Upsert on the unique key, retrying once when two writers race to create it. */
async function upsertInvoice(doc) {
  const run = () => Invoice.findOneAndUpdate(ownerFilter(doc), { $setOnInsert: doc }, { upsert: true, new: true }).lean();
  try {
    return await run();
  } catch (err) {
    if (err?.code === 11000) return run();
    throw err;
  }
}

/**
 * Write the invoice record for a document the producer has generated. Validates the
 * record first (an upsert skips schema validation), refuses without the unique index,
 * and is idempotent: a retry for the same number and the same items returns the record
 * that is there. A different set of items on a number that is taken is refused, because
 * the number comes from an atomic counter and a clash means something is inconsistent.
 * Stamps the invoice id on the document rows already written for this number.
 */
export async function commitInvoice(args) {
  const doc = invoiceDocument(args);
  await new Invoice(doc).validate();
  await assertNumberIndex();

  const invoice = await upsertInvoice(doc);
  if (!sameItems(invoice.lines, args.itemIds)) {
    throw new Error(`Invoice ${doc.number} already exists for different items`);
  }
  await PDFLink.updateMany(
    {
      workspaceId: mongoEq(doc.workspaceId),
      itemId: { $in: args.itemIds.map((id) => mongoEq(String(id))) },
      invoiceNumber: mongoEq(String(args.generated.invoiceNumber)),
      invoiceId: { $exists: false },
    },
    { $set: { invoiceId: invoice._id } },
  );
  return invoice;
}

const pointItemsAt = (workspaceId, boardId, itemIds, invoiceId) => Item.updateMany(
  {
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    itemId: { $in: itemIds.map((id) => mongoEq(String(id))) },
  },
  { $set: { activeInvoiceId: invoiceId } },
);

/**
 * Issue an invoice for the items under a claim. `produce(claimedItemIds)` renders the
 * document and returns `{ invoiceNumber, fileUrl, invoiceTotal, ... }` (or
 * `{ empty: true }`); `record(generated, claimedItemIds)` is the producer's older
 * writes. A scheduled producer keeps the deterministic claim token; a manual one passes
 * an `attemptId` unique to the request so two concurrent invoices cannot both claim the
 * same items. Returns the generated document with `itemIds` (and `invoiceId` when the
 * record was written), or null when there was nothing to bill.
 */
export async function issueInvoice({
  workspaceId, boardId, itemIds, type, periodKey = null, kind, source = INVOICE_SOURCE.PORTAL,
  participant, trigger, lowCat, lineAmounts, produce, record = null, attemptId = null,
}) {
  assertOneOf('kind', kind, INVOICE_KIND);
  assertOneOf('source', source, INVOICE_SOURCE);
  const who = normaliseParticipant(participant);
  const claimToken = provisionalClaimToken({
    type, periodKey, participant: who.name, attemptId,
  });

  let committed = null;
  const recordAndCommit = async (generated, claimed) => {
    if (record) await record(generated, claimed);
    if (!invoiceLedgerWriteEnabled()) return;
    committed = await commitInvoice({
      workspaceId, boardId, itemIds: claimed, generated, kind, source, participant: who, trigger, periodKey, lowCat, lineAmounts, claimToken,
    });
  };

  const result = await generateUnderClaim({
    workspaceId, boardId, itemIds, type, periodKey, participant: who.name, produce, record: recordAndCommit, attemptId,
  });
  if (!result || !committed) return result;

  try {
    await pointItemsAt(workspaceId, boardId, result.itemIds, committed._id);
  } catch (err) {
    // The invoice is issued and the items are marked; only the pointer is missing, and
    // the reader falls back to the latest issued invoice. Not worth failing the run.
    warn('InvoiceLedger', 'Could not point the items at the invoice; repairInvoice will finish it', {
      workspaceId, boardId, invoiceId: String(committed._id), message: err.message,
    });
  }
  return { ...result, invoiceId: committed._id };
}

/** The marker strings that name this invoice, in the form the older code writes. */
function ownMarkers(invoice) {
  if (invoice.source === INVOICE_SOURCE.XERO) return [`${invoice.number}${LEGACY_SUFFIX.XERO}`];
  return [invoice.number, `${invoice.number}${LEGACY_SUFFIX.ISOPLUS}`];
}

/**
 * Finish the confirm steps for an invoice whose marker rewrite or pointer did not
 * complete. For each line item: when the marker is absent, this invoice's own
 * provisional claim, or one of the forms of this invoice's own number, set the marker
 * and point the item at the invoice; when it holds anything else (another invoice's
 * number, another run's claim, the other source's number) leave it alone and report it.
 * An item that no longer exists is reported separately. A void invoice is refused.
 * Safe to run repeatedly.
 */
export async function repairInvoice(invoiceId) {
  const invoice = await Invoice.findById(invoiceId).lean();
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
  if (invoice.status !== 'issued') throw new Error(`Invoice ${invoice.number} is not issued, so it cannot be repaired`);

  const markerForm = invoice.legacyNumbers?.[0] ?? ownMarkers(invoice)[0];
  const accepted = [null, ...ownMarkers(invoice), ...(invoice.claimToken ? [invoice.claimToken] : [])];

  const outcome = { repaired: [], skipped: [], missing: [] };
  for (const { itemId } of invoice.lines) {
    const filter = { workspaceId: mongoEq(invoice.workspaceId), itemId: mongoEq(itemId) };
    const { matchedCount } = await Item.updateOne(
      { ...filter, invoicedBy: { $in: accepted } },
      { $set: { invoicedBy: markerForm, activeInvoiceId: invoice._id, invoicedAt: invoice.issuedAt ?? new Date() } },
    );
    if (matchedCount > 0) outcome.repaired.push(itemId);
    else if (await Item.exists(filter)) outcome.skipped.push(itemId);
    else outcome.missing.push(itemId);
  }
  return outcome;
}

