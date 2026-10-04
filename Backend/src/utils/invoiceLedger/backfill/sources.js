import { BACKFILL_REASON, INVOICE_SOURCE } from '../../../constants/invoiceLedger.js';
import { isPending, parsed, suppressKey } from './context.js';
import { draftsListing, place } from './registry.js';
import { note } from './report.js';

/**
 * Rules 3 to 7 (design 6.2): invoices the ledger rows do not hold, found in the item markers
 * and the old log, and the Xero rows. Each source adds its items to the shared registry, so
 * an item joins the invoice another source already described. Pure apart from the registry
 * and report passed in.
 */

const REVISITED_MS = 60_000;
const isRevisited = (row) => new Date(row.updatedAt) - new Date(row.createdAt) > REVISITED_MS;

const listedBy = (drafts, existing, itemId, source, number) => [...draftsListing(drafts, itemId), ...existing.filter((e) => e.itemIds.includes(itemId))]
  .some((inv) => inv.source === source && inv.number === number);

const rowsOf = (ctx, itemId) => [...(ctx.logPdfByItem.get(itemId) || []), ...(ctx.logXeroByItem.get(itemId) || [])];

/** The sighting of an item on an invoice, in the shape `place` takes. */
const sighting = (item, number, reason, extra = {}) => ({
  boardId: item.boardId,
  source: number.source,
  number: number.number,
  legacyNumbers: number.legacyNumbers,
  participantName: item.participantName,
  itemId: item.itemId,
  reason,
  ...extra,
});

/** Rule 3, marker-only: items marked with a number no invoice lists. Pending tokens are listed, never invoices. */
export function addMarkers(ctx, drafts, report) {
  for (const item of ctx.items) {
    if (isPending(item.invoicedBy)) {
      note(report, 'pendingTokens', { itemId: item.itemId, marker: item.invoicedBy });
      continue;
    }
    const marker = parsed(item.invoicedBy);
    if (!marker) continue;
    if (ctx.suppressed.has(suppressKey(item.boardId, marker.source, marker.number))) {
      note(report, 'suppressedMarkers', { itemId: item.itemId, marker: item.invoicedBy });
      continue;
    }
    if (listedBy(drafts, ctx.existing, item.itemId, marker.source, marker.number)) continue;
    const row = rowsOf(ctx, item.itemId).find((r) => parsed(r.invoiceNumber)?.number === marker.number);
    place(drafts, sighting(item, marker, BACKFILL_REASON.MARKER_ONLY, {
      dates: [item.invoicedAt, row?.createdAt], pdfLink: row?.pdfLink, revisited: row ? isRevisited(row) : false,
    }));
  }
}

/** Whether the item is billed on something else, by its marker (rule 7): then a log row is only the latest entry. */
const billedElsewhere = (item) => {
  const marker = parsed(item.invoicedBy);
  return Boolean(marker) && !isPending(item.invoicedBy);
};

/**
 * Rule 3, log-only: PDF log rows that are the only record of an invoice. A row for an item
 * whose marker names a different number is stale (rule 7). An item that another invoice
 * already lists but has no marker keeps its logged invoice too: the log holds the item's
 * latest number, so it is billed twice (reported as double-billed), not once.
 */
export function addLogRows(ctx, drafts, report) {
  for (const row of ctx.logRows.filter((r) => r.type !== 'Xero')) {
    const number = parsed(row.invoiceNumber);
    const item = ctx.itemsById.get(row.itemId);
    if (!number) continue;
    if (!item) {
      note(report, 'deletedItems', { itemId: row.itemId, number: number.number });
      continue;
    }
    if (ctx.suppressed.has(suppressKey(item.boardId, number.source, number.number))) continue;
    if (listedBy(drafts, ctx.existing, row.itemId, number.source, number.number)) continue;
    if (billedElsewhere(item)) {
      note(report, 'staleLegacy', { itemId: row.itemId, number: number.number, marker: item.invoicedBy });
      continue;
    }
    place(drafts, sighting(item, number, BACKFILL_REASON.LOG_ONLY, {
      dates: [row.createdAt], pdfLink: row.pdfLink, revisited: isRevisited(row),
    }));
  }
}

const portalInvoicesFor = (drafts, existing, itemId) => [
  ...draftsListing(drafts, itemId).filter((d) => d.source === INVOICE_SOURCE.PORTAL).map((d) => ({ draft: d, number: d.number })),
  ...existing.filter((e) => e.source === INVOICE_SOURCE.PORTAL && e.itemIds.includes(itemId)).map((e) => ({ existing: e, number: e.number })),
];

/** Attach a Xero number to a portal invoice once; a different second number is reported, not applied. */
function attach(target, xeroNumber, attachments, report) {
  const current = target.draft ? target.draft.xero : (target.existing.xero
    ?? attachments.find((a) => a.invoiceId === target.existing.id)?.xero);
  if (!current) {
    if (target.draft) target.draft.xero = { invoiceNumber: xeroNumber };
    else attachments.push({ invoiceId: target.existing.id, xero: { invoiceNumber: xeroNumber } });
  } else if (current.invoiceNumber !== xeroNumber) {
    const seen = report.lists.xeroConflicts.some((c) => c.invoice === target.number && c.dropped === xeroNumber);
    if (!seen) note(report, 'xeroConflicts', { invoice: target.number, kept: current.invoiceNumber, dropped: xeroNumber });
  }
}

const labelOrder = (a, b) => (a === '(xero only)') - (b === '(xero only)') || a.localeCompare(b);

/**
 * Rule 5: Xero rows. An item on a portal invoice takes the Xero number on it (D8), never a
 * second charge; an item on none becomes a Xero invoice. The earliest Xero row wins when an
 * item has two numbers. Returns the attachments for invoices that already exist.
 */
/** One Xero row: attach it to the portal invoices the item is on, or place it as a Xero invoice. */
function addXeroRow(row, state) {
  const { ctx, drafts, report, attachments, label } = state;
  const xero = parsed(row.invoiceNumber);
  const item = ctx.itemsById.get(row.itemId);
  if (!xero) return;
  if (!item) {
    note(report, 'deletedItems', { itemId: row.itemId, number: xero.number });
    return;
  }
  const portals = portalInvoicesFor(drafts, ctx.existing, row.itemId);
  portals.forEach((target) => {
    attach(target, xero.number, attachments, report);
    label(xero.number, target.number);
  });
  if (portals.length > 0 || ctx.suppressed.has(suppressKey(item.boardId, xero.source, xero.number))) return;
  if (listedBy(drafts, ctx.existing, row.itemId, xero.source, xero.number)) return;
  if (billedElsewhere(item)) {
    note(report, 'staleLegacy', { itemId: row.itemId, number: xero.number, marker: item.invoicedBy });
    return;
  }
  place(drafts, sighting(item, xero, BACKFILL_REASON.XERO_ONLY, { dates: [row.createdAt], revisited: isRevisited(row) }));
  label(xero.number, '(xero only)');
}

export function addXeroRows(ctx, drafts, report) {
  const attachments = [];
  const spans = new Map();
  const label = (xeroNumber, name) => spans.set(xeroNumber, new Set([...(spans.get(xeroNumber) || []), name]));
  const rows = ctx.logRows.filter((r) => r.type === 'Xero')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || String(a.invoiceNumber).localeCompare(String(b.invoiceNumber)));
  const state = {
    ctx, drafts, report, attachments, label,
  };
  rows.forEach((row) => addXeroRow(row, state));
  for (const [xeroNumber, names] of spans) {
    if (names.size > 1) note(report, 'xeroSpansInvoices', { xeroNumber, invoices: [...names].sort(labelOrder) });
  }
  return attachments;
}

