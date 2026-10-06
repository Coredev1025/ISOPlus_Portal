import { BACKFILL_REASON, INVOICE_SOURCE } from '../../../constants/invoiceLedger.js';
import {
  isPending, latestFirst, parsed, participantKey, rowDate, suppressKey, xeroIsLater,
} from './context.js';
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
 * The item's latest Xero row when it is strictly later than this PDF row (KAN-315). The PDF row
 * is only dropped when that Xero invoice will really take the item, so nothing is ever left on no
 * invoice: not when the item carries a marker (D8 stands), not when the Xero number belongs to a
 * deleted document. The latest row is chosen with the marker backfill's own comparator.
 */
function supersedingXeroRow(ctx, item, pdfRow) {
  const latest = (ctx.logXeroByItem.get(item.itemId) || []).filter((r) => parsed(r.invoiceNumber)).sort(latestFirst)[0];
  if (!latest || !xeroIsLater(pdfRow, latest) || billedElsewhere(item)) return null;
  const xero = parsed(latest.invoiceNumber);
  return ctx.suppressed.has(suppressKey(item.boardId, xero.source, xero.number)) ? null : latest;
}

/** Leave this PDF row off the portal when the item's later Xero invoice takes over; true when it did. */
function supersede(ctx, item, row, number) {
  const xeroRow = supersedingXeroRow(ctx, item, row);
  if (xeroRow) ctx.superseded.push({ itemId: row.itemId, row, number, xeroRow });
  return Boolean(xeroRow);
}

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
    if (supersede(ctx, item, row, number)) continue;
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
  const taken = ctx.superseded.filter((entry) => entry.itemId === row.itemId);
  if (taken.length > 0 && !taken.some((entry) => entry.xeroRow === row)) {
    note(report, 'staleLegacy', { itemId: row.itemId, number: xero.number, marker: null });
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
  const replaced = ctx.superseded.filter((entry) => entry.xeroRow === row);
  place(drafts, sighting(item, xero, replaced.length > 0 ? BACKFILL_REASON.XERO_LATER : BACKFILL_REASON.XERO_ONLY, {
    dates: [rowDate(row)], revisited: isRevisited(row), pdfLink: replaced[0]?.row.pdfLink,
  }));
  label(xero.number, '(xero only)');
  noteSuperseded(replaced, row, xero, item, state);
}

/** KAN-315: report each item the Xero invoice took over from a portal invoice (rule 5, latest wins). */
function noteSuperseded(replaced, row, xero, item, { report, superseded }) {
  for (const { row: pdfRow, number } of replaced) {
    note(report, 'supersededByXero', {
      itemId: row.itemId, portal: number.number, xero: xero.number, portalAt: rowDate(pdfRow), xeroAt: rowDate(row),
    });
    superseded.push({
      itemId: row.itemId, boardId: item.boardId, participantKey: participantKey(item.participantName), portal: number, xero: xero.number,
    });
  }
}

/**
 * A portal invoice every one of whose items went to a Xero invoice no longer exists as an invoice:
 * report it, so a person knows an old number now lives only in the log and the document link.
 */
function reportEmptiedPortalInvoices(superseded, drafts, existing, report) {
  const groups = new Map();
  for (const entry of superseded) {
    const key = `${entry.boardId}|${entry.participantKey}|${entry.portal.number}`;
    const before = groups.get(key);
    groups.set(key, { ...entry, xeros: new Set([...(before?.xeros || []), entry.xero]), itemIds: [...(before?.itemIds || []), entry.itemId] });
  }
  for (const group of [...groups.values()].sort((a, b) => a.portal.number.localeCompare(b.portal.number))) {
    const same = (inv) => inv.source === INVOICE_SOURCE.PORTAL && inv.number === group.portal.number
      && inv.boardId === group.boardId && (inv.participantKey === undefined || inv.participantKey === group.participantKey);
    const stillThere = drafts.some(same) || existing.some(same);
    if (!stillThere) note(report, 'supersededPortalInvoices', {
      number: group.portal.number, boardId: group.boardId, supersededBy: [...group.xeros].sort(), itemIds: group.itemIds.sort(),
    });
  }
}

export function addXeroRows(ctx, drafts, report) {
  const attachments = [];
  const spans = new Map();
  const label = (xeroNumber, name) => spans.set(xeroNumber, new Set([...(spans.get(xeroNumber) || []), name]));
  const rows = ctx.logRows.filter((r) => r.type === 'Xero')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || String(a.invoiceNumber).localeCompare(String(b.invoiceNumber)));
  const superseded = [];
  const state = {
    ctx, drafts, report, attachments, label, superseded,
  };
  rows.forEach((row) => addXeroRow(row, state));
  reportEmptiedPortalInvoices(superseded, drafts, ctx.existing, report);
  for (const [xeroNumber, names] of spans) {
    if (names.size > 1) note(report, 'xeroSpansInvoices', { xeroNumber, invoices: [...names].sort(labelOrder) });
  }
  return attachments;
}

