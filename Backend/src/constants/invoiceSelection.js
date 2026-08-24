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

/**
 * The prefix on the provisional marker an automated run holds while it is
 * producing a document (section 3.4). It is what distinguishes "a run is
 * working on this" from "an invoice was issued for this", and every reader
 * below depends on that distinction rather than on the rest of the token.
 *
 * Read by: utils/automationInvoiceClaim.js (mints the token),
 * utils/staleInvoiceClaims.js (finds tokens no run is still behind),
 * utils/invoicePdfSupport.js (does not report one as a competing invoice).
 */
export const PROVISIONAL_CLAIM_PREFIX = 'pending:';

/**
 * How old a provisional claim has to be before a run is assumed dead.
 *
 * One hour, and the margin is enormous: a single participant's invoice is one
 * render and one upload. The generous side is the safe side — a cutoff shorter
 * than a legitimately slow run turns the alarm into noise, and a noisy alarm is
 * the same as no alarm. Nothing acts on this automatically, so being late costs
 * only lateness.
 *
 * Read by: utils/staleInvoiceClaims.js.
 */
export const STALE_CLAIM_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * How many item ids one stale-claim alarm carries. The rest are counted, not
 * listed: the logger's storage sanitizer drops oversized metadata, so an
 * uncapped list can cost the alarm its whole payload.
 *
 * Read by: utils/staleInvoiceClaims.js.
 */
export const STALE_CLAIM_ID_LOG_LIMIT = 50;

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
