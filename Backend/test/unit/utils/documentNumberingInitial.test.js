import { describe, it, expect } from 'vitest';
import {
  hasAllInitialNumbers,
  initialNumberSetPaths,
  initialNumberingForNewBusiness,
  isDocumentNumberingInitialized,
  uninitializedFilter,
  wantsInitialNumbers,
} from '../../../src/utils/documentNumberingInitial.js';

const all = (n) => ({
  invoice: { nextNumber: n },
  purchaseOrder: { nextNumber: n },
  quote: { nextNumber: n },
  statementOfAccount: { nextNumber: n },
});

describe('isDocumentNumberingInitialized', () => {
  it('is false for no business, a fresh one, and one with no numbering at all', () => {
    expect(isDocumentNumberingInitialized(null)).toBe(false);
    expect(isDocumentNumberingInitialized({ documentNumbering: all(1) })).toBe(false);
    expect(isDocumentNumberingInitialized({})).toBe(false);
  });
  it('is true when the flag is set', () => {
    expect(isDocumentNumberingInitialized({ documentNumberingInitialized: true, documentNumbering: all(1) })).toBe(true);
  });
  it('is true when any counter has moved off 1, without the flag', () => {
    expect(isDocumentNumberingInitialized({ documentNumbering: { ...all(1), quote: { nextNumber: 2 } } })).toBe(true);
  });
  it('ignores the statement series', () => {
    expect(isDocumentNumberingInitialized({ documentNumbering: { ...all(1), statement: { nextNumber: 9 } } })).toBe(false);
  });
});

describe('wantsInitialNumbers', () => {
  it('reads the multipart string and a boolean, nothing else', () => {
    expect(wantsInitialNumbers({ initializeDocumentNumbering: 'true' })).toBe(true);
    expect(wantsInitialNumbers({ initializeDocumentNumbering: true })).toBe(true);
    expect(wantsInitialNumbers({ initializeDocumentNumbering: 'false' })).toBe(false);
    expect(wantsInitialNumbers({})).toBe(false);
    expect(wantsInitialNumbers(undefined)).toBe(false);
  });
});

describe('hasAllInitialNumbers', () => {
  it('needs a whole number of 1 or more for every series', () => {
    expect(hasAllInitialNumbers(all(1))).toBe(true);
    expect(hasAllInitialNumbers(all(0))).toBe(false);
    expect(hasAllInitialNumbers(all(1.5))).toBe(false);
    expect(hasAllInitialNumbers(all('7'))).toBe(false);
    expect(hasAllInitialNumbers({ ...all(1), quote: undefined })).toBe(false);
    expect(hasAllInitialNumbers(undefined)).toBe(false);
  });
});

describe('write builders', () => {
  it('sets each number and the flag, and not the statement series', () => {
    expect(initialNumberSetPaths(all(5))).toEqual({
      documentNumberingInitialized: true,
      'documentNumbering.invoice.nextNumber': 5,
      'documentNumbering.purchaseOrder.nextNumber': 5,
      'documentNumbering.quote.nextNumber': 5,
      'documentNumbering.statementOfAccount.nextNumber': 5,
    });
  });
  it('merges numbers into prefixes for a new business without mutating them', () => {
    const prefixes = { invoice: { prefix: 'TAX-' } };
    const merged = initialNumberingForNewBusiness(prefixes, all(9));
    expect(merged.invoice).toEqual({ prefix: 'TAX-', nextNumber: 9 });
    expect(merged.quote).toEqual({ nextNumber: 9 });
    expect(prefixes).toEqual({ invoice: { prefix: 'TAX-' } });
  });
  it('filters on the flag being unset and every counter stored and still at 1', () => {
    const filter = uninitializedFilter('abc');
    expect(filter.documentNumberingInitialized).toEqual({ $ne: true });
    // Equality on 1 does not match a missing field, so a business whose backfill
    // has not run is refused rather than written over.
    expect(filter['documentNumbering.invoice.nextNumber']).toBe(1);
    expect(filter['documentNumbering.statement.nextNumber']).toBeUndefined();
  });
});
