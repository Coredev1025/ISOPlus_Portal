import { describe, expect, it } from "vitest";

import { EMAIL_PATTERN } from "@/constants/validation";

describe("EMAIL_PATTERN", () => {
  it.each([
    "a@b.com",
    "first.last@sub.example.co.uk",
    "user+tag@example.io",
    "billing@iso-plus.com.au",
  ])("accepts %s", (address) => {
    expect(EMAIL_PATTERN.test(address)).toBe(true);
  });

  it.each(["plain", "no-domain@", "@no-local.com", "no-dot@example", "a b@e.com"])(
    "rejects %s",
    (address) => {
      expect(EMAIL_PATTERN.test(address)).toBe(false);
    },
  );

  // A domain label is never empty, so each of these is a typo the field should
  // flag rather than let through to the send.
  it.each(["a@b..com", "a@.example.com", "a@example.com."])(
    "rejects the empty domain label in %s",
    (address) => {
      expect(EMAIL_PATTERN.test(address)).toBe(false);
    },
  );

  /**
   * The pattern runs on every keystroke, so its cost has to stay linear in the
   * length of what was typed. A domain part written as `[^\s@]+\.[^\s@]+` is
   * ambiguous — the dot is also matched by the class either side of it — so a
   * long dotted string that ultimately fails makes the engine retry every
   * split, which is quadratic. 25k characters took ~700ms that way and takes
   * under a millisecond when the parts cannot overlap.
   */
  it("rejects a long dotted non-address in linear time", () => {
    const candidate = `a@${"b.".repeat(25_000)} `;

    const startedAt = performance.now();
    const matched = EMAIL_PATTERN.test(candidate);
    const elapsed = performance.now() - startedAt;

    expect(matched).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });
});
