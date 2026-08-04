import { describe, it, expect } from 'vitest';
import { tokenizeString, trimAndUnwrapQuotes } from '../../../src/utils/dynamicLinking.js';

describe('trimAndUnwrapQuotes', () => {
  it('trims and unwraps matching quotes', () => {
    expect(trimAndUnwrapQuotes('  "hello"  ')).toBe('hello');
    expect(trimAndUnwrapQuotes("'world'")).toBe('world');
  });
});

describe('tokenizeString', () => {
  it('splits on > outside quotes into tokens', () => {
    const tokens = tokenizeString('one > two > three');
    expect(tokens).toEqual(['one', 'two', 'three']);
  });

  it('keeps quoted segments intact', () => {
    const tokens = tokenizeString('"a > b" > mid > end');
    expect(tokens[0]).toBe('a > b');
    expect(tokens.length).toBe(3);
  });
});
