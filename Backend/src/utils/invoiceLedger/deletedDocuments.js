import PDFLink from '../../models/PDFLink.js';
import { mongoEq } from '../securityHelpers.js';
import { numberForms } from './numbers.js';

/**
 * Invoices whose documents have all been deleted (KAN-309). `PUT /api/pdf-link` marks a
 * document row `isDeleted`, and the old statement left such documents out. Nothing voids
 * the matching invoice record, so the statement reading the record must apply the same
 * rule or a deleted invoice would come back as a charge. An invoice with no document at all
 * (a backfilled marker-only invoice) stays. Never mutates its input.
 */
export async function withoutDeletedDocuments(workspaceId, boardId, invoices) {
  if (!invoices?.length) return { kept: [], excluded: [] };
  const ids = invoices.map((inv) => inv._id);
  const forms = invoices.flatMap((inv) => numberForms(inv.number));
  const rows = await PDFLink.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    $or: [{ invoiceId: { $in: ids } }, { invoiceNumber: { $in: forms.map((f) => mongoEq(f)) } }],
  }).select('invoiceId invoiceNumber isDeleted').lean();

  const documentsOf = (inv) => rows.filter((row) => String(row.invoiceId) === String(inv._id)
    || numberForms(inv.number).includes(row.invoiceNumber));
  const deletedOnly = (inv) => {
    const docs = documentsOf(inv);
    return docs.length > 0 && docs.every((doc) => doc.isDeleted === true);
  };
  return {
    kept: invoices.filter((inv) => !deletedOnly(inv)),
    excluded: invoices.filter(deletedOnly),
  };
}
