import InvoiceNumber from '../../models/InvoiceNumber.js';
import { PDF_LINK_SHADOW_CLASS, READ_MODE } from '../../constants/invoiceLedger.js';
import { info, warn } from '../logger.js';
import { invoiceLedgerReadMode } from './flags.js';
import { byNumberOnBoard } from './read.js';

/**
 * The pdf-link lookup behind `GET /api/items/:ws/:board/invoice/:number/pdf-link` (KAN-313),
 * on `INVOICE_LEDGER_READ`: `off` the old log, as before; `shadow` the old answer with any
 * difference from the invoice record logged with a class; `on` the invoice record. Each side
 * returns `{ status, body }`, the route's own answer, so the response shape never changes.
 */

const NOT_FOUND = { status: 404, body: { message: 'Invoice not found or is not a PDF invoice' } };
const NO_LINK = { status: 404, body: { message: 'PDF link not available for this invoice' } };

/** The old answer: the log (type PDF) by the number as given, then with the suffix added. Unchanged from the route. */
export async function legacyPdfLink({ workspaceId, boardId, number }) {
  let record = await InvoiceNumber.findOne({
    workspaceId, boardId, invoiceNumber: number, type: 'PDF',
  }).lean();
  if (!record) {
    record = await InvoiceNumber.findOne({
      workspaceId, boardId, invoiceNumber: `${number} (ISO+™)`, type: 'PDF',
    }).lean();
  }
  if (!record) return NOT_FOUND;
  if (!record.pdfLink) return NO_LINK;
  return { status: 200, body: { pdfLink: record.pdfLink, invoiceNumber: record.invoiceNumber, itemId: record.itemId } };
}

/**
 * The invoice record's answer: any form of the number resolves, on the board asked for, and the
 * number comes back as it was stored (the legacy form when there is one), with the first item.
 */
export async function ledgerPdfLink({ workspaceId, boardId, number }) {
  const invoice = await byNumberOnBoard(workspaceId, boardId, number);
  if (!invoice) return NOT_FOUND;
  if (!invoice.pdf?.pdfLink) return invoice.source === 'xero' ? NOT_FOUND : NO_LINK;
  return {
    status: 200,
    body: {
      pdfLink: invoice.pdf.pdfLink,
      invoiceNumber: invoice.legacyNumbers?.[0] ?? invoice.number,
      itemId: invoice.lines?.[0]?.itemId,
    },
  };
}

/** The class of a difference between the two answers, or null when they agree. */
export function pdfLinkDifference(legacy, ledger) {
  const legacyFound = legacy.status === 200;
  const ledgerFound = ledger.status === 200;
  if (legacyFound && ledgerFound) return legacy.body.pdfLink === ledger.body.pdfLink ? null : PDF_LINK_SHADOW_CLASS.DIFFERS;
  if (legacyFound) return PDF_LINK_SHADOW_CLASS.LEGACY_ONLY;
  return ledgerFound ? PDF_LINK_SHADOW_CLASS.LEDGER_ONLY : null;
}

async function shadow(legacy, args) {
  try {
    const cls = pdfLinkDifference(legacy, await ledgerPdfLink(args));
    if (!cls) return;
    const log = cls === PDF_LINK_SHADOW_CLASS.LEDGER_ONLY ? info : warn;
    log('InvoiceLedger', 'Shadow difference', { class: cls, workspaceId: args.workspaceId, boardId: args.boardId, number: args.number });
  } catch (err) {
    warn('InvoiceLedger', 'PDF link lookup could not be compared with the invoice record', { workspaceId: args.workspaceId, message: err.message });
  }
}

export async function lookupPdfLink(args) {
  const mode = invoiceLedgerReadMode();
  if (mode === READ_MODE.ON) return ledgerPdfLink(args);
  const legacy = await legacyPdfLink(args);
  if (mode === READ_MODE.SHADOW) await shadow(legacy, args);
  return legacy;
}
