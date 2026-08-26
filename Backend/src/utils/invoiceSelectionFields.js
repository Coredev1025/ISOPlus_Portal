/**
 * Reading the fields selection depends on, tolerantly.
 *
 * Two hazards, both from section 2 of the invoice selection spec:
 *
 *   2.4 — the same field arrives under two spellings ("Date & Time" and
 *         "Date and Time"), and which one a row carries depends on when it
 *         was synced. Reading one spelling silently misses items.
 *   2.5 — dates are ISO 8601 *strings* with an explicit offset, not BSON
 *         dates, and the offset moves with daylight saving. String comparison
 *         is not safe across a DST boundary, so everything is parsed to an
 *         instant before it is compared.
 *
 * Pure functions only — no I/O, no model imports — so the selection rule can
 * be tested without a database.
 */

import { formatLabelValue } from './ndisServiceRecords.js';
import { SPELLING_VARIANTS, STATUS_FIELD_ALIASES } from '../constants/invoiceSelection.js';

/**
 * Every spelling of `fieldName` worth trying, most likely first.
 *
 * Returns the name itself plus whichever variant a substring swap produces.
 * A field containing neither token yields just itself.
 */
export function spellingVariants(fieldName) {
  const names = [fieldName];
  for (const [from, to] of SPELLING_VARIANTS) {
    if (fieldName.includes(from)) {
      const swapped = fieldName.split(from).join(to);
      if (!names.includes(swapped)) names.push(swapped);
    }
  }
  return names;
}

/**
 * The first non-empty value held under any spelling of `fieldName`.
 *
 * Empty string rather than null for a miss, so callers can treat "absent" and
 * "present but blank" the same way — which is what the fallback in section 2.3
 * does.
 */
export function readField(item, fieldName) {
  const data = item?.data;
  if (!data) return '';
  for (const name of spellingVariants(fieldName)) {
    const raw = data[name];
    if (raw === undefined || raw === null) continue;
    const value = formatLabelValue(raw).trim();
    if (value) return value;
  }
  return '';
}

/**
 * The status value, under whichever column this board calls it.
 *
 * A plain readField only tries the spec's own name and its ' & '/' and '
 * variants, which is the wrong axis: the boards differ on "Job Status" vs
 * "Shift Status", not on ampersands. Falls back to readField for a field with
 * no aliases, so nothing else changes.
 */
export function readStatusField(item, fieldName) {
  const aliases = STATUS_FIELD_ALIASES[fieldName];
  if (!aliases) return readField(item, fieldName);
  for (const name of aliases) {
    const value = readField(item, name);
    if (value) return value;
  }
  return '';
}

/**
 * An ISO 8601 string with an offset, as an instant.
 *
 * `null` for anything that does not parse, including the empty string —
 * `new Date('')` is Invalid Date but `new Date(0)` is the epoch, and an item
 * with a blank date must not select as though it happened in 1970.
 *
 * The six-digit fractional seconds these values carry
 * ('2025-01-07T11:00:00.000000+11:00') are more than ES requires, but V8
 * accepts them; the assertion lives in the unit tests.
 */
export function parseInstant(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Trailing-period-insensitive status comparison.
 *
 * 'Delivered - To be claimed and invoiced' and
 * 'Delivered - To be claimed and invoiced.' are the same status; the spec
 * writes it one way and the TRANSACTION_STATUS_USE_ACTUAL_END constant the
 * other. Case is normalised too, for the same reason the spellings are.
 */
export function normalizeStatus(value) {
  return formatLabelValue(value).trim().replace(/\.+$/, '').toLowerCase();
}

/**
 * Does any spelling of any of `dateFields` put this item inside the period?
 *
 * This is the OR of section 2.1. Bounds are inclusive at both ends: the period
 * end that `schedulePeriodServiceDeliveryWindow` produces is already the last
 * millisecond of the final day, not the first of the next.
 */
export function hasDateInPeriod(item, dateFields, period) {
  const start = parseInstant(period?.start);
  const end = parseInstant(period?.end);
  if (!start || !end) return false;
  return dateFields.some((fieldName) => {
    const at = parseInstant(readField(item, fieldName));
    return Boolean(at) && at >= start && at <= end;
  });
}
