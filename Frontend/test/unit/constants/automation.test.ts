import { describe, expect, it } from "vitest";

import { EMAIL_TEXT_FIELDS } from "@/constants/automation";

describe("automation option lists", () => {
  it("marks only the address-valued text fields for email validation", () => {
    const emailFields = EMAIL_TEXT_FIELDS.filter((field) => field.isEmail).map(
      (field) => field.key,
    );

    expect(emailFields).toEqual(["sendCopyTo", "replyTo"]);
  });

  // KAN-269: Email From becomes an application-level setting (KAN-270), not a
  // per-workspace/user-editable field, so it must not appear in the array that
  // drives the email block's rendered fields.
  it("no longer offers Email From as an editable field", () => {
    const keys = EMAIL_TEXT_FIELDS.map((field) => field.key);

    expect(keys).not.toContain("emailFrom");
  });
});
