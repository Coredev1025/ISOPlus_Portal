/**
 * ISO+ defaults when Account code is not mapped in Finance Settings.
 *
 * Touchpoints: utils/xeroLineItemMapping.js
 * Keep in sync with Frontend/constants/xeroMapping.ts
 */
export const XERO_DEFAULT_ACCOUNT_CODES = {
  quote: '200',
  purchaseOrder: '310',
  invoice: '200',
};
