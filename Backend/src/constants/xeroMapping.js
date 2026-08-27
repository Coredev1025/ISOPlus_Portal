/**
 * Default Xero account codes and tax types seeded onto Business.xeroLineItemMapping
 * when a workspace connects to Xero (empty mapping only — never overwrites a saved one).
 *
 * Touchpoints: utils/xeroLineItemMapping.js, utils/xeroConnectHelpers.js
 */
export const XERO_DEFAULT_SALES_ACCOUNT_CODE = '200';
export const XERO_DEFAULT_COGS_ACCOUNT_CODE = '310';
export const XERO_DEFAULT_INCOME_TAX_TYPE = 'EXEMPTOUTPUT';
export const XERO_DEFAULT_EXPENSE_TAX_TYPE = 'EXEMPTEXPENSES';
export const XERO_DEFAULT_TAX_RATE_PERCENT = 0;
