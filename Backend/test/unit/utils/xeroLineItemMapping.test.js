import { describe, it, expect } from 'vitest';
import {
  isGstApplied,
  normalizeLineItemMapping,
  pickGstValue,
  resolveLineItemTax,
  resolveSalesLineMapping,
  lookupTaxRatePercent,
  inferTaxRatePercentFromTaxType,
  enrichMappingWithTaxRatePercents,
  XERO_TAX_FREE_DEFAULTS,
} from '../../../src/utils/xeroLineItemMapping.js';

describe('xeroLineItemMapping', () => {
  it('isGstApplied recognizes 10%', () => {
    expect(isGstApplied('10%')).toBe(true);
    expect(isGstApplied('0%')).toBe(false);
    expect(isGstApplied('GST Free')).toBe(false);
    expect(isGstApplied(undefined)).toBe(false);
  });

  it('normalizeLineItemMapping cleans doc types and quote overrides', () => {
    const normalized = normalizeLineItemMapping({
      quote: { accountCode: ' 200 ', taxType: 'OUTPUT', taxRatePercent: 10 },
      invoice: { accountCode: 123 },
      quoteOverrides: {
        material: { accountCode: ' 260 ', taxType: ' OUTPUT ' },
      },
    });

    expect(normalized.quote).toEqual({
      accountCode: '200',
      taxType: 'OUTPUT',
      taxRatePercent: 10,
    });
    expect(normalized.invoice.taxRatePercent).toBeNull();
  });

  it('resolveLineItemTax prefers mapped Tax Rate (taxType) over board GST', () => {
    const business = {
      xeroLineItemMapping: {
        invoice: {
          accountCode: '260',
          taxType: 'OUTPUT',
          taxRatePercent: 10,
        },
      },
    };

    expect(resolveLineItemTax(business, 'invoice', 'GST Free')).toEqual({
      accountCode: '260',
      taxType: 'OUTPUT',
    });
  });

  it('resolveLineItemTax uses board GST when mapping taxType is unset', () => {
    expect(resolveLineItemTax({}, 'invoice', '10%')).toEqual({
      accountCode: undefined,
      taxType: 'OUTPUT',
    });
    expect(resolveLineItemTax({}, 'invoice', 'GST Free')).toEqual({
      accountCode: undefined,
      taxType: 'EXEMPTOUTPUT',
    });
    expect(resolveLineItemTax({}, 'invoice', '0%')).toEqual({
      accountCode: undefined,
      taxType: 'EXEMPTOUTPUT',
    });
    expect(resolveLineItemTax({}, 'purchaseOrder', 'GST Free')).toEqual({
      accountCode: undefined,
      taxType: 'EXEMPTEXPENSES',
    });
  });

  it('resolveLineItemTax applies quoteOverrides.material only for quotes', () => {
    const business = {
      xeroLineItemMapping: {
        invoice: { accountCode: '200', taxType: 'OUTPUT' },
        quote: { accountCode: '200', taxType: 'OUTPUT' },
        quoteOverrides: {
          material: { accountCode: '260', taxType: 'EXEMPTOUTPUT' },
        },
      },
    };

    expect(resolveLineItemTax(business, 'invoice', '10%', 'material')).toEqual({
      accountCode: '200',
      taxType: 'OUTPUT',
    });
    expect(resolveLineItemTax(business, 'quote', '10%', 'material')).toEqual({
      accountCode: '260',
      taxType: 'EXEMPTOUTPUT',
    });
  });

  it('lookupTaxRatePercent reads EffectiveRate from Xero options', () => {
    expect(
      lookupTaxRatePercent(
        [{ taxType: 'OUTPUT', effectiveRate: 10 }],
        'OUTPUT'
      )
    ).toBe(10);
    expect(inferTaxRatePercentFromTaxType('EXEMPTOUTPUT')).toBe(0);
    expect(inferTaxRatePercentFromTaxType('OUTPUT')).toBe(10);
  });

  it('enrichMappingWithTaxRatePercents fills missing percents from tax rates', () => {
    const enriched = enrichMappingWithTaxRatePercents(
      {
        invoice: { accountCode: '260', taxType: 'OUTPUT' },
      },
      [{ taxType: 'OUTPUT', effectiveRate: 10 }]
    );
    expect(enriched.invoice.taxRatePercent).toBe(10);
  });

  it('pickGstValue prefers first non-empty candidate', () => {
    expect(pickGstValue(null, '', '  ', 'GST Free')).toBe('GST Free');
  });

  it('resolveSalesLineMapping uses mapping then account-type then default', () => {
    const accounts = [
      { Type: 'EXPENSE', Code: '400' },
      { Type: 'REVENUE', Code: '210' },
    ];
    expect(
      resolveSalesLineMapping(
        {
          xeroLineItemMapping: {
            invoice: {
              accountCode: '260',
              taxType: 'OUTPUT',
            },
          },
        },
        'invoice',
        'GST Free',
        accounts
      )
    ).toEqual({ accountCode: '260', taxType: 'OUTPUT' });

    expect(
      resolveSalesLineMapping({}, 'invoice', 'GST Free', accounts)
    ).toEqual({ accountCode: '210', taxType: 'EXEMPTOUTPUT' });
  });

  it('resolveSalesLineMapping does not invent revenue 200 for purchase orders', () => {
    expect(
      resolveSalesLineMapping(
        {},
        'purchaseOrder',
        '10%',
        [{ Type: 'REVENUE', Code: '200' }],
        undefined,
        { fallbackAccountType: 'EXPENSE', defaultAccountCode: undefined }
      )
    ).toEqual({ accountCode: undefined, taxType: 'INPUT' });

    expect(
      resolveSalesLineMapping(
        {},
        'purchaseOrder',
        '10%',
        [{ Type: 'EXPENSE', Code: '400' }],
        undefined,
        { fallbackAccountType: 'EXPENSE', defaultAccountCode: undefined }
      )
    ).toEqual({ accountCode: '400', taxType: 'INPUT' });
  });

  it('exports tax-free defaults for invoice and purchaseOrder', () => {
    expect(XERO_TAX_FREE_DEFAULTS.invoice).toBe('EXEMPTOUTPUT');
    expect(XERO_TAX_FREE_DEFAULTS.purchaseOrder).toBe('EXEMPTEXPENSES');
    expect(XERO_TAX_FREE_DEFAULTS.quote).toBe('EXEMPTOUTPUT');
  });
});
