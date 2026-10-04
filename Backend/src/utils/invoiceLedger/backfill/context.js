import { INVOICE_KIND, INVOICE_SOURCE, LEDGER_INVOICE_TYPES } from '../../../constants/invoiceLedger.js';
import { PROVISIONAL_CLAIM_PREFIX } from '../../../constants/invoiceSelection.js';
import { isCareManagementLabel, isLowCatCareManagementLabel, isNdisBoardLabel } from '../../automationBoardFlags.js';
import { parseInvoiceNumber } from '../numbers.js';

/**
 * Shared lookups for the backfill planner (KAN-310): the inputs indexed once, and the small
 * pure helpers every rule uses. Pure.
 */

export const isPending = (marker) => typeof marker === 'string' && marker.startsWith(PROVISIONAL_CLAIM_PREFIX);

/** `{ number, source, legacyNumbers }` for a stored number, or null for anything that is not one. */
export const parsed = (raw) => parseInvoiceNumber(raw);

/** The key an invoice is known by: its source and plain number. */
export const numberKey = (source, number) => `${source}|${number}`;

/** A name as printed: trimmed, runs of spaces collapsed. */
export const cleanName = (name) => String(name ?? '').trim().replace(/\s+/g, ' ');

/** The name as compared: so "Jane  Smith " and "jane smith" are one participant. */
export const participantKey = (name) => cleanName(name).toLowerCase();

/** Deleted documents suppress a number on one board, not everywhere. */
export const suppressKey = (boardId, source, number) => `${boardId}|${source}|${number}`;

export const validDate = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at;
};

export const earliest = (dates) => dates.map(validDate).filter(Boolean).sort((a, b) => a - b)[0];

/** A total a ledger row really carries: a finite number, not blank, not absent. */
export const printedTotal = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/** The kind and Low Cat flag a board's label gives, or null when the board is neither NDIS nor Age Care. */
export function kindOfBoard(board) {
  const label = board?.label;
  if (isNdisBoardLabel(label)) return { kind: INVOICE_KIND.NDIS, lowCat: undefined };
  if (isCareManagementLabel(label)) return { kind: INVOICE_KIND.AGE_CARE, lowCat: isLowCatCareManagementLabel(label) };
  return null;
}

const push = (map, key, value) => map.set(key, [...(map.get(key) || []), value]);

/** The log rows split by type and indexed by item and by document link. */
function indexLog(logRows) {
  const pdfByItem = new Map();
  const xeroByItem = new Map();
  const pdfByLink = new Map();
  for (const row of logRows) {
    if (row.type === 'Xero') push(xeroByItem, row.itemId, row);
    else {
      push(pdfByItem, row.itemId, row);
      if (row.pdfLink) push(pdfByLink, row.pdfLink, row);
    }
  }
  return { pdfByItem, xeroByItem, pdfByLink };
}

/** The inputs indexed for the rules. */
export function buildContext(inputs) {
  const logRows = inputs.logRows || [];
  const log = indexLog(logRows);
  return {
    workspaceId: inputs.workspaceId,
    boards: inputs.boards || {},
    items: inputs.items || [],
    itemsById: new Map((inputs.items || []).map((item) => [item.itemId, item])),
    logRows,
    logPdfByItem: log.pdfByItem,
    logXeroByItem: log.xeroByItem,
    logPdfByLink: log.pdfByLink,
    ledgerInvoiceRows: (inputs.ledgerRows || []).filter((row) => LEDGER_INVOICE_TYPES.includes(row.type)),
    existing: inputs.existing || [],
    suppressed: new Set(),
  };
}

export const SOURCE = INVOICE_SOURCE;
