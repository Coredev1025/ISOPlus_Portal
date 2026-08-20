/**
 * The period a generated document covers, as a filename fragment.
 *
 * Two invoices for the same participant on the same board differ only by the
 * period they bill, and the filename did not say which — so a folder of them
 * could only be told apart by opening each one:
 *
 *   INV-1006-ISO+™-Mike_Bird.pdf
 *   INV-1006-ISO+™-Mike_Bird_2026-08-01_to_2026-08-31.pdf   <- with this
 *
 * Empty for a document with no period. Manual generation has none, so its
 * filenames are unchanged by this — which matters, because those keys are
 * already stored on existing PDFLink rows.
 */

import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';

/**
 * The calendar day `value` falls on in `timezone`, as YYYY-MM-DD.
 *
 * 'en-CA' renders that shape directly — the same trick wallYmdKey uses in
 * utils/automationScheduleWindow.js. Resolving in the business timezone rather
 * than UTC is what stops an Australian period being named a day early at both
 * ends: a window that starts at 2026-07-31T14:00Z is 1 August in Sydney, and
 * the filename is what a person reconciles against.
 */
function wallDay(value, timezone) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(parsed);
}

/**
 * `_YYYY-MM-DD_to_YYYY-MM-DD`, or '' when there is no usable period.
 *
 * Both bounds are required. Half a range in a filename is worse than none —
 * it reads as a complete one and names the wrong window.
 *
 * @param {{start?: string|Date, end?: string|Date}|null|undefined} period
 * @param {string} timezone
 */
export function invoicePeriodSuffix(period, timezone = DEFAULT_TIMEZONE) {
  if (!period?.start || !period?.end) return '';
  const from = wallDay(period.start, timezone);
  const to = wallDay(period.end, timezone);
  if (!from || !to) return '';
  return `_${from}_to_${to}`;
}
