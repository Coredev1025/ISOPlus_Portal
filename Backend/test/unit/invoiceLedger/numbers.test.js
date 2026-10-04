import { describe, it, expect } from 'vitest';

import { parseInvoiceNumber, numberForms } from '../../../src/utils/invoiceLedger/numbers.js';

/**
 * Turning a stored invoice number into the plain number, its source and the strings
 * it has been known by (KAN-302). The legacy forms are `INV-24 (ISO+™)` (written by
 * code before KAN-294) and `INV-0001 (Xero)` (the marker the Xero routes write).
 */

describe('parseInvoiceNumber', () => {
  it('leaves a plain number plain, from the portal', () => {
    expect(parseInvoiceNumber('INV-24')).toEqual({
      number: 'INV-24', source: 'portal', legacyNumbers: [],
    });
  });

  it('strips the ISO+ suffix and remembers the original', () => {
    expect(parseInvoiceNumber('INV-24 (ISO+™)')).toEqual({
      number: 'INV-24', source: 'portal', legacyNumbers: ['INV-24 (ISO+™)'],
    });
  });

  it('strips the Xero suffix, marks the source xero and remembers the original', () => {
    expect(parseInvoiceNumber('INV-0001 (Xero)')).toEqual({
      number: 'INV-0001', source: 'xero', legacyNumbers: ['INV-0001 (Xero)'],
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseInvoiceNumber('  INV-24  ').number).toBe('INV-24');
  });

  it('strips only a trailing suffix, not one in the middle', () => {
    expect(parseInvoiceNumber('INV (ISO+™) 7').number).toBe('INV (ISO+™) 7');
  });

  it('keeps a number with spaces and punctuation as it is', () => {
    expect(parseInvoiceNumber('INV 504/A')).toEqual({
      number: 'INV 504/A', source: 'portal', legacyNumbers: [],
    });
  });

  it.each([undefined, null, '', '   ', 42, {}])('returns null for %j', (value) => {
    expect(parseInvoiceNumber(value)).toBeNull();
  });

  it('returns null for a provisional claim token, which is not an invoice number', () => {
    expect(parseInvoiceNumber('pending:ndis:20260101-0900:Jane')).toBeNull();
  });
});

describe('numberForms', () => {
  it('lists the plain number and every stored form a lookup must match', () => {
    expect(numberForms('INV-24').sort()).toEqual(['INV-24', 'INV-24 (ISO+™)']);
  });

  it('is the same list whichever form it starts from', () => {
    expect(numberForms('INV-24 (ISO+™)').sort()).toEqual(['INV-24', 'INV-24 (ISO+™)']);
  });

  it('does not add a Xero form to a portal number, and gives a Xero number its own form', () => {
    expect(numberForms('INV-0001 (Xero)').sort()).toEqual(['INV-0001', 'INV-0001 (Xero)']);
  });

  it('returns an empty list for something that is not a number', () => {
    expect(numberForms(null)).toEqual([]);
  });
});
