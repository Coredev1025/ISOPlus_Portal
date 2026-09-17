/**
 * Schema default for invoice, purchase order, quote, statement, and
 * statement-of-account sequences.
 *
 * `statement` (STM-) is still claimed by monthly budget statement automation
 * (`generateStatements.allocateStatementNumber`). It is no longer editable in
 * Finance Settings Document Number Configuration — saves must re-send the
 * loaded STM- series so a Finance PUT does not reset it. `statementOfAccount`
 * (SOA-) is the series operators configure in that UI.
 *
 * Touchpoints: models/Business.js, Frontend/lib/configure-business-helpers.ts,
 * Frontend/lib/financial-settings-panel.tsx (passthrough on save).
 */
export const DEFAULT_DOCUMENT_NEXT_NUMBER = 1;
