// Backend/test/unit/constants/validation.test.js
import { describe, it, expect } from 'vitest';

import { EMAIL_PATTERN } from '../../../src/constants/validation.js';

describe('EMAIL_PATTERN', () => {
  it.each([
    'a@b.com',
    'first.last@sub.example.co.uk',
    'user+tag@example.io',
    'billing@iso-plus.com.au',
  ])('accepts %s', (address) => {
    expect(EMAIL_PATTERN.test(address)).toBe(true);
  });

  it.each(['plain', 'no-domain@', '@no-local.com', 'no-dot@example', 'a b@e.com'])(
    'rejects %s',
    (address) => {
      expect(EMAIL_PATTERN.test(address)).toBe(false);
    },
  );

  // A domain label is never empty, so each of these is a typo to refuse on save
  // rather than store and hand to the sender.
  it.each(['a@b..com', 'a@.example.com', 'a@example.com.'])(
    'rejects the empty domain label in %s',
    (address) => {
      expect(EMAIL_PATTERN.test(address)).toBe(false);
    },
  );

  /**
   * This runs on a request body, so its cost has to stay linear in the length
   * of what was sent. A domain part written as `[^\s@]+\.[^\s@]+` is ambiguous
   * — the dot is also matched by the class either side of it — so a long dotted
   * string that ultimately fails makes the engine retry every split, which is
   * quadratic. That turns one oversized field into CPU a request gets to spend
   * for us.
   */
  it('rejects a long dotted non-address in linear time', () => {
    const candidate = `a@${'b.'.repeat(25_000)} `;

    const startedAt = performance.now();
    const matched = EMAIL_PATTERN.test(candidate);
    const elapsed = performance.now() - startedAt;

    expect(matched).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });
});
