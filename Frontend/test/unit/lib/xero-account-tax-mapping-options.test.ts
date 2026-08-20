import { describe, expect, it } from 'vitest';
import {
  EMPTY_LINE_ITEM_MAPPING,
  accountClass,
  accountsForDocumentKind,
  displayAccountPlaceholder,
  displayTaxPlaceholder,
  normalizeMapping,
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

const EMPTY_DOC = { accountCode: '', taxType: '', taxRatePercent: null };

describe('xero-account-tax-mapping-options', () => {
  it('keeps unmapped docs empty instead of filling Sales 200 / OUTPUT', () => {
    expect(EMPTY_LINE_ITEM_MAPPING).toEqual({
      quote: EMPTY_DOC,
      purchaseOrder: EMPTY_DOC,
      invoice: EMPTY_DOC,
      quoteOverrides: {
        quoteService: EMPTY_DOC,
        material: EMPTY_DOC,
      },
    });
    expect(normalizeMapping(undefined)).toEqual(EMPTY_LINE_ITEM_MAPPING);
  });

  it('normalizeMapping trims selected values and leaves unspecified fields empty', () => {
    expect(
      normalizeMapping({
        quote: { accountCode: '200', taxType: 'OUTPUT', taxRatePercent: Number.NaN },
        quoteOverrides: { material: { accountCode: '400' } },
      })
    ).toEqual({
      quote: { accountCode: '200', taxType: 'OUTPUT', taxRatePercent: null },
      purchaseOrder: EMPTY_DOC,
      invoice: EMPTY_DOC,
      quoteOverrides: {
        quoteService: EMPTY_DOC,
        material: { accountCode: '400', taxType: '', taxRatePercent: null },
      },
    });
  });

  it('normalizeMapping keeps a cleared quote override empty', () => {
    const mapping = normalizeMapping({
      quote: { accountCode: '200', taxType: 'OUTPUT' },
      quoteOverrides: {
        quoteService: { accountCode: '', taxType: '' },
      },
    });
    expect(normalizeMapping(mapping).quoteOverrides.quoteService).toEqual(EMPTY_DOC);
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

  // Epic 4.5 — Quote/Invoice prefer REVENUE; Purchase Order prefers EXPENSE.
  it('accountsForDocumentKind filters by document kind and keeps a saved outlier', () => {
    const accounts = [REVENUE_ACCOUNT, EXPENSE_ACCOUNT];

    expect(accountsForDocumentKind(accounts, 'quote').map((a) => a.code)).toEqual([
      '200',
    ]);
    expect(accountsForDocumentKind(accounts, 'invoice').map((a) => a.code)).toEqual([
      '200',
    ]);
    expect(
      accountsForDocumentKind(accounts, 'purchaseOrder').map((a) => a.code)
    ).toEqual(['400']);

    // Saved expense code on a quote still appears so the dropdown can show it.
    expect(
      accountsForDocumentKind(accounts, 'quote', '400').map((a) => a.code)
    ).toEqual(['200', '400']);
  });

  it('normalizeMapping round-trips a saved mapping payload', () => {
    const mapping = normalizeMapping({
      invoice: { accountCode: '200', taxType: 'OUTPUT', taxRatePercent: 10 },
    });
    expect(normalizeMapping(mapping)).toEqual(mapping);
  });

  it('normalizeMapping does not persist display defaults on a no-op save', () => {
    expect(normalizeMapping(undefined)).toEqual(EMPTY_LINE_ITEM_MAPPING);
  });

  it('exposes AU demo codes as placeholders only', () => {
    expect(displayAccountPlaceholder('invoice')).toBe('200 (default)');
    expect(displayAccountPlaceholder('purchaseOrder')).toBe('310 (default)');
    expect(displayTaxPlaceholder('invoice')).toBe('OUTPUT (default)');
    expect(displayTaxPlaceholder('purchaseOrder')).toBe('INPUT (default)');
  });
});
