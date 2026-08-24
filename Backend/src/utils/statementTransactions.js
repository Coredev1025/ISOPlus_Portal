/**
 * The statement's transaction list and its running balance.
 *
 * Section 4.4 of the invoice selection spec: each row shows the balance after
 * that transaction, starting from the opening balance, and the final running
 * balance must equal the stated closing balance.
 *
 * A statement raises no new charges. Every figure here traces back to an
 * invoice or a payment already recorded — this module only orders them and
 * accumulates.
 */

/**
 * Money, to the cent.
 *
 * Balances are accumulated in cents and converted back once, rather than added
 * as floats. Thirty rows of 0.10 sum to 2.9999999999999996 in floating point,
 * which then fails the statement's own reconciliation check by a fraction of a
 * cent — a real failure mode, and one that only shows up on long statements.
 */
export function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

const toCents = (value) => Math.round(Number(value || 0) * 100);

/**
 * Date first, then an explicit sequence, then original position.
 *
 * The sequence is the creation order the spec asks for as a tiebreaker: two
 * transactions on the same day must not swap between renders, or the same
 * statement produced twice would differ. `Array.prototype.sort` is stable in
 * V8, so rows with neither a distinct date nor a sequence keep their input
 * order.
 */
export function orderTransactions(transactions) {
  return [...transactions].sort((a, b) => {
    const byDate = new Date(a.date).getTime() - new Date(b.date).getTime();
    if (byDate !== 0) return byDate;
    return Number(a.sequence ?? 0) - Number(b.sequence ?? 0);
  });
}

/**
 * The transaction rows with a balance on each, and the totals the summary
 * strip needs.
 *
 * Charges add and payments subtract. A refund is a negative charge rather than
 * a payment, which is how the sample statement shows it: an "Adjustment
 * (Refund)" row reduces the charges column, it does not appear as money
 * received.
 */
export function buildRunningBalance(openingBalance, transactions) {
  const ordered = orderTransactions(transactions || []);

  let balanceCents = toCents(openingBalance);
  let chargeCents = 0;
  let paymentCents = 0;

  const rows = ordered.map((txn) => {
    const charge = toCents(txn.charge);
    const payment = toCents(txn.payment);
    chargeCents += charge;
    paymentCents += payment;
    balanceCents += charge - payment;
    return { ...txn, balance: balanceCents / 100 };
  });

  return {
    rows,
    closingBalance: balanceCents / 100,
    totalCharges: chargeCents / 100,
    totalPayments: paymentCents / 100,
    openingBalance: roundMoney(openingBalance),
  };
}

/**
 * The check section 4.4 asks for: the last row's balance must equal the stated
 * closing balance.
 *
 * Throws rather than rendering. A statement whose rows do not arrive at the
 * total printed on it is worse than no statement — the participant cannot tell
 * which number is wrong, and neither can whoever answers the phone.
 */
export function assertRunningBalanceReconciles(rows, closingBalance) {
  if (rows.length === 0) return;
  const final = roundMoney(rows[rows.length - 1].balance);
  const stated = roundMoney(closingBalance);
  // Whole cents, for the same floating-point reason as assertAgeingReconciles.
  if (Math.abs(Math.round(final * 100) - Math.round(stated * 100)) >= 1) {
    throw new Error(
      `statement: running balance does not reconcile — rows end at ${final}, `
      + `closing balance stated as ${stated}`,
    );
  }
}
