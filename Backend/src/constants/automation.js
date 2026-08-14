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

/**
 * The 24-hour local time a schedule fires at, as stored.
 *
 * Touchpoints: utils/automationSettingsHelpers.js (validateBlock).
 */
export const RUN_AT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The weekday names `runOn` accepts when the unit is "week", lowercased —
 * comparison lowercases the incoming value rather than the list.
 *
 * Touchpoints: utils/automationSettingsHelpers.js (validateRunOn).
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
 * Board labels the Invoice Generator page uses to pick NDIS vs Age Care.
 * Touchpoints: utils/automationBoardFlags.js.
 */
export const CARE_MANAGEMENT_PREFIX = 'Care Management';
export const LOW_CAT_BOARD_LABEL = 'Care Management - SaH - Low Cat';

/**
 * InvoiceNumber.type written by the generator PDF path (the page's "invoiced").
 * Touchpoints: services/automation/generateDocuments.js.
 */
export const INVOICE_NUMBER_TYPE_PDF = 'PDF';

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

