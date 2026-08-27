/**
 * Default Xero account codes and tax types. Persisted on Business.xeroLineItemMapping
 * when a workspace connects to Xero (empty mapping only). Also used as Select
 * option filters on the frontend.
 *
 * Touchpoints: lib/xero-account-tax-mapping-options.ts, Backend/src/constants/xeroMapping.js
 */
export const XERO_DEFAULT_SALES_ACCOUNT_CODE = "200";
export const XERO_DEFAULT_COGS_ACCOUNT_CODE = "310";
export const XERO_DEFAULT_INCOME_TAX_TYPE = "EXEMPTOUTPUT";
export const XERO_DEFAULT_EXPENSE_TAX_TYPE = "EXEMPTEXPENSES";
export const XERO_DEFAULT_TAX_RATE_PERCENT = 0;
