import { describe, expect, it } from 'vitest';
import {
  EMPTY_INITIAL_NUMBERS,
  initialNumberErrors,
  withInitialNumbers,
} from '@/lib/financial-settings-numbering-helpers';

const filled = { invoice: '1200', purchaseOrder: '35', quote: '410', statementOfAccount: '8' };

describe('initialNumberErrors', () => {
  it('names every document type that is blank', () => {
    const errors = initialNumberErrors(EMPTY_INITIAL_NUMBERS);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(/^Invoice: enter a starting number/);
    expect(errors[3]).toMatch(/^Statement of Account: /);
  });
  it('accepts whole numbers of 1 or more, with surrounding spaces', () => {
    expect(initialNumberErrors({ ...filled, invoice: ' 1 ' })).toEqual([]);
  });
  it.each(['0', '-1', '1.5', '1e3', 'abc', '', '   '])('rejects %j', (bad) => {
    expect(initialNumberErrors({ ...filled, quote: bad })).toHaveLength(1);
  });
});

describe('withInitialNumbers', () => {
  const seq = (prefix: string) => ({ prefix, nextNumber: 1 });
  const sequences = {
    invoice: seq('INV-'),
    purchaseOrder: seq('PO-'),
    quote: seq('QT-'),
    statementOfAccount: seq('SOA-'),
  };
  it('puts each typed number in, keeps prefixes, and does not mutate', () => {
    const out = withInitialNumbers(sequences, filled);
    expect(out.invoice).toEqual({ prefix: 'INV-', nextNumber: 1200 });
    expect(out.statementOfAccount).toEqual({ prefix: 'SOA-', nextNumber: 8 });
    expect(sequences.invoice.nextNumber).toBe(1);
  });
});
