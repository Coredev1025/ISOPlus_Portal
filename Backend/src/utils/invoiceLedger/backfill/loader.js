import { chunk } from 'lodash-es';

import Board from '../../../models/Board.js';
import Invoice from '../../../models/Invoice.js';
import InvoiceNumber from '../../../models/InvoiceNumber.js';
import Item from '../../../models/Item.js';
import PDFLink from '../../../models/PDFLink.js';
import { LEDGER_INVOICE_TYPES } from '../../../constants/invoiceLedger.js';
import { ATTRIBUTE_NAMES } from '../../../constants/monthlyStatementAttributes.js';
import { mongoEq } from '../../securityHelpers.js';

/**
 * Reads the three old stores (and what the invoice collection already holds) for one
 * workspace, in the shape the backfill planner takes (KAN-311). Reads only: nothing here
 * writes. Of the items, only those an invoice mentions are read (a production workspace
 * holds half a million), in chunks.
 */

const CHUNK = 500;
// An object projection: the field name has spaces, which a string projection would split.
const ITEM_FIELDS = {
  itemId: 1,
  boardId: 1,
  invoicedBy: 1,
  invoicedAt: 1,
  activeInvoiceId: 1,
  [`data.${ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME}`]: 1,
  [`data.${ATTRIBUTE_NAMES.PARTICIPANT_PROFILE}`]: 1,
};
const PROFILE_NAME = 'Full Name/Preferred Name';

const logRowOf = (row) => ({
  itemId: row.itemId,
  boardId: row.boardId,
  invoiceNumber: row.invoiceNumber,
  type: row.type,
  pdfLink: row.pdfLink,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  idDate: row._id?.getTimestamp?.(),
});

const ledgerRowOf = (row) => ({
  id: String(row._id),
  itemId: row.itemId,
  boardId: row.boardId,
  type: row.type,
  invoiceNumber: row.invoiceNumber,
  invoiceTotal: row.invoiceTotal,
  invoiceDate: row.invoiceDate,
  createdAt: row.createdAt,
  pdfLink: row.pdfLink,
  participant: row.participant,
  xeroInvoiceNumber: row.xeroInvoiceNumber,
  isDeleted: row.isDeleted === true,
  periodKey: row.periodKey,
  periodStart: row.periodStart,
  periodEnd: row.periodEnd,
});

const existingOf = (invoice) => ({
  id: String(invoice._id),
  boardId: invoice.boardId,
  participantName: invoice.participant?.name,
  source: invoice.source,
  number: invoice.number,
  duplicateOrdinal: invoice.duplicateOrdinal || 0,
  itemIds: (invoice.lines || []).map((line) => line.itemId),
  issuedAt: invoice.issuedAt,
  xero: invoice.xero?.invoiceNumber ? { invoiceNumber: invoice.xero.invoiceNumber } : undefined,
});

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

/** The ids a `Participant Profile` reference holds: plain ids or `{ id }` objects. */
const profileIdsOf = (item) => {
  const ref = item.data?.[ATTRIBUTE_NAMES.PARTICIPANT_PROFILE];
  return (Array.isArray(ref) ? ref : [ref]).map((entry) => (entry && typeof entry === 'object' ? entry.id : entry)).filter(Boolean).map(String);
};

const itemOf = (item, profileNames = new Map()) => ({
  itemId: item.itemId,
  boardId: item.boardId,
  invoicedBy: item.invoicedBy,
  invoicedAt: item.invoicedAt,
  activeInvoiceId: item.activeInvoiceId ? String(item.activeInvoiceId) : undefined,
  participantName: clean(item.data?.[ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME])
    || profileIdsOf(item).map((id) => profileNames.get(id)).find(Boolean),
});

async function itemsByIds(workspace, itemIds) {
  const found = [];
  for (const ids of chunk(itemIds, CHUNK)) {
    found.push(...await Item.find({ workspaceId: workspace, itemId: { $in: ids.map((id) => mongoEq(id)) } })
      .select(ITEM_FIELDS).lean());
  }
  return found;
}

/**
 * The name of each participant profile the items reference, for items that carry no name of
 * their own (the statement resolves a shift's participant through the same reference).
 */
async function profileNames(workspace, items) {
  const wanted = [...new Set(items.filter((i) => !clean(i.data?.[ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME])).flatMap(profileIdsOf))];
  const names = new Map();
  for (const ids of chunk(wanted, CHUNK)) {
    const profiles = await Item.find({ workspaceId: workspace, itemId: { $in: ids.map((id) => mongoEq(id)) } })
      .select({ itemId: 1, [`data.${PROFILE_NAME}`]: 1 }).lean();
    for (const profile of profiles) if (clean(profile.data?.[PROFILE_NAME])) names.set(profile.itemId, clean(profile.data[PROFILE_NAME]));
  }
  return names;
}

async function boardsByIds(boardIds) {
  const boards = {};
  for (const ids of chunk(boardIds, CHUNK)) {
    for (const board of await Board.find({ boardId: { $in: ids.map((id) => mongoEq(id)) } }).select('boardId label').lean()) {
      boards[board.boardId] = { label: board.label };
    }
  }
  return boards;
}

export async function loadBackfillInputs(workspaceId) {
  const workspace = mongoEq(String(workspaceId));
  const [logDocs, ledgerDocs, markedDocs, existingDocs] = await Promise.all([
    InvoiceNumber.find({ workspaceId: workspace }).lean(),
    PDFLink.find({ workspaceId: workspace, type: { $in: LEDGER_INVOICE_TYPES } }).lean(),
    Item.find({ workspaceId: workspace, invoicedBy: { $type: 'string', $ne: '' } })
      .select(ITEM_FIELDS).lean(),
    Invoice.find({ workspaceId: workspace }).lean(),
  ]);

  const mentioned = [...new Set([...logDocs, ...ledgerDocs].map((row) => row.itemId))];
  const known = new Set(markedDocs.map((item) => item.itemId));
  const others = await itemsByIds(workspace, mentioned.filter((id) => !known.has(id)));
  const everyItem = [...markedDocs, ...others];
  const names = await profileNames(workspace, everyItem);
  const items = everyItem.map((item) => itemOf(item, names));

  const boardIds = [...new Set([...items.map((i) => i.boardId), ...logDocs.map((r) => r.boardId), ...ledgerDocs.map((r) => r.boardId)].filter(Boolean))];
  return {
    workspaceId: String(workspaceId),
    boards: await boardsByIds(boardIds),
    items,
    logRows: logDocs.map(logRowOf),
    ledgerRows: ledgerDocs.map(ledgerRowOf),
    existing: existingDocs.map(existingOf),
  };
}

/** Every workspace that has a log row, an invoice ledger row or a marked item. */
export async function workspacesWithInvoices() {
  const [fromLog, fromLedger, fromMarkers] = await Promise.all([
    InvoiceNumber.distinct('workspaceId'),
    PDFLink.distinct('workspaceId', { type: { $in: LEDGER_INVOICE_TYPES } }),
    Item.distinct('workspaceId', { invoicedBy: { $type: 'string', $ne: '' } }),
  ]);
  return [...new Set([...fromLog, ...fromLedger, ...fromMarkers])];
}
