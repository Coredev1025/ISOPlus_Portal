import { describe, expect, it } from "vitest";

import {
  EMAIL_TEXT_FIELDS,
  RECIPIENT_OPTIONS,
  SEND_METHOD_OPTIONS,
  UNIT_OPTIONS,
} from "@/constants/automation";

describe("automation option lists", () => {
  it.each([
    ["RECIPIENT_OPTIONS", RECIPIENT_OPTIONS],
    ["SEND_METHOD_OPTIONS", SEND_METHOD_OPTIONS],
    ["UNIT_OPTIONS", UNIT_OPTIONS],
  ])("gives every %s entry a distinct value and a label", (_name, options) => {
    expect(options.length).toBeGreaterThan(0);
    expect(new Set(options.map((option) => option.value)).size).toBe(
      options.length,
    );
    expect(options.every((option) => option.label !== "")).toBe(true);
  });

  it("marks only the address-valued text fields for email validation", () => {
    const emailFields = EMAIL_TEXT_FIELDS.filter((field) => field.isEmail).map(
      (field) => field.key,
    );

    expect(emailFields).toEqual(["sendCopyTo", "replyTo", "emailFrom"]);
  });
});
