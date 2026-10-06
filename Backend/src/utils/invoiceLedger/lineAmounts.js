/**
 * What each item contributed to an invoice, summed from the rows a scheduled run
 * selected (KAN-305). An item can expand into several rows, so the amounts are
 * summed per item and rounded to cents. Pure.
 */

/**
 * A dollar amount that may arrive as a number or as a formatted string. The list rows are
 * numeric today; a formatted string is read here but the generators would read it as 0.
 */
export function moneyOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

const cents = (amount) => Math.round(amount * 100) / 100;

/**
 * `rows` are the selected rows, `idKey` names the item id on a row, `amountOf(row)` is
 * what the row billed (the full amount for NDIS and Low Cat, the participant
 * contribution for other Age Care boards).
 */
export function lineAmountsFrom(rows, idKey, amountOf) {
  const totals = {};
  for (const row of rows) {
    const id = row[idKey];
    if (!id) continue;
    totals[id] = (totals[id] || 0) + moneyOf(amountOf(row));
  }
  return Object.fromEntries(Object.entries(totals).map(([id, amount]) => [id, cents(amount)]));
}
