/**
 * Which items belong on a scheduled invoice, per invoice type.
 *
 * Section 2.6 of the invoice selection spec: the conditions live in one table
 * rather than a branch per type, so adding a type is adding a row here and not
 * writing new selection logic. `utils/invoiceItemSelection.js` is the only
 * reader.
 *
 * Two fields per type, matched with OR (section 2.1). The names below are the
 * underlying attribute names from section 2.3, not the business-facing labels:
 *
 *   NDIS  "Shift Service Date"     → Scheduled Shift Start Date & Time
 *         "Shift Delivery Date"    → Actual Shift Start Date and Time
 *   SaH   "Scheduled Service Date" → Scheduled Shift Start Date & Time
 *         "Service Delivery Date"  → Actual Shift End Date and Time
 *
 * Only one spelling of each is listed. The reader tries both — see
 * SPELLING_VARIANTS below and section 2.4.
 */

export const INVOICE_TYPE_NDIS_CERTIFICATION = 'ndis-certification';
export const INVOICE_TYPE_NDIS_VERIFICATION = 'ndis-verification';
export const INVOICE_TYPE_SAH = 'sah';
export const INVOICE_TYPE_SAH_LOW_CAT = 'sah-low-cat';
export const INVOICE_TYPE_IMS_JOB_MANAGEMENT = 'ims-job-management';

/**
 * The same field reaches us under two names, and which one a row carries
 * depends on when it was synced. `computeNdisServiceDate` already reads both
 * and falls back between them; selection has to do the same or it silently
 * misses items (section 2.4).
 *
 * Expressed as a substring swap rather than a list of pairs, because the two
 * spellings differ only in this one token and every affected field is a
 * "Date & Time" / "Date and Time".
 */
export const SPELLING_VARIANTS = [
  [' & ', ' and '],
  [' and ', ' & '],
];

const NDIS_STATUSES = ['Completed', 'Cancelled'];

/**
 * The four SaH values. The spec lists the delivered one without a trailing
 * period and the two adjustments with; the code constant
 * TRANSACTION_STATUS_USE_ACTUAL_END carries one. Rather than pick a winner,
 * the reader normalises a trailing period off both sides before comparing.
 */
const SAH_STATUSES = [
  'Cancelled - To be claimed and invoiced if applicable',
  'Delivered - To be claimed and invoiced',
  'Adjustment (Refund) - To be claimed and invoiced.',
  'Adjustment (Charge) - To be claimed and invoiced.',
];

const NDIS_SELECTION = {
  statusField: 'Job Status',
  statuses: NDIS_STATUSES,
  dateFields: [
    'Scheduled Shift Start Date & Time',
    'Actual Shift Start Date and Time',
  ],
};

const SAH_SELECTION = {
  statusField: 'Transaction Status',
  statuses: SAH_STATUSES,
  dateFields: [
    'Scheduled Shift Start Date & Time',
    'Actual Shift End Date and Time',
  ],
};

/**
 * IMS Job Management is the spec's one open item (section 5): its date fields
 * and qualifying statuses have not been supplied. It is present here as an
 * explicit null so that asking for it fails loudly, rather than falling
 * through to a default and billing on conditions nobody agreed to. The spec is
 * explicit that they must not be inferred from the other four.
 */
export const INVOICE_SELECTION_CONFIG = Object.freeze({
  [INVOICE_TYPE_NDIS_CERTIFICATION]: NDIS_SELECTION,
  [INVOICE_TYPE_NDIS_VERIFICATION]: NDIS_SELECTION,
  [INVOICE_TYPE_SAH]: SAH_SELECTION,
  [INVOICE_TYPE_SAH_LOW_CAT]: SAH_SELECTION,
  [INVOICE_TYPE_IMS_JOB_MANAGEMENT]: null,
});
