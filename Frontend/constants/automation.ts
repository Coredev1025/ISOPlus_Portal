/**
 * Fixed values for the invoice/statement automation panel. Each entry records
 * its touchpoints — the modules that read it — so changing one tells you what it
 * reaches without a grep. A stale touchpoint comment is worse than none.
 *
 * Two automation values are deliberately elsewhere: `DEFAULT_BLOCK` in
 * `lib/automation-settings.ts`, because moving it would need a type import back
 * and this file imports nothing; and the weekday/day-of-month/month lists in
 * `lib/automation-run-on-options.ts`, which `runOnOptionsForUnit` derives from.
 */

/**
 * Touchpoints: lib/invoice-statement-automation-panel.tsx (Invoice block's Send
 * Method select, via lib/automation-email-block.tsx). Values are the wire
 * values of `AutomationBlock["sendMethod"]`.
 */
export const SEND_METHOD_OPTIONS = [
  { value: "isoplus", label: "Send from ISO+™" },
  { value: "accounting", label: "Send from Accounting Platform" },
] as const;

/**
 * Touchpoints: lib/invoice-statement-automation-panel.tsx (Statement block's
 * Send Method select). Only invoices can be delivered through the accounting
 * platform, and the API refuses anything else on a statement — mirrors
 * `STATEMENT_SEND_METHOD` in Backend/src/constants/automation.js (KAN-44).
 */
export const STATEMENT_SEND_METHOD_OPTIONS = [
  { value: "isoplus", label: "Send from ISO+" },
] as const;

/**
 * Touchpoints: lib/automation-schedule-block.tsx (Every select). Values are the
 * wire values of `AutomationUnit`.
 */
export const UNIT_OPTIONS = [
  { value: "day", label: "Day(s)" },
  { value: "week", label: "Week(s)" },
  { value: "month", label: "Month(s)" },
  { value: "quarter", label: "Quarter(s)" },
  { value: "year", label: "Year(s)" },
] as const;

/**
 * `AutomationBlock` fields the scheduler computes from ScheduledJob, so a Save
 * must never send them back and overwrite run state no user typed.
 *
 * Touchpoints: lib/automation-settings.ts (`toAutomationSavePayload`, and the
 * `AutomationSavePayload` type derived from this list).
 */
export const READ_ONLY_BLOCK_FIELDS = [
  "nextRun",
  "lastRunAt",
  "lastRunError",
  "lastRunFailed",
  "consecutiveFailures",
  // Resolved per schedule by the scheduler (ScheduledJob.timezone), never typed
  // here. Sending it back would let a Save move the zone a live schedule fires
  // in — the display field silently rewriting the billing time.
  "timezone",
] as const;

/**
 * The one-line free-text fields of the email block, in render order. `isEmail`
 * is what selects a field for `EMAIL_PATTERN`; the two address-valued fields
 * here are two of the three the backend validates in
 * `parseAutomationSettingsBody` — `emailFrom` is no longer editable in this
 * UI (KAN-269, it becomes an application-level setting) but the field still
 * exists on `AutomationBlock` and is validated server-side until KAN-270
 * removes it there too.
 *
 * Touchpoints: lib/automation-email-block.tsx (renders the fields and validates
 * per keystroke), lib/automation-helpers.ts (derives the Save gate's key list).
 * Keys are `AutomationBlock` field names.
 */
export const EMAIL_TEXT_FIELDS = [
  // The only address field that takes several, comma separated.
  { key: "sendCopyTo", id: "send-copy-to", label: "Send a Copy To", isEmail: true, allowsList: true },
  { key: "replyTo", id: "reply-to", label: "Reply-to Email", isEmail: true, allowsList: false },
  { key: "emailSubject", id: "email-subject", label: "Email Subject", isEmail: false, allowsList: false },
] as const;

/**
 * Separate from the four above because it renders as a grid-spanning rich text
 * editor, not an input — keeping it out leaves that list a plain map with no
 * per-field escape hatches.
 *
 * Touchpoints: lib/automation-email-block.tsx (the explicit Email Message field).
 */
export const EMAIL_MESSAGE_FIELD = {
  key: "emailMessage",
  id: "email-message",
  label: "Email Message",
} as const;

/**
 * The two automation kinds, as the panel's `idPrefix` already spells them.
 *
 * Typed rather than left a bare string because the email defaults below are
 * keyed on it: a third spelling would silently pick no default at all.
 */
export type AutomationKind = "invoice" | "statement";

/**
 * The one system variable each block's message may carry (KAN-265).
 *
 * The client asked for exactly one per block, not a menu. An invoice run
 * resolves no statement number and a statement run resolves no invoice number
 * (Backend/src/workers/automationWorker.js, buildTemplateVars), so offering
 * both would offer each block a token that can never fill in — and an
 * unresolved token is left verbatim by design, so it would reach a client as
 * literal "{{statement_number}}" text.
 *
 * Touchpoints: lib/automation-email-block.tsx (the inline guide).
 */
export const EMAIL_TEMPLATE_VARIABLE: Readonly<Record<AutomationKind, string>> =
  Object.freeze({
    invoice: "{{invoice_number}}",
    statement: "{{statement_number}}",
  });

/**
 * What the inline guide says the variable does.
 *
 * Touchpoints: lib/automation-email-block.tsx.
 */
export const EMAIL_TEMPLATE_VARIABLE_HINT: Readonly<Record<AutomationKind, string>> =
  Object.freeze({
    invoice:
      "Type {{invoice_number}} anywhere in the subject or message and it is "
      + "replaced with the invoice number when the email is sent. A run "
      + "covering several invoices lists them all.",
    statement:
      "Type {{statement_number}} anywhere in the subject or message and it is "
      + "replaced with the statement number when the email is sent. A run "
      + "covering several statements lists them all.",
  });

/**
 * The pre-filled Email Subject per block, exactly as the client specified.
 *
 * `{{business_name}}` resolves alongside the document number — both are built
 * in buildTemplateVars — so the subject reads "Invoice INV-1205 from Acme
 * Care" on the way out.
 *
 * Touchpoints: lib/automation-email-defaults.ts.
 */
export const DEFAULT_EMAIL_SUBJECT: Readonly<Record<AutomationKind, string>> =
  Object.freeze({
    invoice: "Invoice {{invoice_number}} from {{business_name}}",
    statement: "Account statement {{statement_number}} from {{business_name}}",
  });

/**
 * The pre-filled Email Message per block, exactly as the client specified.
 *
 * HTML because the field is a rich-text editor: handing it plain text with
 * newlines renders one run-on paragraph. Kept as the paragraphs the client
 * wrote so "Reset to default" returns the document to a known copy rather
 * than to something approximating it.
 *
 * Touchpoints: lib/automation-email-defaults.ts.
 */
export const DEFAULT_EMAIL_MESSAGE: Readonly<Record<AutomationKind, string>> =
  Object.freeze({
    invoice:
      "<p>Dear Recipient,</p>"
      + "<p>Please find attached invoice {{invoice_number}} for services "
      + "delivered during the period shown on the document.</p>"
      + "<p>The invoice includes payment details and the due date. Please "
      + "quote the invoice number as the payment reference so we can allocate "
      + "your payment correctly.</p>"
      + "<p>Should you have any questions, please do not hesitate to contact "
      + "us.</p>"
      + "<p>Kind regards,</p>"
      + "<p>Account Receivable Team</p>"
      + "<p>{{business_name}}</p>",
    statement:
      "<p>Dear Recipient,</p>"
      + "<p>Please find attached your account statement, "
      + "{{statement_number}}.</p>"
      + "<p>The statement lists every invoice issued and every payment "
      + "received on your account during that period, along with any "
      + "outstanding balance and how long it has been owing. It is provided "
      + "for your records. It is not a tax invoice and does not raise any new "
      + "charges.</p>"
      + "<p>Kind regards,</p>"
      + "<p>Account Receivable Team</p>"
      + "<p>{{business_name}}</p>",
  });

/**
 * How each `PDFLink.deliveryState` reads on the status panel.
 *
 * The wire values mirror `Backend/src/constants/automation.js`
 * (DELIVERY_STATES) — this is a second copy across a network boundary, not a
 * second source of truth; the backend's enum is what validates.
 *
 * `generated` is the default and is NOT a failure: it means the document
 * exists and no send has been recorded against it — a document produced by the
 * UI generators, or by an automation run whose backend was the offline outbox.
 * It renders muted, never as an error.
 *
 * `showsDetail` is what stops a stale `deliveryDetail` from an earlier state
 * being rendered beside a state that is fine. Only the states a client can
 * act on carry their sentence.
 *
 * Touchpoints: lib/automation-helpers.ts (`deliveryStatus`, which is the only
 * reader), lib/automation-status-panel.tsx (renders the result).
 */
export const DELIVERY_STATE_BADGES = {
  generated: { label: "Generated", tone: "muted", showsDetail: false },
  sent: { label: "Sent", tone: "muted", showsDetail: false },
  delayed: { label: "Delayed", tone: "warn", showsDetail: true },
  delivered: { label: "Delivered", tone: "ok", showsDetail: false },
  complained: { label: "Marked as spam", tone: "warn", showsDetail: true },
  failed: { label: "Failed to send", tone: "bad", showsDetail: true },
  bounced: { label: "Bounced", tone: "bad", showsDetail: true },
} as const;

/**
 * What an unknown or absent state falls back to. A build that has not caught
 * up with a new backend state shows the document as generated rather than
 * inventing a failure.
 *
 * Touchpoints: lib/automation-helpers.ts (`deliveryStatus`).
 */
export const DEFAULT_DELIVERY_STATE = "generated";

/**
 * How often the client panel refetches its settings and recent documents.
 *
 * The panel used to fetch once on mount. SES publishes a Bounce or Complaint
 * minutes after the send, so a client watching the tab saw "Sent" indefinitely
 * and only learned of the failure by reloading — while the panel's own code
 * justified its `role="status"` with "when a poll turns a 'Sent' row into a
 * bounce". This is that poll.
 *
 * Slow on purpose. This is a settings page someone leaves open, not a
 * dashboard, and each tick costs a settings read plus a documents aggregation.
 *
 * Touchpoints: lib/invoice-statement-automation-panel.tsx.
 */
export const AUTOMATION_PANEL_POLL_MS = 60_000;

/**
 * How many recent documents the status panel shows before it is expanded.
 *
 * The list is a health signal first — "did last night's run produce anything,
 * and did it send" — and five rows answer that without pushing the rest of the
 * settings page below the fold. The remainder is one click away rather than
 * hidden: a client chasing a bounce from three runs ago still needs to reach
 * it.
 *
 * Touchpoints: lib/automation-status-panel.tsx (`RecentDocumentList`).
 */
export const COLLAPSED_RECENT_DOCUMENTS = 5;
