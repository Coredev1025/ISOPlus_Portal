/**
 * The document series whose first number the user chooses, once, the first time
 * Finance Settings is saved (KAN-292), with the label used in messages and an
 * example shown as the placeholder. Statement (STM-) is not in it: monthly
 * statement automation owns that series.
 *
 * Mirrors INITIAL_NUMBER_SERIES in Backend/src/constants/documentNumbering.js;
 * keep the two in step.
 *
 * Touchpoints: lib/financial-settings-form.tsx,
 * lib/financial-settings-numbering-helpers.ts, lib/financial-settings-panel.tsx.
 */
export const INITIAL_NUMBER_SERIES = [
  { type: "invoice", label: "Invoice", example: 1001 },
  { type: "purchaseOrder", label: "Purchase Order", example: 101 },
  { type: "quote", label: "Quote", example: 501 },
  { type: "statementOfAccount", label: "Statement of Account", example: 1 },
] as const;

export type InitialNumberSeriesType =
  (typeof INITIAL_NUMBER_SERIES)[number]["type"];
