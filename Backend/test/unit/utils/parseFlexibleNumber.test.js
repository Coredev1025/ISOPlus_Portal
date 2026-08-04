import { describe, it, expect } from 'vitest';
import { parseFlexibleNumber } from '../../../src/utils/parseFlexibleNumber.js';

describe('parseFlexibleNumber', () => {
  it('returns 0 for nullish values', () => {
    expect(parseFlexibleNumber(null)).toBe(0);
    expect(parseFlexibleNumber(undefined)).toBe(0);
  });

  it('returns 0 for non-numeric, non-string types', () => {
    expect(parseFlexibleNumber({})).toBe(0);
    expect(parseFlexibleNumber(true)).toBe(0);
  });

  it('returns 0 for NaN / Infinity', () => {
    expect(parseFlexibleNumber(NaN)).toBe(0);
    expect(parseFlexibleNumber(Infinity)).toBe(0);
    expect(parseFlexibleNumber(-Infinity)).toBe(0);
  });

  it('returns a finite number unchanged', () => {
    expect(parseFlexibleNumber(42.5)).toBe(42.5);
    expect(parseFlexibleNumber(-7)).toBe(-7);
  });

  it('recurses into the first array element', () => {
    expect(parseFlexibleNumber(['123.5', 'garbage'])).toBe(123.5);
    expect(parseFlexibleNumber([])).toBe(0);
  });

  it('trims whitespace and strips currency symbols / commas', () => {
    expect(parseFlexibleNumber('$1,234.56')).toBe(1234.56);
    expect(parseFlexibleNumber('  -50  ')).toBe(-50);
  });

  it('treats parentheses as negative', () => {
    expect(parseFlexibleNumber('(100.25)')).toBe(-100.25);
    expect(parseFlexibleNumber('($1,000)')).toBe(-1000);
  });

  it('treats trailing minus as negative', () => {
    expect(parseFlexibleNumber('123.45-')).toBe(-123.45);
  });

  it('normalises unicode minus to ASCII', () => {
    expect(parseFlexibleNumber('−100')).toBe(-100);
    expect(parseFlexibleNumber('—50')).toBe(-50);
  });

  it('returns 0 for non-parseable strings', () => {
    expect(parseFlexibleNumber('not-a-number')).toBe(0);
    expect(parseFlexibleNumber('')).toBe(0);
    expect(parseFlexibleNumber('   ')).toBe(0);
  });
});
