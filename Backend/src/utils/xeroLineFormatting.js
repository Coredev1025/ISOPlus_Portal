/**
 * The pure line-shaping rules a Xero document uses: rounding, the service date
 * a row is dated on, and the description suffix.
 *
 * Extracted from routes/xero.js, which held them as private functions, because
 * the scheduled "Send from Accounting Platform" route needs the same rules and
 * runs inside the BullMQ worker. Importing them from the router would pull an
 * Express router — and its whole model and service graph — into the worker's
 * import graph; copying them is how `appendXeroLineDateSuffix` came to exist in
 * two places already. One module both callers import is the answer to both.
 *
 * Nothing here touches Xero, Mongo or Express.
 */

/**
 * Round half-up at `dp` decimal places, nudging by Number.EPSILON first.
 *
 * The nudge is not decoration: Math.round(1.005 * 100) is 100 in binary
 * floating point, so a line amount ending in a half-cent would round DOWN and
 * the invoice would not add up. Non-numeric input is 0 rather than NaN, because
 * a NaN reaching a Xero line amount is rejected by the API with a message that
 * names nothing useful.
 */
function roundTo(value, dp) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = Math.pow(10, dp);
  return Math.round((num + Number.EPSILON) * factor) / factor;
}

/** Money: line amounts and totals. */
export function xeroRound2(value) {
  return roundTo(value, 2);
}

/** Unit price, which Xero carries to four places. */
export function xeroRound4(value) {
  return roundTo(value, 4);
}

function escapeRegExpLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The date a service row is invoiced under.
 *
 * A delivered row is dated on the day it was actually delivered; anything else
 * on the day it was scheduled. Each falls back to the other, because a row
 * carrying only one of the two dates still has to be dated.
 */
export function xeroServiceRowDate(item) {
  const status = (item?.transactionStatus ?? '').toString().trim();
  const scheduled = (item?.scheduledServiceDate ?? '').toString().trim();
  const delivered = (item?.serviceDeliveryDate ?? '').toString().trim();

  const isDelivered =
    status === 'Delivered - To be claimed and invoiced.'
    || status.toLowerCase().startsWith('delivered');

  const preferred = isDelivered ? delivered : scheduled;
  const fallback = isDelivered ? scheduled : delivered;
  return preferred || fallback || '';
}

/**
 * The Xero line description rule: "<service> - <dd/mm/yyyy>".
 *
 * Idempotent, because a replayed push must not produce
 * "Service - 01/02/2025 - 01/02/2025".
 */
export function appendXeroLineDateSuffix(description, rowDate) {
  const base = (description ?? '').toString().trim() || 'Service';
  const date = (rowDate ?? '').toString().trim();
  if (!date) return base;

  const alreadySuffixed = new RegExp(`\\s*-\\s*${escapeRegExpLiteral(date)}\\s*$`).test(base);
  return alreadySuffixed ? base : `${base} - ${date}`;
}
