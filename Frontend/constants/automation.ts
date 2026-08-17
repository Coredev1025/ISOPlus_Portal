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
 * Touchpoints: lib/automation-email-block.tsx (Recipient select). Values are
 * the wire values of `AutomationBlock["recipient"]`.
 */
export const RECIPIENT_OPTIONS = [
  { value: "billing_contact", label: "Billing Contact" },
  { value: "client_participant", label: "Client / Participant" },
] as const;

/**
 * Touchpoints: lib/automation-email-block.tsx (Send Method select). Values are
 * the wire values of `AutomationBlock["sendMethod"]`.
 */
export const SEND_METHOD_OPTIONS = [
  { value: "isoplus", label: "Send from ISO+" },
  { value: "accounting", label: "Send from Accounting Platform" },
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
] as const;

/**
 * The one-line free-text fields of the email block, in render order. `isEmail`
 * is what selects a field for `EMAIL_PATTERN`; the three address-valued fields
 * are the same three the backend validates in `parseAutomationSettingsBody`.
 *
 * Touchpoints: lib/automation-email-block.tsx (renders the fields and validates
 * per keystroke), lib/automation-helpers.ts (derives the Save gate's key list).
 * Keys are `AutomationBlock` field names.
 */
export const EMAIL_TEXT_FIELDS = [
  { key: "sendCopyTo", id: "send-copy-to", label: "Send a Copy To", isEmail: true },
  { key: "replyTo", id: "reply-to", label: "Reply-to Email", isEmail: true },
  { key: "emailFrom", id: "email-from", label: "Email From", isEmail: true },
  { key: "emailSubject", id: "email-subject", label: "Email Subject", isEmail: false },
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
