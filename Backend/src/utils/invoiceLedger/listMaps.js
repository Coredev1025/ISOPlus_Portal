import { chunk } from 'lodash-es';

import Item from '../../models/Item.js';
import { LIST_SHADOW_CLASS, READ_MODE } from '../../constants/invoiceLedger.js';
import { PROVISIONAL_CLAIM_PREFIX } from '../../constants/invoiceSelection.js';
import { info, warn } from '../logger.js';
import { mongoEq } from '../securityHelpers.js';
import { invoiceLedgerReadMode } from './flags.js';
import { parseInvoiceNumber } from './numbers.js';
import { activeForItems } from './read.js';

/**
 * What the Invoice Generator lists (NDIS and Age Care) take as "invoiced", the invoice number
 * and the document link, per item (KAN-313). Both builders ask for two maps:
 * `invoiceNumberMap` (item to number) and `invoiceFileUrlMap` (item to link or null). Behind
 * `INVOICE_LEDGER_READ`: `off` the old log (type PDF) exactly as before; `shadow` the old maps
 * with every differing item logged with a class; `on` the invoice record, where an item on any
 * issued invoice (a Xero-only one included) is invoiced, and an item carrying a real marker with
 * no record counts too, so an invoice the backfill could not place still reads as billed.
 */

const CHUNK = 500;
const asStored = (invoice) => invoice.legacyNumbers?.[0] ?? invoice.number;

async function legacyMaps({
  workspaceId, boardId, itemIds, InvoiceNumber, allTypes,
}) {
  // The Age Care CSV export has always read rows of every type; the lists read PDF rows.
  const rows = await InvoiceNumber.find({
    workspaceId, boardId, itemId: { $in: itemIds }, ...(allTypes ? {} : { type: 'PDF' }),
  }).lean();
  return {
    invoiceNumberMap: new Map(rows.map((row) => [row.itemId, row.invoiceNumber])),
    invoiceFileUrlMap: new Map(rows.map((row) => [row.itemId, row.pdfLink || null])),
  };
}

/** Items carrying a real marker (not a pending claim), as number text. */
async function markers(workspaceId, boardId, itemIds) {
  const found = new Map();
  for (const ids of chunk(itemIds, CHUNK)) {
    const rows = await Item.find({
      workspaceId: mongoEq(String(workspaceId)),
      boardId: mongoEq(String(boardId)),
      itemId: { $in: ids.map((id) => mongoEq(String(id))) },
      invoicedBy: { $type: 'string', $ne: '' },
    }).select('itemId invoicedBy').lean();
    rows.filter((row) => !row.invoicedBy.startsWith(PROVISIONAL_CLAIM_PREFIX)).forEach((row) => found.set(row.itemId, row.invoicedBy));
  }
  return found;
}

/**
 * The invoice record's maps. An item on no record and carrying no marker still reads as
 * invoiced when the old log has a PDF row for it: scheduled selection drops the log filter only
 * in 4c, after the markers are written, so until then that row is the guard still standing
 * (`saveInvoiceNumber` says so when its claim fails). `withLog` is false only for the shadow
 * comparison, which wants the record's own answer.
 */
async function ledgerMaps({
  workspaceId, boardId, itemIds, InvoiceNumber, allTypes, withLog = true,
}) {
  const [active, marked] = await Promise.all([activeForItems(workspaceId, itemIds), markers(workspaceId, boardId, itemIds)]);
  const invoiceNumberMap = new Map();
  const invoiceFileUrlMap = new Map();
  for (const itemId of itemIds) {
    const invoice = active.get(itemId);
    if (invoice) {
      invoiceNumberMap.set(itemId, asStored(invoice));
      invoiceFileUrlMap.set(itemId, invoice.pdf?.pdfLink || null);
    } else if (marked.has(itemId)) {
      invoiceNumberMap.set(itemId, marked.get(itemId));
      invoiceFileUrlMap.set(itemId, null);
    }
  }
  if (!withLog) return { invoiceNumberMap, invoiceFileUrlMap };

  const missing = itemIds.filter((id) => !invoiceNumberMap.has(id));
  if (missing.length === 0) return { invoiceNumberMap, invoiceFileUrlMap };
  const fromLog = await legacyMaps({
    workspaceId, boardId, itemIds: missing, InvoiceNumber, allTypes,
  });
  for (const [itemId, number] of fromLog.invoiceNumberMap) {
    if (!number) continue;
    invoiceNumberMap.set(itemId, number);
    invoiceFileUrlMap.set(itemId, fromLog.invoiceFileUrlMap.get(itemId) ?? null);
  }
  return { invoiceNumberMap, invoiceFileUrlMap };
}

const plain = (number) => parseInvoiceNumber(number)?.number ?? number;

/** The class of an item's difference between the old maps and the record's, or null when they agree. */
export function listDifference(itemId, legacy, ledger) {
  // An empty number means "not invoiced" to every consumer, so it is the same as none.
  const old = legacy.invoiceNumberMap.get(itemId) || undefined;
  const neu = ledger.invoiceNumberMap.get(itemId) || undefined;
  if (old === undefined && neu === undefined) return null;
  if (old === undefined) return LIST_SHADOW_CLASS.LEDGER_ONLY;
  if (neu === undefined) return LIST_SHADOW_CLASS.LEGACY_ONLY;
  if (plain(old) !== plain(neu)) return LIST_SHADOW_CLASS.NUMBER_DIFFERS;
  const oldLink = legacy.invoiceFileUrlMap.get(itemId) ?? null;
  const newLink = ledger.invoiceFileUrlMap.get(itemId) ?? null;
  return oldLink !== null && newLink !== null && oldLink !== newLink ? LIST_SHADOW_CLASS.LINK_DIFFERS : null;
}

const SAMPLE = 20;

/** Group the differing items by class: `{ class: [itemId, ...] }`. */
function differencesByClass(legacy, ledger, itemIds) {
  const byClass = new Map();
  for (const itemId of itemIds) {
    const cls = listDifference(itemId, legacy, ledger);
    if (cls) byClass.set(cls, [...(byClass.get(cls) || []), itemId]);
  }
  return byClass;
}

/**
 * Shadow: build the record's maps and log the differences, one line per class per call with a
 * count and a few examples (an Invoice Generator load or an export covers thousands of items; a
 * line each would flood the log on every request). The record's own answer is compared, without
 * the log fallback that `on` adds.
 */
async function shadow(legacy, args) {
  try {
    const ledger = await ledgerMaps({ ...args, withLog: false });
    for (const [cls, ids] of differencesByClass(legacy, ledger, args.itemIds)) {
      const log = cls === LIST_SHADOW_CLASS.LEDGER_ONLY ? info : warn;
      log('InvoiceLedger', 'Shadow difference', {
        class: cls, workspaceId: args.workspaceId, boardId: args.boardId, count: ids.length, sampleItemIds: ids.slice(0, SAMPLE),
      });
    }
  } catch (err) {
    warn('InvoiceLedger', 'Invoice list could not be compared with the invoice record', { workspaceId: args.workspaceId, message: err.message });
  }
}

export async function loadInvoiceMaps({
  workspaceId, boardId, itemIds, InvoiceNumber, allTypes = false,
}) {
  const args = {
    workspaceId, boardId, itemIds, InvoiceNumber, allTypes,
  };
  if (itemIds.length === 0) return { invoiceNumberMap: new Map(), invoiceFileUrlMap: new Map() };
  const mode = invoiceLedgerReadMode();
  if (mode === READ_MODE.ON) return ledgerMaps(args);
  const legacy = await legacyMaps(args);
  if (mode === READ_MODE.SHADOW) await shadow(legacy, args);
  return legacy;
}
