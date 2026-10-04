import { BACKFILL_REASON, INVOICE_TRIGGER } from '../../../constants/invoiceLedger.js';
import {
  cleanName, earliest, numberKey, parsed, participantKey, printedTotal, suppressKey, validDate,
} from './context.js';
import { newDraft } from './registry.js';
import { note } from './report.js';

/**
 * Rules 1 and 2 (design 6.2): ledger rows become invoices. A row with no number is placed
 * through the log (by document link, then by item when the item's log row does not name a
 * different document). A row with no board takes its item's, because the old routes never
 * stored one. Deleted documents are not invoices and suppress the number on that board, so
 * the log cannot bring them back. Pure apart from the report and the context's suppressions.
 */

/**
 * The number of a ledger row: its own, else the log row with the same document link, else
 * the item's PDF log row. The log keeps only the latest number per item, so by item it may
 * only be used when the log row does not point at a different document: otherwise this row
 * is an older document, and the item's latest number is not its number.
 */
function resolveNumber(row, ctx) {
  if (row.invoiceNumber) return row.invoiceNumber;
  const byLink = row.pdfLink ? ctx.logPdfByLink.get(row.pdfLink)?.[0] : undefined;
  if (byLink) return byLink.invoiceNumber;
  const byItem = ctx.logPdfByItem.get(row.itemId)?.[0];
  const contradicts = byItem?.pdfLink && row.pdfLink && byItem.pdfLink !== row.pdfLink;
  return byItem && !contradicts ? byItem.invoiceNumber : undefined;
}

const boardOf = (row, ctx) => row.boardId
  ?? ctx.itemsById.get(row.itemId)?.boardId
  ?? ctx.logPdfByItem.get(row.itemId)?.[0]?.boardId;

const participantOf = (row, ctx) => cleanName(row.participant) || cleanName(ctx.itemsById.get(row.itemId)?.participantName);

/** The rows with number, board and participant resolved; rows that cannot be placed are reported and dropped. */
function placeRows(ctx, report) {
  const placed = [];
  for (const row of ctx.ledgerInvoiceRows) {
    const number = parsed(resolveNumber(row, ctx));
    if (!number) {
      note(report, 'unplaceableLedgerRows', { ledgerRowId: row.id, itemId: row.itemId });
      continue;
    }
    placed.push({
      ...row, ...number, boardId: boardOf(row, ctx), participantName: participantOf(row, ctx),
    });
    if (!ctx.itemsById.has(row.itemId)) note(report, 'deletedItems', { itemId: row.itemId, number: number.number });
  }
  return placed;
}

const invoiceKeyOf = (row) => `${row.boardId}|${numberKey(row.source, row.number)}`;

/** Rows of documents that are not deleted; a number whose rows are all deleted is suppressed on its board and reported. */
function dropDeleted(rows, ctx, report) {
  const byKey = new Map();
  for (const row of rows) byKey.set(invoiceKeyOf(row), [...(byKey.get(invoiceKeyOf(row)) || []), row]);
  const kept = [];
  for (const group of byKey.values()) {
    const live = group.filter((row) => row.isDeleted !== true);
    if (live.length === 0) {
      ctx.suppressed.add(suppressKey(group[0].boardId, group[0].source, group[0].number));
      note(report, 'deletedDocuments', { number: group[0].number });
    } else kept.push(...live);
  }
  return kept;
}

const itemSetKey = (group) => [...new Set(group.rows.map((r) => r.itemId))].sort().join(',');
const issuedAtOf = (rows) => earliest(rows.map((r) => validDate(r.invoiceDate) ?? r.createdAt));

/** Rows sharing board, number, participant and document link: one document. */
function groupByDocument(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [invoiceKeyOf(row), participantKey(row.participantName), row.pdfLink ?? ''].join('|');
    const group = groups.get(key) || { rows: [], participantName: row.participantName, boardId: row.boardId };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Documents of one number that are the same invoice (same participant, same items) are merged. */
function clusterInvoices(groups, report) {
  const clusters = [];
  for (const group of groups) {
    const same = clusters.find((c) => participantKey(c[0].participantName) === participantKey(group.participantName)
      && itemSetKey(c[0]) === itemSetKey(group));
    if (same) same.push(group);
    else clusters.push([group]);
  }
  for (const cluster of clusters.filter((c) => c.length > 1)) {
    const totals = new Set(cluster.map((g) => printedTotal(g.rows[0].invoiceTotal)).filter((t) => t !== undefined));
    note(report, 'regeneratedDocuments', { number: cluster[0].rows[0].number, ...(totals.size > 1 ? { totalsDiffer: true } : {}) });
  }
  return clusters;
}

/** One draft from the documents that are the same invoice. The latest document's total stands. */
function draftFromCluster(cluster) {
  const rows = cluster.flatMap((g) => g.rows);
  const first = rows[0];
  const byDate = [...cluster].sort((a, b) => issuedAtOf(a.rows) - issuedAtOf(b.rows));
  const latestTotal = [...byDate].reverse().map((g) => printedTotal(g.rows[0].invoiceTotal)).find((t) => t !== undefined);
  const automated = rows.find((r) => r.periodKey);
  const xeroRow = [...rows].filter((r) => r.xeroInvoiceNumber).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
  const draft = newDraft({
    boardId: first.boardId, source: first.source, number: first.number, legacyNumbers: [...new Set(rows.flatMap((r) => r.legacyNumbers))],
    participantName: first.participantName, reason: BACKFILL_REASON.LEDGER,
  });
  Object.assign(draft, {
    itemIds: [...new Set(rows.map((r) => r.itemId))].sort(),
    issuedAt: issuedAtOf(rows),
    pdfLinks: [...new Set(byDate.map((g) => g.rows[0].pdfLink).filter(Boolean))],
    ledgerRowIds: rows.map((r) => r.id),
    knownTotal: latestTotal,
    xero: xeroRow ? { invoiceNumber: parsed(xeroRow.xeroInvoiceNumber)?.number ?? String(xeroRow.xeroInvoiceNumber) } : undefined,
    ...(automated ? {
      trigger: INVOICE_TRIGGER.AUTOMATION, periodKey: automated.periodKey, periodStart: automated.periodStart, periodEnd: automated.periodEnd,
    } : {}),
  });
  return draft;
}

export function ledgerDrafts(ctx, report) {
  const rows = dropDeleted(placeRows(ctx, report), ctx, report);
  const byNumber = new Map();
  for (const group of groupByDocument(rows)) {
    const key = invoiceKeyOf(group.rows[0]);
    byNumber.set(key, [...(byNumber.get(key) || []), group]);
  }
  return [...byNumber.values()].flatMap((groups) => clusterInvoices(groups, report).map(draftFromCluster));
}
