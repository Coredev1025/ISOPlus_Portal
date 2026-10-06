import { describe, it, expect } from 'vitest';

import { parseBypassEmail } from '../../../src/utils/bypassEmail.js';

/**
 * `bypassEmail` overrides where a tick's email goes. It exists so a run can be
 * exercised end to end — generation, composition, attachment, delivery —
 * without a single message reaching a participant's real mailbox.
 *
 * Because it redirects mail, a malformed value must never be interpreted
 * loosely. Anything that does not parse to at least one well-formed address
 * throws, so a typo fails the tick instead of silently falling back to the
 * real recipients it was meant to protect.
 */

describe('parseBypassEmail', () => {
  it('returns null when absent, so the normal recipient resolution runs', () => {
    expect(parseBypassEmail(undefined)).toBeNull();
    expect(parseBypassEmail(null)).toBeNull();
    expect(parseBypassEmail('')).toBeNull();
    expect(parseBypassEmail('   ')).toBeNull();
  });

  it('parses a single address', () => {
    expect(parseBypassEmail('me@example.com')).toEqual(['me@example.com']);
  });

  it('parses a comma-separated list and trims whitespace', () => {
    expect(parseBypassEmail(' a@example.com , b@example.com ')).toEqual([
      'a@example.com', 'b@example.com',
    ]);
  });

  it('accepts an array as well as a string', () => {
    expect(parseBypassEmail(['a@example.com', 'b@example.com'])).toEqual([
      'a@example.com', 'b@example.com',
    ]);
  });

  it('drops empty entries from a trailing or doubled comma', () => {
    expect(parseBypassEmail('a@example.com,,b@example.com,')).toEqual([
      'a@example.com', 'b@example.com',
    ]);
  });

  it('de-duplicates, case-insensitively, so one mailbox gets one copy', () => {
    expect(parseBypassEmail('A@Example.com, a@example.com')).toEqual(['A@Example.com']);
  });

  it('throws on a malformed address rather than dropping it', () => {
    // Dropping it would send that participant's invoice to the real billing
    // contact — the exact outcome this parameter exists to prevent.
    expect(() => parseBypassEmail('a@example.com, not-an-address')).toThrow(/not a valid email/i);
    expect(() => parseBypassEmail('nope')).toThrow(/not a valid email/i);
  });

  it('throws on a non-string, non-array value', () => {
    expect(() => parseBypassEmail(42)).toThrow(/bypassEmail/i);
    expect(() => parseBypassEmail({ to: 'a@example.com' })).toThrow(/bypassEmail/i);
  });

  it('names the offending value in the error, so a typo is findable', () => {
    expect(() => parseBypassEmail('bad@@example.com')).toThrow(/bad@@example\.com/);
  });
});
