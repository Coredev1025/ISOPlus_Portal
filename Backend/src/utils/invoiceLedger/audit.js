import Invoice from '../../models/Invoice.js';
import Item from '../../models/Item.js';
import PDFLink from '../../models/PDFLink.js';
import { PDFLINK_TYPE_AGE_CARE_INVOICE, PDFLINK_TYPE_NDIS_INVOICE } from '../../constants/automation.js';
import { INVOICE_STATUS } from '../../constants/invoiceLedger.js';
import { PROVISIONAL_CLAIM_PREFIX, STALE_CLAIM_MAX_AGE_MS } from '../../constants/invoiceSelection.js';
import { mongoEq } from '../securityHelpers.js';
import { parseInvoiceNumber } from './numbers.js';

/**
 * The invariants of the invoice ledger, as one read-only report (KAN-302, design
 * section 10). The audit script and the tests share it. Nothing here writes.
 *
 * Violations are things that are wrong. `reported` holds states that are expected
 * until the KAN-289 rules exist (double-billed items, flagged duplicate numbers) or
 * that repair will fix (an invoice whose marker rewrite did not finish).
 */

const INVOICE_DOCUMENT_TYPES = [PDFLINK_TYPE_NDIS_INVOICE, PDFLINK_TYPE_AGE_CARE_INVOICE];

const isProvisional = (marker) => typeof marker === 'string' && marker.startsWith(PROVISIONAL_CLAIM_PREFIX);

/** Whether an issued invoice is the one this marker names: same plain number and same source. */
const namesInvoice = (marker, invoice) => marker.number === invoice.number && marker.source === invoice.source;

/**
 * Invariant 1: every real marker has an issued invoice that lists the item AND is the
 * invoice the marker names. An item listed only on a different invoice does not count.
 */
function markersWithoutInvoice(markedItems, issuedByItem) {
  return markedItems.filter((i) => {
    const marker = parseInvoiceNumber(i.invoicedBy);
    if (!marker) return false;
    return !(issuedByItem.get(i.itemId) || []).some((inv) => namesInvoice(marker, inv));
  }).map((i) => ({ itemId: i.itemId, marker: i.invoicedBy }));
}

/**
 * Invariant 2: a pointer names an invoice that exists, lists the item, and carries the
 * number and source of the marker. A flagged duplicate is reported elsewhere.
 */
function activePointerMismatches(pointedItems, invoiceById) {
  return pointedItems.filter((i) => {
    const invoice = invoiceById.get(String(i.activeInvoiceId));
    if (!invoice || !invoice.lines.some((l) => l.itemId === i.itemId)) return true;
    if (invoice.duplicateOrdinal > 0) return false;
    const marker = parseInvoiceNumber(i.invoicedBy);
    return !marker || !namesInvoice(marker, invoice);
  }).map((i) => ({ itemId: i.itemId, marker: i.invoicedBy, activeInvoiceId: i.activeInvoiceId }));
}

/** An item holding a provisional claim that an issued invoice listing it was issued under. */
const claimBehindInvoice = (item, issuedByItem) => (issuedByItem.get(item.itemId) || [])
  .some((inv) => inv.claimToken && inv.claimToken === item.invoicedBy);

/** Invariant 5: a provisional claim past the cutoff that no issued invoice was issued under. */
function stalePendingClaims(markedItems, issuedByItem, now) {
  return markedItems
    .filter((i) => isProvisional(i.invoicedBy))
    .filter((i) => !i.invoicedAt || now - new Date(i.invoicedAt) > STALE_CLAIM_MAX_AGE_MS)
    .filter((i) => !claimBehindInvoice(i, issuedByItem))
    .map((i) => ({ itemId: i.itemId, marker: i.invoicedBy }));
}

/** Invariant 4: a numbered invoice document with no invoice record behind its id. */
async function documentsWithoutInvoice(workspace, invoiceIds) {
  const rows = await PDFLink.find({
    workspaceId: workspace, type: { $in: INVOICE_DOCUMENT_TYPES }, invoiceNumber: { $type: 'string', $ne: '' },
  }).select('itemId invoiceNumber invoiceId').lean();
  return rows
    .filter((r) => !r.invoiceId || !invoiceIds.has(String(r.invoiceId)))
    .map((r) => ({ itemId: r.itemId, invoiceNumber: r.invoiceNumber }));
}

/** Invariant 6: an invoice whose document rows carry a different total. */
async function totalMismatches(workspace, invoices) {
  const rows = await PDFLink.find({
    workspaceId: workspace, invoiceId: { $in: invoices.map((i) => i._id) }, invoiceTotal: { $type: 'number' },
  }).select('invoiceId invoiceTotal').lean();
  const totals = new Map();
  rows.forEach((r) => totals.set(String(r.invoiceId), (totals.get(String(r.invoiceId)) || new Set()).add(r.invoiceTotal)));
  return invoices
    .filter((i) => !i.totalDerived && totals.has(String(i._id)))
    .filter((i) => [...totals.get(String(i._id))].some((t) => t !== i.total))
    .map((i) => ({ number: i.number, total: i.total, documentTotals: [...totals.get(String(i._id))] }));
}

/** Invariant 3: more than one invoice owning the same number (the index forbids it; this proves it). */
function duplicateOwners(invoices) {
  const seen = new Map();
  invoices.filter((i) => i.duplicateOrdinal === 0).forEach((i) => {
    const key = `${i.source}|${i.number}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  });
  return [...seen].filter(([, n]) => n > 1).map(([key]) => ({ number: key.split('|')[1] }));
}

/**
 * Check every invariant for a workspace. `now` is injectable for the stale-claim cutoff.
 */
export async function auditInvoices(workspaceId, { now = new Date() } = {}) {
  const workspace = mongoEq(String(workspaceId));
  const invoices = await Invoice.find({ workspaceId: workspace }).lean();
  const issued = invoices.filter((i) => i.status === INVOICE_STATUS.ISSUED);
  const invoiceById = new Map(invoices.map((i) => [String(i._id), i]));

  const issuedByItem = new Map();
  issued.forEach((inv) => inv.lines.forEach((l) => issuedByItem.set(l.itemId, [...(issuedByItem.get(l.itemId) || []), inv])));

  const markedItems = await Item.find({ workspaceId: workspace, invoicedBy: { $type: 'string', $ne: '' } })
    .select('itemId invoicedBy invoicedAt activeInvoiceId').lean();
  const pointedItems = await Item.find({ workspaceId: workspace, activeInvoiceId: { $ne: null } })
    .select('itemId invoicedBy activeInvoiceId').lean();

  const needsRepair = markedItems
    .filter((i) => isProvisional(i.invoicedBy) && claimBehindInvoice(i, issuedByItem))
    .map((i) => ({ itemId: i.itemId, marker: i.invoicedBy }));

  return {
    violations: {
      markerWithoutInvoice: markersWithoutInvoice(markedItems, issuedByItem),
      activePointerMismatch: activePointerMismatches(pointedItems, invoiceById),
      duplicateOwner: duplicateOwners(invoices),
      documentWithoutInvoice: await documentsWithoutInvoice(workspace, new Set(invoiceById.keys())),
      stalePending: stalePendingClaims(markedItems, issuedByItem, now),
      totalMismatch: await totalMismatches(workspace, issued),
    },
    reported: {
      doubleBilled: [...issuedByItem].filter(([, list]) => list.length > 1).map(([itemId]) => ({ itemId })),
      duplicateNumbers: invoices.filter((i) => i.duplicateOrdinal > 0).map((i) => ({ number: i.number })),
      needsRepair,
    },
  };
}
