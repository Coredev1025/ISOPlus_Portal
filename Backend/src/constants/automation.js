/**
 * Every fixed value the invoice/statement automation settings depend on, in one
 * place.
 *
 * Each entry records its touchpoints — the modules that read it — so changing
 * one here tells you what it reaches without a grep. Keep those lists current:
 * a stale touchpoint comment is worse than none, because it will be believed.
 *
 * This file imports nothing, deliberately, so a model and a helper can both
 * read it without risking a cycle.
 */

/**
 * The email address fields are validated against `EMAIL_PATTERN` in
 * `constants/validation.js`, not here: the business profile validates the same
 * field, and two copies of that pattern is how the two come to disagree.
 */

// ── Schedule kinds ──────────────────────────────────────────────────────────

/**
 * The two `ScheduledJob.kind` values this feature registers handlers for, and
 * the values stored in the `kind` column. They live here rather than in
 * `services/automation/fanOut.js` because six modules key on them — a route and
 * the scheduler among them — and none of those should have to import a
 * fan-out module to learn the name of a schedule.
 *
 * Touchpoints: services/automation/fanOut.js (jobId prefix lookup),
 * services/scheduler/handlers.js (registration, settings-block lookup),
 * routes/workspace.js (upsert/disable per block, and the GET that merges
 * nextRunAt). Tests: automation.fanOut, automation.handler,
 * automation.pipeline.route, workspace.automation-settings.route.
 */
export const KIND_INVOICE = 'invoice_automation';
export const KIND_STATEMENT = 'statement_automation';

// ── Schedule shape ──────────────────────────────────────────────────────────

/**
 * The 24-hour local time a schedule fires at, as stored. Anchored at both
 * ends, so `'09:00 '` and `'0900'` are both rejected.
 *
 * No `g` flag, deliberately: a global regex carries `lastIndex` between calls,
 * and this one is shared by two validators on the same request.
 *
 * Touchpoints: utils/automationSettingsHelpers.js (validateBlock),
 * services/scheduler/pickerValidation.js (pickerScheduleError).
 */
export const RUN_AT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The weekday names `runOn` accepts when the unit is "week", lowercased —
 * comparison lowercases the incoming value rather than the list.
 *
 * Touchpoints: utils/automationSettingsHelpers.js (validateRunOn),
 * utils/automationScheduleHelpers.js (weekdayAnchor).
 */
export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

/**
 * The intervals `every.unit` accepts, and the enum both schemas declare.
 *
 * Touchpoints: models/AutomationSettings.js (every.unit enum),
 * models/ScheduledJob.js (schedule.every.unit enum),
 * services/scheduler/pickerValidation.js (everyError),
 * utils/automationSettingsHelpers.js (validateBlock).
 */
export const AUTOMATION_UNITS = ['day', 'week', 'month', 'quarter', 'year'];

/**
 * The upper bound on `every.n`. A year of daily runs is already far beyond any
 * real billing cadence, and an unbounded `n` turns the schedule arithmetic's
 * forward walk into an open-ended one.
 *
 * Touchpoints: services/scheduler/pickerValidation.js (everyError),
 * utils/automationSettingsHelpers.js (validateBlock).
 */
export const MAX_EVERY_N = 365;

/**
 * How many calendar months one unit of each month-based interval spans.
 *
 * Callers branch on `MONTHS_PER_UNIT[unit]` being truthy to decide whether a
 * unit is month-based at all, so `day` and `week` are absent rather than zero.
 *
 * An object, therefore a shared mutable — read-only by convention; nothing
 * freezes it.
 *
 * Touchpoints: utils/automationScheduleHelpers.js (computeNextRun),
 * utils/automationScheduleWindow.js (previousPeriodStartYmd).
 */
export const MONTHS_PER_UNIT = { month: 1, quarter: 3, year: 12 };

/**
 * Board labels the Invoice Generator page uses to pick NDIS vs Age Care.
 * Touchpoints: utils/automationBoardFlags.js.
 */
export const CARE_MANAGEMENT_PREFIX = 'Care Management';
export const LOW_CAT_BOARD_LABEL = 'Care Management - SaH - Low Cat';

/**
 * PDFLink.type values for scheduled artifacts.
 * Touchpoints: services/automation/generateDocuments.js, generateStatements.js.
 */
export const PDFLINK_TYPE_NDIS_INVOICE = 'NDIS Invoice';
export const PDFLINK_TYPE_AGE_CARE_INVOICE = 'Participant Tax Invoice';
export const PDFLINK_TYPE_MONTHLY_STATEMENT = 'Monthly Statement';
/**
 * The statement of account (invoice selection spec, section 4). A separate
 * document from the monthly statement, not a replacement: that one reports
 * plan budget against services delivered, this one reports money invoiced,
 * paid and owing. A statement run produces both, so the type is what keeps
 * their PDFLink rows and their replay lookups apart.
 * Touchpoints: services/automation/generateStatementOfAccount.js,
 * utils/statementAccountHistory.js.
 */
export const PDFLINK_TYPE_STATEMENT_OF_ACCOUNT = 'Statement of Account';

/**
 * Fallback due-date offset when accountsReceivableTerms has no number.
 * Touchpoints: utils/automationInvoiceDates.js.
 */
export const DEFAULT_INVOICE_DUE_DAYS = 14;

/**
 * The `limit` an automation run sends to the Invoice Generator list helpers.
 *
 * `'all'` is their sentinel for "do not paginate" (utils/itemsRouteHelpers.js,
 * parseListPagination), and it is the only correct value here. This used to be
 * 1000 — the page size the Invoice Generator UI sends, copied across without
 * the UI's Next button. A board with more billable rows than that in one period
 * had the surplus silently dropped: the list is sorted by service date and only
 * the first page was invoiced, and because the next run's window is the NEXT
 * period, those rows were never billed at all. Silent under-billing, with no
 * error and nothing on the invoice to show what was missing.
 *
 * The helpers already build and total the complete filtered set before slicing,
 * so asking for all of it costs the transform and reference-lookup stage, not a
 * second pass over the board.
 *
 * Touchpoints: services/automation/generateDocuments.js.
 */
export const GENERATOR_LIST_LIMIT = 'all';

/**
 * How long a completed or failed automation job record is kept in Redis.
 *
 * Retention exists for the jobId dedupe: BullMQ refuses an add whose jobId it
 * still holds, which is what collapses an at-least-once redelivery of the same
 * slot. Keeping every record forever bounded nothing — one job per board per
 * kind per slot, for the life of the deployment — and bought no durable
 * guarantee, because the jobId is not what stops a double bill. A replayed slot
 * regenerates nothing regardless: existingSlotResults hands back its PDFLink
 * rows, the NDIS list asks for rows with no invoice number yet, the Age Care
 * list drops rows that already carry one, and a statement matches its own
 * itemId. Those rows do not expire.
 *
 * 90 days is chosen against the redelivery window, not the billing cycle. A
 * redelivery is the tick re-dispatching an unadvanced slot, which happens
 * within minutes and stops at MAX_CONSECUTIVE_FAILURES; a later slot carries a
 * different periodKey and therefore a different jobId. Three months is margin,
 * not a requirement.
 *
 * Touchpoints: services/automation/queue.js.
 */
export const AUTOMATION_JOB_RETENTION_SECONDS = 90 * 24 * 3600;

// ── Email delivery state ────────────────────────────────────────────────────

/**
 * What has happened to the email that carried a generated document, as stored
 * on `PDFLink.deliveryState`.
 *
 * `generated` is the default and is NOT a failure: it means the document
 * exists and no send has been recorded against it yet — a UI-generated PDF,
 * or an automation run whose backend was the offline outbox. The client-facing
 * panel must render it as "Generated", not as an error.
 *
 * Touchpoints: models/PDFLink.js (deliveryState enum and default),
 * services/email/deliveryEvents.js (event mapping and the transition guard),
 * services/email/backends.js (the sesBackend send stamps SENT),
 * workers/emailEventsWorker.js (via deliveryEvents), routes/workspace.js
 * (loadRecentAutomationDocuments projects it). The frontend mirrors these
 * wire values in `Frontend/constants/automation.ts` (DELIVERY_STATE_BADGES).
 */
export const DELIVERY_STATE_GENERATED = 'generated';
export const DELIVERY_STATE_SENT = 'sent';
export const DELIVERY_STATE_DELAYED = 'delayed';
export const DELIVERY_STATE_DELIVERED = 'delivered';
export const DELIVERY_STATE_COMPLAINED = 'complained';
export const DELIVERY_STATE_FAILED = 'failed';
export const DELIVERY_STATE_BOUNCED = 'bounced';

/**
 * The enum `PDFLink.deliveryState` declares. Order is the natural progression,
 * not significant to the schema.
 *
 * Touchpoints: models/PDFLink.js (enum).
 */
export const DELIVERY_STATES = [
  DELIVERY_STATE_GENERATED,
  DELIVERY_STATE_SENT,
  DELIVERY_STATE_DELAYED,
  DELIVERY_STATE_DELIVERED,
  DELIVERY_STATE_COMPLAINED,
  DELIVERY_STATE_FAILED,
  DELIVERY_STATE_BOUNCED,
];

/**
 * How final each state is. An event only overwrites a state of strictly lower
 * rank, which is what makes the endpoint idempotent and stops a late
 * `Delivery` — SES does not order its notifications — from erasing a `Bounce`.
 *
 * `bounced` outranks `complained` and `failed` deliberately: it is the one
 * outcome the client can fix, by correcting the Recipient / Send a Copy To
 * address, so it is the one that must survive. The cost is that a complaint
 * arriving after a bounce is dropped; the bounce is the more actionable of the
 * two, and both are visible in SES itself.
 *
 * An object, therefore a shared mutable — read-only by convention; nothing
 * freezes it.
 *
 * Touchpoints: services/email/deliveryEvents.js (applyDeliveryEvent's guard).
 */
export const DELIVERY_STATE_RANK = {
  [DELIVERY_STATE_GENERATED]: 0,
  [DELIVERY_STATE_SENT]: 1,
  [DELIVERY_STATE_DELAYED]: 2,
  [DELIVERY_STATE_DELIVERED]: 3,
  [DELIVERY_STATE_COMPLAINED]: 4,
  [DELIVERY_STATE_FAILED]: 5,
  [DELIVERY_STATE_BOUNCED]: 6,
};

/**
 * The SES event vocabulary is mapped to the states above in
 * `services/email/deliveryEvents.js` rather than here, and the plain-English
 * bounce sentences live beside the function that composes them: both are
 * read by exactly one module, and one of them is client-facing copy.
 */

/**
 * Why a send was refused before it ever reached SES, said the way the client
 * has to hear it.
 *
 * These are the `reason` codes `services/email/recipients.js` and the SES
 * backend answer with. They were only ever logged, so a run that delivered
 * nothing left its documents at `generated` — muted, and explicitly "never as
 * an error". Epic 5 asks for the opposite: the delivery problem flagged
 * against the send, in plain English, "so the client knows to fix the
 * Recipient/Send a Copy To field".
 *
 * Scope, stated because it is easy to over-read: this changes the *document*
 * rows. The block badge above them is unchanged and still reads On track after
 * an all-refused run — it describes the job, and the job did succeed; it
 * generated the documents. `blockNeedsAttention` reads the schedule's own
 * error fields, which a refusal never sets because a refusal does not throw.
 * Whether a delivery failure should also mark the schedule as needing
 * attention is a product decision and is deliberately not taken here.
 *
 * Each sentence therefore names the field to go and change, not the internal
 * code. `DEFAULT_DELIVERY_REFUSAL_MESSAGE` covers a reason added later: the
 * state still has to be recorded, because falling back to silence is the bug.
 *
 * An object, therefore a shared mutable — read-only by convention.
 *
 * Touchpoints: services/email/deliveryEvents.js (`recordEmailFailure`, the
 * only reader).
 */
export const DELIVERY_REFUSAL_MESSAGES = {
  no_participant_name: 'This document has no client on it, so there was no profile to read an address from.',
  profile_not_found: "The client's profile could not be found in the Intake Register.",
  no_address_on_profile: "The client's profile has no email address on it.",
  billing_contact_has_no_address: 'The billing contact named on this profile has no email address.',
  malformed_address: 'The email address on file is not a valid address.',
  unsupported_recipient_type: 'The Recipient setting is not one this workspace can send to.',
  access_denied: 'The mail service refused this recipient. The address is outside the domains this environment is allowed to send to.',
};

/**
 * What an unmapped refusal reads as. Deliberately still a failure: a reason
 * this build has no sentence for is not a reason to show the send as healthy.
 *
 * Touchpoints: services/email/deliveryEvents.js (`recordEmailFailure`).
 */
export const DEFAULT_DELIVERY_REFUSAL_MESSAGE =
  'This document could not be emailed. Check the Recipient and Send a Copy To settings.';
