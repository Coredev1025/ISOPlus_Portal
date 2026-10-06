import { describe, it, expect } from 'vitest';

import {
  buildRunningBalance,
  orderTransactions,
} from '../../../src/utils/statementTransactions.js';

/**
 * Section 4.4 of the invoice selection spec: every row shows the balance after
 * that transaction, starting from the opening balance, and the final running
 * balance must equal the stated closing balance.
 *
 * Ordering is by date with a stable tiebreaker, so the same statement rendered
 * twice is identical.
 */

const charge = (date, amount, extra = {}) => ({
  date, reference: 'INV-1', description: 'Services', charge: amount, payment: 0, ...extra,
});
const payment = (date, amount, extra = {}) => ({
  date, reference: 'PMT-1', description: 'Payment received', charge: 0, payment: amount, ...extra,
});

describe('orderTransactions', () => {
  it('orders by date', () => {
    const rows = orderTransactions([
      charge('2025-03-01', 100),
      charge('2025-01-01', 50),
      charge('2025-02-01', 75),
    ]);
    expect(rows.map((r) => r.date)).toEqual(['2025-01-01', '2025-02-01', '2025-03-01']);
  });

  it('breaks a same-date tie on sequence, so two renders agree', () => {
    const rows = orderTransactions([
      charge('2025-01-01', 100, { sequence: 2 }),
      payment('2025-01-01', 50, { sequence: 1 }),
    ]);
    expect(rows.map((r) => r.sequence)).toEqual([1, 2]);
  });

  it('does not mutate the input', () => {
    const input = [charge('2025-03-01', 100), charge('2025-01-01', 50)];
    orderTransactions(input);
    expect(input[0].date).toBe('2025-03-01');
  });

  it('is stable for rows with neither a distinct date nor a sequence', () => {
    const a = charge('2025-01-01', 10, { reference: 'A' });
    const b = charge('2025-01-01', 20, { reference: 'B' });
    expect(orderTransactions([a, b]).map((r) => r.reference)).toEqual(['A', 'B']);
  });
});

describe('buildRunningBalance', () => {
  it('carries the opening balance into the first row', () => {
    const { rows } = buildRunningBalance(100, [charge('2025-01-01', 50)]);
    expect(rows[0].balance).toBe(150);
  });

  it('subtracts payments and adds charges', () => {
    const { rows, closingBalance } = buildRunningBalance(0, [
      charge('2025-01-01', 820),
      payment('2025-02-01', 820),
      charge('2025-03-01', 970),
    ]);
    expect(rows.map((r) => r.balance)).toEqual([820, 0, 970]);
    expect(closingBalance).toBe(970);
  });

  it('handles a refund, which is a negative charge', () => {
    const { closingBalance } = buildRunningBalance(0, [
      charge('2025-01-01', 932.5),
      charge('2025-01-18', -62.5, { reference: 'CRN-0021' }),
    ]);
    expect(closingBalance).toBe(870);
  });

  it('totals charges and payments for the summary strip', () => {
    const { totalCharges, totalPayments } = buildRunningBalance(284.2, [
      payment('2025-01-01', 284.2),
      charge('2025-02-01', 820),
      payment('2025-03-01', 820),
    ]);
    expect(totalCharges).toBe(820);
    expect(totalPayments).toBe(1104.2);
  });

  it('closes at opening plus charges minus payments', () => {
    const opening = 284.2;
    const { closingBalance, totalCharges, totalPayments } = buildRunningBalance(opening, [
      charge('2025-01-01', 12300.5),
      payment('2025-02-01', 10157.2),
    ]);
    expect(closingBalance).toBe(Number((opening + totalCharges - totalPayments).toFixed(2)));
  });

  it('does not accumulate floating point error across many rows', () => {
    // 0.1 + 0.2 style drift is the classic way a statement ends up a cent out
    // and fails its own reconciliation check.
    const txns = Array.from({ length: 30 }, (_, i) => charge(`2025-01-${String(i + 1).padStart(2, '0')}`, 0.1));
    const { closingBalance } = buildRunningBalance(0, txns);
    expect(closingBalance).toBe(3);
  });

  it('returns an empty result for no transactions, closing at the opening balance', () => {
    const { rows, closingBalance } = buildRunningBalance(50, []);
    expect(rows).toEqual([]);
    expect(closingBalance).toBe(50);
  });

  it('orders before it accumulates, so an out-of-order input still reconciles', () => {
    const { rows } = buildRunningBalance(0, [
      payment('2025-02-01', 100),
      charge('2025-01-01', 100),
    ]);
    expect(rows.map((r) => r.balance)).toEqual([100, 0]);
  });
});
