import {
  BACKFILL_REASON, INVOICE_ORIGIN, INVOICE_STATUS, INVOICE_TRIGGER,
} from '../../../constants/invoiceLedger.js';
import { kindOfBoard, numberKey, parsed } from './context.js';
import { issuedAtOf } from './registry.js';
import { note } from './report.js';

/**
 * Turns the drafts into invoice documents (design 6.2 rules 4, 8, 9 and 6.3). Checks each
 * draft can be placed (board kind, participant, date, total), skips what already exists,
 * gives a duplicate number its ordinal, and works out the ledger-row stamps and each item's
 * active invoice. Pure apart from the injected `deriveTotal`.
 */

/** Why a draft cannot become an invoice, or null. */
function problemWith(draft, board) {
  if (!kindOfBoard(board)) return 'board-unknown';
  if (!draft.participantName) return 'participant-unknown';
  if (!issuedAtOf(draft)) return 'date-unknown';
  return null;
}

/**
 * The total and per-item amounts. A printed total stands even when nothing can be derived
 * (the items may be gone): the lines then carry no amounts and the invoice is reported.
 */
async function priced(draft, board, deriveTotal, report) {
  const { kind, lowCat } = kindOfBoard(board);
  const derived = await deriveTotal({
    boardId: draft.boardId, kind, lowCat, itemIds: draft.itemIds, knownTotal: draft.knownTotal,
  });
  if (!derived && draft.knownTotal === undefined) return { ...draft, problem: 'total-underivable' };
  if (!derived) note(report, 'amountsUnknown', { number: draft.number });
  return {
    ...draft,
    kind,
    lowCat,
    total: draft.knownTotal ?? derived.total,
    totalDerived: draft.knownTotal === undefined,
    perItem: derived?.perItem || {},
    amountsUnknown: !derived,
  };
}

async function placeDrafts(drafts, ctx, deriveTotal, report) {
  const placed = [];
  for (const draft of drafts) {
    const board = ctx.boards[draft.boardId];
    const problem = problemWith(draft, board);
    placed.push(problem ? { ...draft, problem } : await priced(draft, board, deriveTotal, report));
  }
  return placed;
}

/** The existing invoice a draft is: same number and source, and the same items or the same participant. */
const heldBy = (draft, existing) => existing.find((e) => e.source === draft.source && e.number === draft.number
  && (e.itemIds.some((id) => draft.itemIds.includes(id))
    || (e.participantKey && e.participantKey === draft.participantKey && e.boardId === draft.boardId)));

/**
 * Split into the drafts the collection already holds and the new ones. A draft with items
 * the existing invoice does not list is reported, not minted as a second invoice.
 */
function splitExisting(placed, existing, report) {
  const recorded = [];
  const fresh = [];
  for (const draft of placed) {
    const held = heldBy(draft, existing);
    if (!held) {
      fresh.push(draft);
      continue;
    }
    const missing = draft.itemIds.filter((id) => !held.itemIds.includes(id));
    if (missing.length > 0) note(report, 'existingMissingItems', { number: draft.number, itemIds: missing });
    recorded.push({ draft, held });
  }
  return { recorded, fresh };
}

const orderKey = (draft) => `${new Date(issuedAtOf(draft)).toISOString()}|${draft.itemIds.join()}`;

/** Within one number, the earliest invoice owns it (ordinal 0) unless the collection already does. */
function assignOrdinals(fresh, existing, report) {
  const byKey = new Map();
  for (const draft of fresh) byKey.set(numberKey(draft.source, draft.number), [...(byKey.get(numberKey(draft.source, draft.number)) || []), draft]);
  const out = [];
  for (const [key, group] of byKey) {
    const held = existing.filter((e) => numberKey(e.source, e.number) === key);
    const first = held.length > 0 ? Math.max(...held.map((e) => e.duplicateOrdinal || 0)) + 1 : 0;
    [...group].sort((a, b) => orderKey(a).localeCompare(orderKey(b))).forEach((draft, i) => out.push({ ...draft, duplicateOrdinal: first + i }));
    if (held.length + group.length > 1) {
      note(report, 'duplicateNumbers', { number: group[0].number, boardId: group[0].boardId, itemIds: group.flatMap((d) => d.itemIds) });
    }
  }
  return out;
}

const amountsOf = (draft) => draft.itemIds.map((itemId) => ({ itemId, amount: draft.perItem[itemId] ?? 0 }));

const notesOf = (draft) => [
  ...(draft.revisited ? ['issued-at-approximate'] : []),
  ...(draft.amountsUnknown ? ['amounts-unknown'] : []),
];

function toInvoice(draft, workspaceId) {
  const notes = notesOf(draft);
  return {
    ref: `${draft.source}|${draft.number}|${draft.duplicateOrdinal}`,
    workspaceId,
    boardId: draft.boardId,
    number: draft.number,
    source: draft.source,
    legacyNumbers: draft.legacyNumbers,
    duplicateOrdinal: draft.duplicateOrdinal,
    kind: draft.kind,
    ...(draft.lowCat === undefined ? {} : { lowCat: draft.lowCat }),
    participant: { name: draft.participantName },
    lines: amountsOf(draft),
    total: draft.total,
    totalDerived: draft.totalDerived,
    issuedAt: issuedAtOf(draft),
    trigger: draft.trigger ?? INVOICE_TRIGGER.MANUAL,
    ...(draft.periodKey ? { periodKey: draft.periodKey, periodStart: draft.periodStart, periodEnd: draft.periodEnd } : {}),
    status: INVOICE_STATUS.ISSUED,
    ...(draft.pdfLinks[0] ? { pdf: { pdfLink: draft.pdfLinks[0] } } : {}),
    ...(draft.pdfLinks.length > 1 ? { extraPdfLinks: draft.pdfLinks.slice(1) } : {}),
    ...(draft.xero ? { xero: draft.xero } : {}),
    origin: INVOICE_ORIGIN.BACKFILL,
    backfill: { reason: draft.reason, ...(notes.length ? { notes } : {}) },
    ledgerRowIds: draft.ledgerRowIds,
  };
}

/** Rule 9: the invoice whose number is the item's marker, else the latest that lists it. Deterministic. */
function chooseActive(candidates, marker) {
  const named = marker && candidates.find((c) => c.source === marker.source && c.number === marker.number);
  if (named) return named;
  return [...candidates].sort((a, b) => new Date(b.issuedAt) - new Date(a.issuedAt) || String(a.key).localeCompare(String(b.key)))[0];
}

/** Each touched item's active invoice, among the new invoices and the ones that already exist. */
function pointersFor(invoices, recorded, existing, ctx) {
  const byItem = new Map();
  const add = (itemId, entry) => byItem.set(itemId, [...(byItem.get(itemId) || []), entry]);
  invoices.forEach((inv) => inv.lines.forEach((l) => add(l.itemId, {
    source: inv.source, number: inv.number, issuedAt: inv.issuedAt, key: inv.ref, ref: inv.ref,
  })));
  existing.forEach((e) => e.itemIds.forEach((id) => add(id, {
    source: e.source, number: e.number, issuedAt: e.issuedAt, key: `${e.number}|${e.duplicateOrdinal || 0}|${e.id}`, invoiceId: e.id,
  })));
  const touched = new Set([
    ...invoices.flatMap((inv) => inv.lines.map((l) => l.itemId)),
    ...recorded.flatMap(({ draft, held }) => draft.itemIds.filter((id) => held.itemIds.includes(id))),
  ]);
  return [...touched].sort().map((itemId) => {
    const choice = chooseActive(byItem.get(itemId), parsed(ctx.itemsById.get(itemId)?.invoicedBy));
    return choice.ref ? { itemId, ref: choice.ref } : { itemId, invoiceId: choice.invoiceId };
  });
}

function reportDoubleBilled(invoices, existing, report) {
  const byItem = new Map();
  const add = (itemId, number) => byItem.set(itemId, [...(byItem.get(itemId) || []), number]);
  invoices.forEach((inv) => inv.lines.forEach((l) => add(l.itemId, inv.number)));
  existing.forEach((e) => e.itemIds.forEach((id) => add(id, e.number)));
  for (const [itemId, numbers] of [...byItem].sort()) {
    if (numbers.length > 1) note(report, 'doubleBilled', { itemId, invoices: [...new Set(numbers)].sort() });
  }
}

function reportMarkerMissing(invoices, ctx, report) {
  for (const inv of invoices.filter((i) => i.backfill.reason === BACKFILL_REASON.LEDGER)) {
    if (inv.lines.every((l) => !ctx.itemsById.get(l.itemId)?.invoicedBy)) note(report, 'markerMissing', { number: inv.number });
  }
}

const stampsFor = (invoices, recorded) => [
  ...invoices.flatMap((inv) => inv.ledgerRowIds.map((ledgerRowId) => ({ ledgerRowId, ref: inv.ref }))),
  ...recorded.flatMap(({ draft, held }) => (held.id ? draft.ledgerRowIds.map((ledgerRowId) => ({ ledgerRowId, invoiceId: held.id })) : [])),
];

function countsFor(invoices, recorded, report) {
  for (const inv of invoices) report.counts.created[inv.backfill.reason] = (report.counts.created[inv.backfill.reason] || 0) + 1;
  report.counts.alreadyRecorded = recorded.length;
  report.counts.itemsLinked = new Set(invoices.flatMap((inv) => inv.lines.map((l) => l.itemId))).size;
}

export async function finalize({
  drafts, ctx, deriveTotal, report,
}) {
  const placed = await placeDrafts(drafts, ctx, deriveTotal, report);
  placed.filter((d) => d.problem).forEach((d) => note(report, 'unplaceable', {
    number: d.number, source: d.source, reason: d.problem, boardId: d.boardId, itemIds: d.itemIds,
  }));
  const { recorded, fresh } = splitExisting(placed.filter((d) => !d.problem), ctx.existing, report);
  const invoices = assignOrdinals(fresh, ctx.existing, report).map((d) => toInvoice(d, ctx.workspaceId));

  reportDoubleBilled(invoices, ctx.existing, report);
  reportMarkerMissing(invoices, ctx, report);
  countsFor(invoices, recorded, report);

  return {
    invoices: invoices.map(({ ledgerRowIds, ...doc }) => doc),
    pointers: pointersFor(invoices, recorded, ctx.existing, ctx),
    stamps: stampsFor(invoices, recorded),
    report,
  };
}
