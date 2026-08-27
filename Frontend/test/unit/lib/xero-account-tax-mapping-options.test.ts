import { describe, expect, it } from 'vitest';
import {
  EMPTY_LINE_ITEM_MAPPING,
  accountClass,
  accountsForDocumentKind,
  buildDefaultLineItemMapping,
  isLineItemMappingEmpty,
  normalizeMapping,
  taxRatesForDocumentKind,
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

  it('taxRatesForDocumentKind filters by document kind and keeps a saved outlier', () => {
    expect(taxRatesForDocumentKind(TAX_RATES, 'invoice').map((r) => r.taxType)).toEqual([
      'OUTPUT',
    ]);
    expect(
      taxRatesForDocumentKind(TAX_RATES, 'purchaseOrder').map((r) => r.taxType)
    ).toEqual(['INPUT']);

    // Saved revenue tax on a PO mapping still appears so the dropdown can show it.
    expect(
      taxRatesForDocumentKind(TAX_RATES, 'purchaseOrder', 'OUTPUT').map((r) => r.taxType)
    ).toEqual(['INPUT', 'OUTPUT']);
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

  it('buildDefaultLineItemMapping matches the AU connect seed pair', () => {
    expect(buildDefaultLineItemMapping()).toEqual({
      quote: { accountCode: '200', taxType: 'EXEMPTOUTPUT', taxRatePercent: 0 },
      purchaseOrder: { accountCode: '310', taxType: 'EXEMPTEXPENSES', taxRatePercent: 0 },
      invoice: { accountCode: '200', taxType: 'EXEMPTOUTPUT', taxRatePercent: 0 },
      quoteOverrides: {
        quoteService: EMPTY_DOC,
        material: EMPTY_DOC,
      },
    });
    expect(isLineItemMappingEmpty(EMPTY_LINE_ITEM_MAPPING)).toBe(true);
    expect(isLineItemMappingEmpty(buildDefaultLineItemMapping())).toBe(false);
  });
});
