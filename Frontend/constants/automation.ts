/**
 * Every fixed value the invoice/statement automation panel depends on, in one
 * place. Each entry records its touchpoints — the modules that read it — so
 * changing one here tells you what it reaches without a grep. Keep those lists
 * current: a stale touchpoint comment is worse than none, because it will be
 * believed.
 *
 * This file imports nothing, deliberately, so a component and a helper can both
 * read it without risking a cycle. The option lists are therefore typed
 * structurally rather than against `AutomationSelectOption`, which they stay
 * assignable to.
 *
 * Two automation values are deliberately not here. `DEFAULT_BLOCK` stays in
 * `lib/automation-settings.ts` beside the `AutomationBlock` type it instantiates
 * — moving it would need a type import back, which is the cycle this file
 * avoids. The weekday/day-of-month/month lists in `lib/automation-run-on-options.ts`
 * stay with `runOnOptionsForUnit`, which derives from them; a derived structure
 * belongs with its logic.
 */

/**
 * The email address fields are validated against `EMAIL_PATTERN` in
 * `constants/validation.ts`, not here: the monthly statement's business details
 * form validates the same field, and two copies of that pattern is how the two
 * come to disagree.
 */

/**
 * Who the generated invoice or statement is addressed to.
 *
 * Touchpoints: lib/automation-email-block.tsx (Recipient select). Values are
 * the wire values of `AutomationBlock["recipient"]`.
 */
export const RECIPIENT_OPTIONS = [
  { value: "billing_contact", label: "Billing Contact" },
  { value: "client_participant", label: "Client / Participant" },
] as const;

/**
 * Which system performs the send.
 *
 * Touchpoints: lib/automation-email-block.tsx (Send Method select). Values are
 * the wire values of `AutomationBlock["sendMethod"]`.
 */
export const SEND_METHOD_OPTIONS = [
  { value: "isoplus", label: "Send from ISO+" },
  { value: "accounting", label: "Send from Accounting Platform" },
] as const;

/**
 * The interval unit a schedule repeats on.
 *
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
 * The free-text fields of the email block, in render order. `isEmail` is what
 * selects a field for `EMAIL_PATTERN`; the three address-valued fields are the
 * same three the backend validates in `parseAutomationSettingsBody`.
 *
 * Touchpoints: lib/automation-email-block.tsx (field list and validation). Keys
 * are `AutomationBlock` field names.
 */
export const EMAIL_TEXT_FIELDS = [
  { key: "sendCopyTo", id: "send-copy-to", label: "Send a Copy To", isEmail: true },
  { key: "replyTo", id: "reply-to", label: "Reply-to Email", isEmail: true },
  { key: "emailFrom", id: "email-from", label: "Email From", isEmail: true },
  { key: "emailSubject", id: "email-subject", label: "Email Subject", isEmail: false },
  { key: "emailMessage", id: "email-message", label: "Email Message", isEmail: false },
] as const;
