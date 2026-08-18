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
 * Fallback due-date offset when accountsReceivableTerms has no number.
 * Touchpoints: utils/automationInvoiceDates.js.
 */
export const DEFAULT_INVOICE_DUE_DAYS = 14;

/**
 * Same page/limit the Invoice Generator UI sends on GET .../invoice-generator.
 * Touchpoints: services/automation/generateDocuments.js.
 */
export const GENERATOR_LIST_LIMIT = 1000;

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
