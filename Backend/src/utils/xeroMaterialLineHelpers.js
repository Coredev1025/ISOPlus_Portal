import { resolveSalesLineMapping } from './xeroLineItemMapping.js';

export const PAYABLE_MATERIAL_FEE_FIELD = 'Payable Material Fee($) - GST Excl.';

export function getPayableMaterialFeeAmount(values) {
  const amount = Number(values?.[PAYABLE_MATERIAL_FEE_FIELD] ?? 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

export function resolveMaterialSalesLine(business, docType, gstValue, accounts) {
  return resolveSalesLineMapping(business, docType, gstValue, accounts, 'material');
}

export function buildUsedMaterialLineItem(amount, materialLineTax, fallbackAccountCode) {
  return {
    description: 'Used Material/Part',
    quantity: 1,
    unitAmount: amount,
    taxType: materialLineTax.taxType,
    accountCode: materialLineTax.accountCode || fallbackAccountCode,
  };
}
