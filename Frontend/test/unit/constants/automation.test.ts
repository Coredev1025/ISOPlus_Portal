import { describe, expect, it } from "vitest";

import { EMAIL_TEXT_FIELDS } from "@/constants/automation";

describe("automation option lists", () => {
  it("marks only the address-valued text fields for email validation", () => {
    const emailFields = EMAIL_TEXT_FIELDS.filter((field) => field.isEmail).map(
      (field) => field.key,
    );

    expect(emailFields).toEqual(["sendCopyTo", "replyTo", "emailFrom"]);
  });
});
