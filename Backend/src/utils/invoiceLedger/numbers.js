import { INVOICE_SOURCE, LEGACY_SUFFIX } from '../../constants/invoiceLedger.js';
import { PROVISIONAL_CLAIM_PREFIX } from '../../constants/invoiceSelection.js';

/**
 * An invoice number as stored on an item, in the log or on the ledger, split into the
 * plain number, its source and the strings it has been known by (KAN-302).
 *
 * Only a trailing suffix is stripped. A provisional claim token (`pending:...`) is
 * not an invoice number and parses to null, as does anything that is not a
 * non-empty string.
 */
export function parseInvoiceNumber(raw) {
  if (typeof raw !== 'string') return null;
  const stored = raw.trim();
  if (!stored || stored.startsWith(PROVISIONAL_CLAIM_PREFIX)) return null;

  for (const [suffix, source] of [
    [LEGACY_SUFFIX.ISOPLUS, INVOICE_SOURCE.PORTAL],
    [LEGACY_SUFFIX.XERO, INVOICE_SOURCE.XERO],
  ]) {
    if (stored.endsWith(suffix)) {
      return { number: stored.slice(0, -suffix.length).trim(), source, legacyNumbers: [stored] };
    }
  }
  return { number: stored, source: INVOICE_SOURCE.PORTAL, legacyNumbers: [] };
}

/**
 * Every stored form a lookup for this number must match: the plain number and the
 * legacy form its source used. A lookup that starts from either form gets the same list.
 */
export function numberForms(raw) {
  const parsed = parseInvoiceNumber(raw);
  if (!parsed) return [];
  const suffix = parsed.source === INVOICE_SOURCE.XERO ? LEGACY_SUFFIX.XERO : LEGACY_SUFFIX.ISOPLUS;
  return [parsed.number, `${parsed.number}${suffix}`];
}
