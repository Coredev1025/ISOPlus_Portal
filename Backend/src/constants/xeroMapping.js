/**
 * ISO+ display defaults when Account code is not mapped in Finance Settings.
 * Persisted mapping stays empty unless the user selects a value; these codes
 * are placeholders only. The tenant chart is the runtime fallback.
 *
 * Touchpoints: Frontend/constants/xeroMapping.ts (keep in sync)
 */
export const XERO_DEFAULT_ACCOUNT_CODES = {
  quote: '200',
  purchaseOrder: '310',
  invoice: '200',
};
