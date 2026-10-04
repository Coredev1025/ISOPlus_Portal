import { describe, it, expect } from 'vitest';

import { lineAmountsFrom, moneyOf } from '../../../src/utils/invoiceLedger/lineAmounts.js';

/**
 * What each item contributed to an invoice, from the rows the run selected (KAN-305).
 * An item can expand into several rows, so the amounts are summed per item.
 */

describe('moneyOf', () => {
  it.each([
    [12.5, 12.5],
    ['12.50', 12.5],
    ['$1,232.50', 1232.5],
    [' 7 ', 7],
    [undefined, 0],
    [null, 0],
    ['', 0],
    ['n/a', 0],
    [Number.NaN, 0],
  ])('reads %j as %j', (input, expected) => {
    expect(moneyOf(input)).toBe(expected);
  });
});

describe('lineAmountsFrom', () => {
  const rows = [
    { sourceItemId: 'a', totalAmount: 100 },
    { sourceItemId: 'a', totalAmount: '$75.25' },
    { sourceItemId: 'b', totalAmount: 10 },
    { sourceItemId: undefined, totalAmount: 999 },
  ];

  it('sums the rows that came from each item', () => {
    expect(lineAmountsFrom(rows, 'sourceItemId', (r) => r.totalAmount)).toEqual({ a: 175.25, b: 10 });
  });

  it('skips a row with no item id', () => {
    expect(Object.keys(lineAmountsFrom(rows, 'sourceItemId', (r) => r.totalAmount))).toEqual(['a', 'b']);
  });

  it('rounds each total to cents, so floating point does not leak into the invoice', () => {
    const tenths = [0.1, 0.2, 0.3].map((totalAmount) => ({ id: 'x', totalAmount }));
    expect(lineAmountsFrom(tenths, 'id', (r) => r.totalAmount)).toEqual({ x: 0.6 });
  });

  it('uses whatever the caller says an amount is, for the Age Care contribution', () => {
    const careRows = [{ id: 'a', totalAmount: 100, participantContribution: 5 }];
    expect(lineAmountsFrom(careRows, 'id', (r) => r.participantContribution)).toEqual({ a: 5 });
  });

  it('returns an empty object for no rows', () => {
    expect(lineAmountsFrom([], 'id', () => 1)).toEqual({});
  });
});
