import { describe, expect, it } from 'vitest';
import {
  EMPTY_LINE_ITEM_MAPPING,
  accountClass,
  normalizeMapping,
  prepareMappingForSave,
  taxRatesForAccount,
  type XeroAccountOption,
  type XeroTaxRateOption,
} from '@/lib/xero-account-tax-mapping-options';

const REVENUE_ACCOUNT: XeroAccountOption = {
  code: '200',
  name: 'Sales',
  type: 'REVENUE',
  class: 'REVENUE',
  status: 'ACTIVE',
};

const EXPENSE_ACCOUNT: XeroAccountOption = {
  code: '400',
  name: 'Purchases',
  type: 'EXPENSE',
  class: 'EXPENSE',
  status: 'ACTIVE',
};

const TAX_RATES: XeroTaxRateOption[] = [
  {
    taxType: 'OUTPUT',
    name: 'GST on Income',
    status: 'ACTIVE',
    canApplyToRevenue: true,
    canApplyToExpenses: false,
    effectiveRate: 10,
  },
  {
    taxType: 'INPUT',
    name: 'GST on Expenses',
    status: 'ACTIVE',
    canApplyToRevenue: false,
    canApplyToExpenses: true,
    effectiveRate: 10,
  },
];

describe('xero-account-tax-mapping-options', () => {
  it('normalizeMapping fills empty docs and ignores non-finite rates', () => {
    expect(normalizeMapping(undefined)).toEqual(EMPTY_LINE_ITEM_MAPPING);
    expect(
      normalizeMapping({
        quote: { accountCode: '200', taxType: 'OUTPUT', taxRatePercent: Number.NaN },
        quoteOverrides: { material: { accountCode: '400' } },
      })
    ).toEqual({
      quote: { accountCode: '200', taxType: 'OUTPUT', taxRatePercent: null },
      purchaseOrder: { accountCode: '', taxType: '', taxRatePercent: null },
      invoice: { accountCode: '', taxType: '', taxRatePercent: null },
      quoteOverrides: {
        quoteService: { accountCode: '', taxType: '', taxRatePercent: null },
        material: { accountCode: '400', taxType: '', taxRatePercent: null },
      },
    });
  });

  it('accountClass uppercases the Xero account class', () => {
    expect(accountClass(REVENUE_ACCOUNT)).toBe('REVENUE');
    expect(accountClass({ ...REVENUE_ACCOUNT, class: 'expense' })).toBe('EXPENSE');
  });

  it('taxRatesForAccount filters by revenue vs expense applicability', () => {
    expect(taxRatesForAccount(TAX_RATES, undefined)).toEqual([]);
    expect(taxRatesForAccount(TAX_RATES, REVENUE_ACCOUNT).map((r) => r.taxType)).toEqual([
      'OUTPUT',
    ]);
    expect(taxRatesForAccount(TAX_RATES, EXPENSE_ACCOUNT).map((r) => r.taxType)).toEqual([
      'INPUT',
    ]);
  });

  it('prepareMappingForSave round-trips through normalizeMapping', () => {
    const mapping = normalizeMapping({
      invoice: { accountCode: '200', taxType: 'OUTPUT', taxRatePercent: 10 },
    });
    expect(prepareMappingForSave(mapping)).toEqual(mapping);
  });
});
