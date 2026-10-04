/**
 * Every fixed value the invoice ledger depends on, in one place (KAN-302).
 *
 * Each entry records its touchpoints, the modules that read it, so changing one
 * here tells you what it reaches without a grep. Keep those lists current: a stale
 * touchpoint comment is worse than none, because it will be believed.
 *
 * This file imports nothing, deliberately, so a model and a service can both read
 * it without risking a cycle. The objects below are read-only by convention;
 * nothing freezes them.
 *
 * Design: docs/superpowers/specs/2026-10-04-invoice-source-of-truth-design.md.
 */

// ── The two rollout flags ───────────────────────────────────────────────────

/**
 * Environment variable names. Both are Elastic Beanstalk properties, off by
 * default, changeable without a deploy.
 *
 * Touchpoints: utils/invoiceLedger/flags.js (the only reader).
 */
export const INVOICE_LEDGER_WRITE_ENV = 'INVOICE_LEDGER_WRITE';
export const INVOICE_LEDGER_READ_ENV = 'INVOICE_LEDGER_READ';

/**
 * WRITE: whether issuing an invoice also writes the new record. READ: `off`
 * serves the old stores, `shadow` serves them and logs any difference from the
 * new record, `on` serves the new record. Anything else parses to `off`.
 *
 * Touchpoints: utils/invoiceLedger/flags.js.
 */
export const WRITE_MODE = { OFF: 'off', ON: 'on' };
export const READ_MODE = { OFF: 'off', SHADOW: 'shadow', ON: 'on' };

// ── The invoice record ──────────────────────────────────────────────────────

/**
 * Touchpoints: models/Invoice.js (enums), utils/invoiceLedger/*.js.
 *
 * `void` exists so the KAN-289 decision needs no schema change; nothing sets it yet.
 */
export const INVOICE_STATUS = { ISSUED: 'issued', VOID: 'void' };

/**
 * `portal`: an invoice the portal issued. `xero`: an invoice that exists only in
 * Xero (the manual Xero routes). An invoice the portal issued and later pushed to
 * Xero as a draft stays `portal` and carries `xero`.
 */
export const INVOICE_SOURCE = { PORTAL: 'portal', XERO: 'xero' };

/**
 * `job`: a Job Management invoice (the `/invoice` webhook), billed to a client rather than a participant.
 * Touchpoints: models/Invoice.js (enum), utils/invoiceLedger/issue.js, services/automation/generateDocuments.js,
 * routes/webhook.js, routes/xero.js, utils/webhookNdisPdfHandlers.js, utils/webhookParticipantTaxPdfHelpers.js,
 * utils/xeroNdisRouteHandlers.js.
 */
export const INVOICE_KIND = { NDIS: 'ndis', AGE_CARE: 'age_care', JOB: 'job' };

/**
 * Touchpoints: models/Invoice.js (enum), services/automation/generateDocuments.js,
 * routes/webhook.js, routes/xero.js, utils/webhookNdisPdfHandlers.js, utils/webhookParticipantTaxPdfHelpers.js,
 * utils/xeroNdisRouteHandlers.js.
 */
export const INVOICE_TRIGGER = { AUTOMATION: 'automation', MANUAL: 'manual' };

/**
 * `live`: issued by `issueInvoice()` or `recordIssuedInvoice()`. `backfill`: built by the prefill script.
 * Touchpoints: models/Invoice.js, and the backfill script (not yet written).
 */
export const INVOICE_ORIGIN = { LIVE: 'live', BACKFILL: 'backfill' };

// ── Legacy number forms ─────────────────────────────────────────────────────

/**
 * The suffixes older code appended to an invoice number. KAN-294 stopped adding
 * the ISO+ one to invoices; stored data still carries both, and the Xero one is
 * how a Xero invoice is marked on an item.
 *
 * Touchpoints: utils/invoiceLedger/numbers.js (parses them off). The older
 * readers (routes/items.js pdf-link lookup, the invoice generator page) still
 * know the ISO+ form themselves until they move onto the ledger.
 */
export const LEGACY_SUFFIX = {
  ISOPLUS: ' (ISO+™)',
  XERO: ' (Xero)',
};

// ── The claim ───────────────────────────────────────────────────────────────

/**
 * Separates the attempt id from the rest of a provisional claim token for a
 * manual producer. A scheduled run keeps the deterministic token (a retried slot
 * must re-claim its own items); a manual invoice has no slot, so two concurrent
 * invoices for one participant would share a token and both claim the same items.
 *
 * Touchpoints: utils/invoiceLedger/issue.js.
 */
export const ATTEMPT_TOKEN_SEPARATOR = '#';

/**
 * The classes a difference between the old stores and the invoice record may have when the
 * statement is built from both (shadow mode, KAN-309). Known classes are the expected
 * changes of design section 6.6; the unexpected ones stop the switch to `on`.
 * Touchpoints: utils/invoiceLedger/shadow.js.
 */
export const SHADOW_CLASS = {
  LEDGER_ONLY_INVOICE: 'ledger_only_invoice',
  PAYMENT_NEWLY_APPLIED: 'payment_newly_applied',
  UNAPPLIED_PAYMENT: 'unapplied_payment',
  LEGACY_ONLY_INVOICE: 'legacy_only_invoice',
  TOTAL_DIFFERS: 'total_differs',
  DATE_DIFFERS: 'date_differs',
  PAYMENT_NO_LONGER_APPLIED: 'payment_no_longer_applied',
  DUPLICATE_NUMBER: 'duplicate_number',
  DUE_DATE_DIFFERS: 'due_date_differs',
  CLOSING_DIFFERS: 'closing_differs',
};

/** The subset of SHADOW_CLASS that is never expected. Touchpoints: utils/invoiceLedger/shadow.js. */
export const UNEXPECTED_SHADOW_CLASSES = [
  SHADOW_CLASS.LEGACY_ONLY_INVOICE,
  SHADOW_CLASS.TOTAL_DIFFERS,
  SHADOW_CLASS.DATE_DIFFERS,
  SHADOW_CLASS.PAYMENT_NO_LONGER_APPLIED,
  SHADOW_CLASS.CLOSING_DIFFERS,
];
