/**
 * Which items belong on this run's invoice.
 *
 * Section 2.1 of the invoice selection spec: an item qualifies when EITHER of
 * its two date fields falls inside the period AND its status is one of the
 * type's qualifying values. Date is an OR across two fields; status is a
 * membership test; both must pass.
 *
 * The conditions themselves are data, in constants/invoiceSelection.js. This
 * file holds the rule that reads them, and nothing type-specific — adding an
 * invoice type must not mean editing this file.
 */

import {
  INVOICE_SELECTION_CONFIG,
  INVOICE_TYPE_IMS_JOB_MANAGEMENT,
} from '../constants/invoiceSelection.js';
import {
  hasDateInPeriod,
  normalizeStatus,
  readStatusField,
} from './invoiceSelectionFields.js';

/**
 * The configuration for `invoiceType`, or a throw.
 *
 * Both failure modes throw rather than returning an empty selection. A run
 * that selects nothing looks exactly like a period with no billable work
 * (section 3.5 says produce no invoice and no email for that), so a
 * misconfigured type would bill nothing and report success indefinitely. A
 * throw fails the job visibly and leaves the slot unbilled, which is
 * recoverable.
 */
export function selectionConfigFor(invoiceType) {
  if (!Object.hasOwn(INVOICE_SELECTION_CONFIG, invoiceType)) {
    throw new Error(`invoice selection: unknown invoice type '${invoiceType}'`);
  }
  const config = INVOICE_SELECTION_CONFIG[invoiceType];
  if (!config) {
    if (invoiceType === INVOICE_TYPE_IMS_JOB_MANAGEMENT) {
      throw new Error(
        'invoice selection: IMS Job Management has no date fields or qualifying '
        + 'statuses defined yet, and they must not be inferred from the other types',
      );
    }
    throw new Error(`invoice selection: invoice type '${invoiceType}' is not configured`);
  }
  return config;
}

/**
 * Has this item already been claimed by an invoice?
 *
 * The marker is a top-level field on Item, deliberately outside `data`: sync
 * replaces `data` wholesale on every run (`$set: { data: transformedData }` in
 * syncWorkerBacklogHelpers), so a marker stored inside it would be erased by
 * the next sync and the item billed again.
 */
export function isAlreadyInvoiced(item) {
  return Boolean(item?.invoicedBy);
}

/**
 * Does this item belong on an invoice for `period`?
 *
 * Deliberately ignores the invoiced marker: this is the date-and-status rule
 * on its own, which is what makes it testable against the spec's table.
 * `selectInvoiceableItems` applies the marker on top.
 */
export function isItemInvoiceable(item, invoiceType, period) {
  const { statusField, statuses, dateFields } = selectionConfigFor(invoiceType);
  const status = normalizeStatus(readStatusField(item, statusField));
  if (!status) return false;
  const qualifies = statuses.some((candidate) => normalizeStatus(candidate) === status);
  if (!qualifies) return false;
  return hasDateInPeriod(item, dateFields, period);
}

/**
 * The items to bill for one type, participant and period.
 *
 * Returns a new array; the input is never mutated. The already-invoiced filter
 * is what stops an overlapping period, a changed cadence or a re-run after
 * failure from billing the same item twice (section 3).
 */
export function selectInvoiceableItems(items, invoiceType, period) {
  // An empty list is a period with nothing in it, not a configuration problem,
  // so it returns empty without validating the type. A list with items in it
  // resolves the config on the first call and throws there if the type is
  // unknown or unconfigured.
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.filter(
    (item) => !isAlreadyInvoiced(item) && isItemInvoiceable(item, invoiceType, period),
  );
}
