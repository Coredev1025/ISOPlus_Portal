import { isPending, validDate } from '../backfill/context.js';

/**
 * The marker backfill planner (KAN-312): which items get `invoicedBy` and `invoicedAt` from
 * the old log. Pure: reads nothing, writes nothing.
 *
 * In production no item carries a marker and the log is the only record of what was billed.
 * The marker is the guard that works when the log is not read, and the design removes the log
 * filter from scheduled selection, so every logged item that still exists needs one first.
 *
 * Rules: an item with any marker (a pending claim included) is left alone. Otherwise the
 * marker is the logged number exactly as stored (`INV-24 (ISO+™)`, `INV-0501 (Xero)`), the
 * date is the log row's. Where an item has both a PDF and a Xero row they are one billing
 * (D8) and the portal number is the marker; the Xero number lives on the portal invoice. The
 * earliest row of the preferred type wins. A row's date belongs to the first time that row was
 * written, and the log keeps one row per item per type overwritten by the next number, so a date
 * from a revisited row (updated more than a minute after it was created) is approximate.
 *
 * An item with several rows of one type (it changed board, or two upserts raced) takes the
 * LATEST row: the invoice backfill makes each row its own invoice and points an item with no
 * marker at the latest, so the marker and the pointer agree by construction. A row with a
 * number but no usable creation date still marks the item (a missing marker would make it
 * billable again): its date falls back to the last update, then to when the row was written
 * (`idDate`), then to none, and is counted approximate.
 *
 * inputs { items: [{ itemId, invoicedBy }]  items that exist,
 *          logRows: [{ itemId, invoiceNumber, type: 'PDF'|'Xero', createdAt, updatedAt }] }
 */

const REVISITED_MS = 60_000;
const isRevisited = (row) => new Date(row.updatedAt) - new Date(row.createdAt) > REVISITED_MS;
const hasMarker = (item) => Boolean(item.invoicedBy) || isPending(item.invoicedBy);
const usable = (row) => typeof row.invoiceNumber === 'string' && row.invoiceNumber.trim() !== '';

/** When a row was written: its creation date, else its last update, else the time its id was made, else nothing. */
const rowDate = (row) => validDate(row.createdAt) ?? validDate(row.updatedAt) ?? validDate(row.idDate) ?? null;
const hasCreatedDate = (row) => Boolean(validDate(row.createdAt));

/** Latest first; a tie goes to the higher number, the same for any input order. */
const latestFirst = (a, b) => (rowDate(b)?.getTime() ?? 0) - (rowDate(a)?.getTime() ?? 0)
  || String(b.invoiceNumber).localeCompare(String(a.invoiceNumber));

/** The row an item's marker comes from: the latest usable PDF row, else the latest usable Xero row. */
function chosenRow(rows) {
  const usableRows = rows.filter(usable);
  const pdf = usableRows.filter((r) => r.type !== 'Xero').sort(latestFirst);
  const xero = usableRows.filter((r) => r.type === 'Xero').sort(latestFirst);
  return pdf[0] ?? xero[0];
}

const rowsByItem = (logRows) => {
  const map = new Map();
  for (const row of logRows) map.set(row.itemId, [...(map.get(row.itemId) || []), row]);
  return map;
};

/** One item's marker from its log rows, and what it adds to the report counts. */
function markerFor(itemId, rows, report) {
  const row = chosenRow(rows);
  if (!row) {
    report.lists.unusableRows.push({ itemId });
    return null;
  }
  const from = row.type === 'Xero' ? 'Xero' : 'PDF';
  const approximate = isRevisited(row) || !hasCreatedDate(row);
  report.counts.byType[from] = (report.counts.byType[from] || 0) + 1;
  if (approximate) report.counts.approximateDates += 1;
  if (from === 'PDF' && rows.some((r) => r.type === 'Xero')) report.counts.hadBothTypes += 1;
  return {
    itemId, invoicedBy: row.invoiceNumber, invoicedAt: rowDate(row), from, approximate,
  };
}

export function planMarkers({ items, logRows }) {
  const report = {
    counts: {
      alreadyMarked: 0, hadBothTypes: 0, approximateDates: 0, byType: {},
    },
    lists: { deletedItems: [], unusableRows: [] },
  };
  const existing = new Map(items.map((item) => [item.itemId, item]));
  const markers = [];

  for (const [itemId, rows] of [...rowsByItem(logRows)].sort(([a], [b]) => a.localeCompare(b))) {
    const item = existing.get(itemId);
    if (!item) {
      rows.filter(usable).slice(0, 1).forEach((row) => report.lists.deletedItems.push({ itemId, number: row.invoiceNumber }));
    } else if (hasMarker(item)) {
      report.counts.alreadyMarked += 1;
    } else {
      const marker = markerFor(itemId, rows, report);
      if (marker) markers.push(marker);
    }
  }
  return { markers, report };
}
