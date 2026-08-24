/**
 * Which set of selection conditions a board's items are billed under.
 *
 * The five board labels are the five invoice types of section 2.2 of the
 * invoice selection spec, so the board label is what looks up the right row of
 * INVOICE_SELECTION_CONFIG.
 *
 * Kept separate from utils/automationBoardFlags.js, which answers a different
 * question: those predicates decide which *generator* runs (NDIS template
 * versus Age Care participant tax, different pricing, different GST). This
 * decides which *conditions* select the items. Two boards can share a
 * generator and differ here, which is why they are not one function.
 */

import {
  INVOICE_TYPE_IMS_JOB_MANAGEMENT,
  INVOICE_TYPE_NDIS_CERTIFICATION,
  INVOICE_TYPE_NDIS_VERIFICATION,
  INVOICE_TYPE_SAH,
  INVOICE_TYPE_SAH_LOW_CAT,
} from '../constants/invoiceSelection.js';

/**
 * Ordered, and the order is load-bearing: 'Care Management - SaH - Low Cat'
 * contains 'sah', so a plain SaH test placed first would claim it and bill Low
 * Cat under the wrong row. Most specific first.
 */
const LABEL_MATCHERS = [
  [(l) => l.includes('ndis') && l.includes('certification'), INVOICE_TYPE_NDIS_CERTIFICATION],
  [(l) => l.includes('ndis') && l.includes('verification'), INVOICE_TYPE_NDIS_VERIFICATION],
  [(l) => l.includes('sah') && l.includes('low cat'), INVOICE_TYPE_SAH_LOW_CAT],
  [(l) => l.includes('sah'), INVOICE_TYPE_SAH],
  [(l) => l.includes('ims') && l.includes('job management'), INVOICE_TYPE_IMS_JOB_MANAGEMENT],
];

/**
 * The invoice type for `label`, or null when the board is not one of the five.
 *
 * Null rather than a default. An unrecognised board must not fall through to
 * another type's conditions — that is the same fail-closed reasoning
 * generateInvoicesForBoard already applies when a renamed or unlabelled board
 * would otherwise drop into Age Care generation.
 */
export function invoiceTypeFromBoardLabel(label) {
  if (typeof label !== 'string') return null;
  const normalized = label.trim().toLowerCase();
  if (!normalized) return null;
  const matched = LABEL_MATCHERS.find(([test]) => test(normalized));
  return matched ? matched[1] : null;
}
