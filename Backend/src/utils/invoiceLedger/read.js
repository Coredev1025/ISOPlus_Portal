import Invoice from '../../models/Invoice.js';
import Item from '../../models/Item.js';
import PDFLink from '../../models/PDFLink.js';
import { INVOICE_STATUS } from '../../constants/invoiceLedger.js';
import { mongoEq } from '../securityHelpers.js';
import { numberForms, parseInvoiceNumber } from './numbers.js';

/**
 * The only code that reads invoice identity once the readers move onto the ledger
 * (KAN-302). Screens and documents call these; nothing else queries `pdflinks`,
 * `invoicenumbers` or `invoicedBy` for that purpose.
 *
 * Every function takes the workspace explicitly and scopes by it. Results are lean
 * documents.
 */

const eqAll = (values) => ({ $in: values.map((v) => mongoEq(String(v))) });

/**
 * An invoice by number, from the plain number or any form it has been known by.
 * The invoice that owns the number wins over a flagged duplicate. A void invoice is
 * returned too: a link to an old document must still resolve.
 */
export async function byNumber(workspaceId, rawNumber) {
  const parsed = parseInvoiceNumber(rawNumber);
  if (!parsed) return null;
  const forms = numberForms(rawNumber);

  return Invoice.findOne({
    workspaceId: mongoEq(String(workspaceId)),
    source: parsed.source,
    $or: [{ number: parsed.number }, { legacyNumbers: eqAll(forms) }],
  }).sort({ duplicateOrdinal: 1 }).lean();
}

/** Of the issued invoices that list an item, the one it points at, else the latest. */
function chooseActive(candidates, activeInvoiceId) {
  if (activeInvoiceId) {
    const pointed = candidates.find((inv) => String(inv._id) === String(activeInvoiceId));
    if (pointed) return pointed;
  }
  return [...candidates].sort((a, b) => new Date(b.issuedAt || 0) - new Date(a.issuedAt || 0))[0];
}

/**
 * Item id to the invoice it currently belongs to. An item on no issued invoice is
 * absent from the map.
 */
export async function activeForItems(workspaceId, itemIds) {
  const ids = (itemIds || []).map(String);
  if (ids.length === 0) return new Map();
  const workspace = mongoEq(String(workspaceId));

  const invoices = await Invoice.find({
    workspaceId: workspace, status: INVOICE_STATUS.ISSUED, 'lines.itemId': eqAll(ids),
  }).lean();
  const pointers = await Item.find({
    workspaceId: workspace, itemId: eqAll(ids),
  }).select('itemId activeInvoiceId').lean();
  const pointerOf = new Map(pointers.map((i) => [i.itemId, i.activeInvoiceId]));

  const result = new Map();
  for (const id of ids) {
    const candidates = invoices.filter((inv) => inv.lines.some((l) => l.itemId === id));
    if (candidates.length > 0) result.set(id, chooseActive(candidates, pointerOf.get(id)));
  }
  return result;
}

/**
 * The issued invoices for a participant on a board, oldest first: the same scope the
 * statement uses today (per board, matched by participant name, every invoice).
 */
export async function forParticipant({ workspaceId, boardId, participant }) {
  return Invoice.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    'participant.name': mongoEq(String(participant)),
    status: INVOICE_STATUS.ISSUED,
  }).sort({ issuedAt: 1, createdAt: 1 }).lean();
}

/** The invoices a scheduled slot produced on a board, for replay checks. */
export async function slotInvoices(workspaceId, boardId, periodKey) {
  return Invoice.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    periodKey: mongoEq(String(periodKey)),
  }).sort({ number: 1 }).lean();
}

/**
 * Record that an invoice the portal issued has been pushed to Xero as a draft. Sets
 * `xero` on the invoice, and, while both are written, the older
 * `pdflinks.xeroInvoiceNumber` on its document rows, which the draft push still reads.
 */
export async function stampXero(invoiceId, xeroInvoiceNumber, xeroId = undefined) {
  const xero = { invoiceNumber: String(xeroInvoiceNumber), ...(xeroId ? { id: String(xeroId) } : {}) };
  const updated = await Invoice.findByIdAndUpdate(invoiceId, { $set: { xero } }, { new: true }).lean();
  if (!updated) throw new Error(`Invoice ${invoiceId} not found`);
  await PDFLink.updateMany({ invoiceId: updated._id }, { $set: { xeroInvoiceNumber: xero.invoiceNumber } });
  return updated;
}
