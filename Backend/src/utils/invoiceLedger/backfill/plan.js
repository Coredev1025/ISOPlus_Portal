import { buildContext, participantKey } from './context.js';
import { finalize } from './finalize.js';
import { ledgerDrafts } from './ledgerGroups.js';
import { newReport } from './report.js';
import { addLogRows, addMarkers, addXeroRows } from './sources.js';

/**
 * The invoice backfill planner (KAN-310, design section 6): turns the three old stores into
 * the invoices the new record should hold. Pure: it reads nothing and writes nothing, so a
 * dry run is exactly this and the real run applies its output.
 *
 * inputs {
 *   workspaceId, boards { [boardId]: { label } },
 *   items      [{ itemId, boardId, invoicedBy, invoicedAt, participantName }]  items that exist
 *   logRows    [{ itemId, boardId, invoiceNumber, type: 'PDF'|'Xero', pdfLink, createdAt, updatedAt }]
 *   ledgerRows [{ id, itemId, boardId, type, invoiceNumber, invoiceTotal, invoiceDate, createdAt,
 *                 pdfLink, participant, xeroInvoiceNumber, isDeleted, periodKey, periodStart, periodEnd }]
 *   existing   [{ id, boardId, participantName, source, number, duplicateOrdinal, itemIds, issuedAt, xero }]
 *              invoices already in the collection
 * }
 * deriveTotal({ boardId, kind, lowCat, itemIds, knownTotal }) -> { total, perItem } | null
 *
 * Returns { invoices, pointers, stamps, xeroAttachments, report }. Sources run in order and
 * share one registry of drafts: ledger groups, markers, the log, then Xero rows.
 */
export async function planBackfill(inputs, { deriveTotal }) {
  const ctx = buildContext({
    ...inputs,
    existing: (inputs.existing || []).map((e) => ({ ...e, participantKey: e.participantName ? participantKey(e.participantName) : undefined })),
  });
  const report = newReport();
  report.counts.revisitedLogRows = ctx.logRows.filter((r) => new Date(r.updatedAt) - new Date(r.createdAt) > 60_000).length;

  const drafts = ledgerDrafts(ctx, report);
  addMarkers(ctx, drafts, report);
  addLogRows(ctx, drafts, report);
  const xeroAttachments = addXeroRows(ctx, drafts, report);

  const planned = await finalize({
    drafts, ctx, deriveTotal, report,
  });
  return { ...planned, xeroAttachments };
}
