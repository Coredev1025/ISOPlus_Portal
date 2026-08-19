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

  it('does not let an empty stored mapping flip GST-free NDIS lines to OUTPUT', () => {
    expect(
      resolveLineItemTax(
        { xeroLineItemMapping: { invoice: { accountCode: '', taxType: '' } } },
        'invoice',
        'GST Free',
        undefined,
        { unmappedTaxFreeType: 'EXEMPTOUTPUT' }
      )
    ).toEqual({
      accountCode: undefined,
      taxType: 'EXEMPTOUTPUT',
    });
  });

  // This test used to assert the opposite — that a mapped taxType wins over the
  // line's own GST — and that expectation was the defect, not the guard.
  //
  // A Finance Settings mapping is a default for a DOCUMENT TYPE, and 'OUTPUT'
  // is the sensible thing to map a sales invoice to. Applying it to every line
  // meant NDIS supports whose own row reads 'GST Free' synced to Xero at 10%
  // GST: the client is over-charged, and the provider has charged GST on a
  // GST-free support. The account code is still the mapped one — only the tax
  // rate is corrected.
  it('resolveLineItemTax will not charge GST on a line the board says is GST-free', () => {
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
      taxType: 'EXEMPTOUTPUT',
    });
    // The same mapping is still exactly right for a taxable line.
    expect(resolveLineItemTax(business, 'invoice', '10%')).toEqual({
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
      // Mapped account code, corrected tax rate: see the GST-free case above.
    ).toEqual({ accountCode: '260', taxType: 'EXEMPTOUTPUT' });

    expect(
      resolveSalesLineMapping({}, 'invoice', 'GST Free', accounts)
    ).toEqual({ accountCode: '210', taxType: 'EXEMPTOUTPUT' });
  });

  it('does not invent revenue 200 for purchase orders — uses the tenant chart', () => {
    expect(
      resolveSalesLineMapping(
        {},
        'purchaseOrder',
        '10%',
        [
          { Type: 'REVENUE', Code: '200' },
          { Type: 'EXPENSE', Code: '400' },
        ],
        undefined,
        { fallbackAccountType: 'EXPENSE' }
      )
    ).toEqual({ accountCode: '400', taxType: 'INPUT' });
  });

  it('does not invent COGS 310 when the chart has no expense account', () => {
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
  });

  it('exports tax-free defaults for invoice and purchaseOrder', () => {
    expect(XERO_TAX_FREE_DEFAULTS.invoice).toBe('EXEMPTOUTPUT');
    expect(XERO_TAX_FREE_DEFAULTS.purchaseOrder).toBe('EXEMPTEXPENSES');
    expect(XERO_TAX_FREE_DEFAULTS.quote).toBe('EXEMPTOUTPUT');
  });
});

/**
 * The one-directional GST correction, on its own.
 *
 * A mapped taxType is honoured everywhere it can be true of the line. The one
 * case it cannot is a line the board explicitly marks GST-free being sent at a
 * rate above zero — inventing GST the client does not owe. The reverse (a
 * zero-rated mapping on a taxable line) is deliberately left alone, because
 * `quoteOverrides.material` exists to make exactly that choice.
 */
describe('resolveLineItemTax and the line\'s own GST', () => {
  const mapped = (taxType, taxRatePercent) => ({
    xeroLineItemMapping: { invoice: { accountCode: '260', taxType, taxRatePercent } },
  });

  it.each(['GST Free', '0%', 'Exempt', 'N/A'])(
    'replaces a taxable mapping on a %j line with the tax-free default',
    (gstValue) => {
      expect(resolveLineItemTax(mapped('OUTPUT', 10), 'invoice', gstValue).taxType)
        .toBe('EXEMPTOUTPUT');
    },
  );

  it('honours options.unmappedTaxFreeType when it corrects one, as the NDIS path sets', () => {
    expect(
      resolveLineItemTax(mapped('OUTPUT', 10), 'invoice', 'GST Free', undefined, {
        unmappedTaxFreeType: 'BASEXCLUDED',
      }).taxType,
    ).toBe('BASEXCLUDED');
  });

  it('uses the purchase-order tax-free default for a purchase order', () => {
    const business = {
      xeroLineItemMapping: { purchaseOrder: { accountCode: '400', taxType: 'INPUT', taxRatePercent: 10 } },
    };

    expect(resolveLineItemTax(business, 'purchaseOrder', 'GST Free'))
      .toEqual({ accountCode: '400', taxType: 'EXEMPTEXPENSES' });
  });

  it('leaves a zero-rated mapping in place on a GST-free line', () => {
    expect(resolveLineItemTax(mapped('EXEMPTOUTPUT', 0), 'invoice', 'GST Free').taxType)
      .toBe('EXEMPTOUTPUT');
  });

  // Under-charging is also wrong, but it is a choice someone made explicitly —
  // and quoteOverrides.material is the feature that makes it. Correcting this
  // direction would break a configured behaviour; refusing to invent GST cannot.
  it('does not add GST to a taxable line whose mapping is zero-rated', () => {
    expect(resolveLineItemTax(mapped('EXEMPTOUTPUT', 0), 'invoice', '10%').taxType)
      .toBe('EXEMPTOUTPUT');
  });

  // A blank GST value is no evidence, not evidence of exemption.
  it.each([undefined, null, '', '   '])('leaves the mapping alone for a %j GST value', (gstValue) => {
    expect(resolveLineItemTax(mapped('OUTPUT', 10), 'invoice', gstValue).taxType).toBe('OUTPUT');
  });

  // The stored percentage is authoritative — it was read from Xero's own tax
  // rates when the mapping was saved, so a custom code with a real rate is
  // judged on that rate rather than on how its name looks.
  it('judges a custom tax type by its stored rate', () => {
    expect(resolveLineItemTax(mapped('GSTONIMPORTS', 10), 'invoice', 'GST Free').taxType)
      .toBe('EXEMPTOUTPUT');
    expect(resolveLineItemTax(mapped('CAPEXINPUT', 0), 'invoice', 'GST Free').taxType)
      .toBe('CAPEXINPUT');
  });

  // With neither a stored rate nor an inferrable one there is nothing to judge,
  // and a wrong guess about somebody's custom Xero tax type is worse than
  // honouring what they configured.
  it('honours a custom tax type whose rate is unknown', () => {
    expect(resolveLineItemTax(mapped('SOMECUSTOMRATE', null), 'invoice', 'GST Free').taxType)
      .toBe('SOMECUSTOMRATE');
  });

  it('falls back to the inferred rate when none was stored', () => {
    expect(resolveLineItemTax(mapped('OUTPUT2', null), 'invoice', 'GST Free').taxType)
      .toBe('EXEMPTOUTPUT');
  });

  // The correction reaches the quote override too — it is a mapping like any
  // other, and a material line marked GST-free must not be sent at 10%.
  it('corrects a quote override that would charge GST on a GST-free line', () => {
    const business = {
      xeroLineItemMapping: {
        quote: { accountCode: '200', taxType: 'EXEMPTOUTPUT', taxRatePercent: 0 },
        quoteOverrides: { material: { accountCode: '260', taxType: 'OUTPUT', taxRatePercent: 10 } },
      },
    };

    expect(resolveLineItemTax(business, 'quote', 'GST Free', 'material'))
      .toEqual({ accountCode: '260', taxType: 'EXEMPTOUTPUT' });
  });
});
