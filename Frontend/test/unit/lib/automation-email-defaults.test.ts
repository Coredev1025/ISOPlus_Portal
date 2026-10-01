import { describe, it, expect } from "vitest";
import {
  DEFAULT_EMAIL_MESSAGE,
  DEFAULT_EMAIL_SUBJECT,
} from "@/constants/automation";
import { withEmailDefaults } from "@/lib/automation-email-defaults";
import { DEFAULT_BLOCK } from "@/lib/automation-settings";

/**
 * KAN-265. The client asked for the Email Subject and Email Message to arrive
 * pre-filled rather than blank, per block, and for a way back to that copy.
 *
 * Pre-fill only ever touches an EMPTY field. A workspace that has written its
 * own wording must never have it replaced by a default — that would be the
 * product quietly editing a client's outgoing mail.
 */
const block = (overrides = {}) => ({ ...structuredClone(DEFAULT_BLOCK), ...overrides });

describe("withEmailDefaults", () => {
  it("fills an empty subject and message for the invoice block", () => {
    const filled = withEmailDefaults(block(), "invoice");
    expect(filled.emailSubject).toBe(DEFAULT_EMAIL_SUBJECT.invoice);
    expect(filled.emailMessage).toBe(DEFAULT_EMAIL_MESSAGE.invoice);
  });

  it("fills the statement block with its own copy, not the invoice's", () => {
    const filled = withEmailDefaults(block(), "statement");
    expect(filled.emailSubject).toBe(DEFAULT_EMAIL_SUBJECT.statement);
    expect(filled.emailMessage).toBe(DEFAULT_EMAIL_MESSAGE.statement);
    expect(filled.emailSubject).not.toContain("{{invoice_number}}");
  });

  // The rule that matters most: this runs over what the API returned, so
  // overwriting a stored value would silently rewrite a client's own wording.
  it("leaves wording the client has already written alone", () => {
    const mine = block({
      emailSubject: "Your bill",
      emailMessage: "<p>Hi there</p>",
    });
    const filled = withEmailDefaults(mine, "invoice");
    expect(filled.emailSubject).toBe("Your bill");
    expect(filled.emailMessage).toBe("<p>Hi there</p>");
  });

  // A field holding only spaces — or the editor's empty-paragraph artefact —
  // is empty to a reader, so it is empty here too.
  it("treats whitespace and an empty rich-text paragraph as blank", () => {
    const filled = withEmailDefaults(
      block({ emailSubject: "   ", emailMessage: "<p></p>" }),
      "invoice",
    );
    expect(filled.emailSubject).toBe(DEFAULT_EMAIL_SUBJECT.invoice);
    expect(filled.emailMessage).toBe(DEFAULT_EMAIL_MESSAGE.invoice);
  });

  it("fills one field without disturbing the other", () => {
    const filled = withEmailDefaults(block({ emailSubject: "Kept" }), "invoice");
    expect(filled.emailSubject).toBe("Kept");
    expect(filled.emailMessage).toBe(DEFAULT_EMAIL_MESSAGE.invoice);
  });

  // Pure: the settings object the panel holds is React state.
  it("returns a new object and does not mutate its input", () => {
    const original = block();
    const filled = withEmailDefaults(original, "invoice");
    expect(filled).not.toBe(original);
    expect(original.emailSubject).toBe("");
  });

  it("carries every other field through untouched", () => {
    const filled = withEmailDefaults(block({ runAt: "07:30", enabled: true }), "invoice");
    expect(filled.runAt).toBe("07:30");
    expect(filled.enabled).toBe(true);
  });
});

describe("the default copy itself", () => {
  it("uses the one variable its own block can resolve", () => {
    expect(DEFAULT_EMAIL_SUBJECT.invoice).toContain("{{invoice_number}}");
    expect(DEFAULT_EMAIL_MESSAGE.invoice).toContain("{{invoice_number}}");
    expect(DEFAULT_EMAIL_SUBJECT.statement).toContain("{{statement_number}}");
    expect(DEFAULT_EMAIL_MESSAGE.statement).toContain("{{statement_number}}");
  });

  // An invoice run resolves no statement number and vice versa, and an
  // unresolved token is left verbatim — so a crossed variable would mail a
  // client the literal braces.
  it("never carries the other block's variable", () => {
    expect(DEFAULT_EMAIL_SUBJECT.invoice).not.toContain("{{statement_number}}");
    expect(DEFAULT_EMAIL_MESSAGE.invoice).not.toContain("{{statement_number}}");
    expect(DEFAULT_EMAIL_SUBJECT.statement).not.toContain("{{invoice_number}}");
    expect(DEFAULT_EMAIL_MESSAGE.statement).not.toContain("{{invoice_number}}");
  });

  it("names the business in both subjects, as the client's table specifies", () => {
    expect(DEFAULT_EMAIL_SUBJECT.invoice).toBe(
      "Invoice {{invoice_number}} from {{business_name}}",
    );
    expect(DEFAULT_EMAIL_SUBJECT.statement).toBe(
      "Account statement {{statement_number}} from {{business_name}}",
    );
  });

  // The editor is rich text: plain text with newlines renders as one run-on
  // paragraph.
  it("is HTML paragraphs, which is what the rich-text editor renders", () => {
    expect(DEFAULT_EMAIL_MESSAGE.invoice.startsWith("<p>Dear Recipient,</p>")).toBe(true);
    expect(DEFAULT_EMAIL_MESSAGE.statement).toContain("<p>Account Receivable Team</p>");
  });

  // KAN-283: both defaults close with the same sign-off, each line its own
  // paragraph because the editor is rich text.
  it("ends both defaults with the Account Receivable Team and business name sign-off", () => {
    const signOff = "<p>Kind regards,</p><p>Account Receivable Team</p><p>{{business_name}}</p>";
    expect(DEFAULT_EMAIL_MESSAGE.invoice.endsWith(signOff)).toBe(true);
    expect(DEFAULT_EMAIL_MESSAGE.statement.endsWith(signOff)).toBe(true);
  });

  it("says a statement raises no new charges, so it does not read as a second bill", () => {
    expect(DEFAULT_EMAIL_MESSAGE.statement).toContain("not a tax invoice");
    expect(DEFAULT_EMAIL_MESSAGE.statement).toContain("does not raise any new charges");
  });
});
