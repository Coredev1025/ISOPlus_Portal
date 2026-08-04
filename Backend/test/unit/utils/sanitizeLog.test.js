import { describe, it, expect } from 'vitest';
import { sanitizeLogValue } from '../../../src/utils/sanitizeLog.js';

describe('sanitizeLogValue', () => {
  it('returns nullish values unchanged', () => {
    expect(sanitizeLogValue(null)).toBeNull();
    expect(sanitizeLogValue(undefined)).toBeUndefined();
  });

  it('strips newlines from strings', () => {
    expect(sanitizeLogValue('a\nb\r\nc')).toBe('a b c');
  });

  it('sanitizes arrays recursively', () => {
    expect(sanitizeLogValue(['a\nb', 1])).toEqual(['a b', 1]);
  });

  it('sanitizes objects recursively', () => {
    expect(sanitizeLogValue({ a: 'x\ny', n: 2 })).toEqual({ a: 'x y', n: 2 });
  });

  it('returns non-string primitives unchanged', () => {
    expect(sanitizeLogValue(42)).toBe(42);
    expect(sanitizeLogValue(true)).toBe(true);
  });
});
