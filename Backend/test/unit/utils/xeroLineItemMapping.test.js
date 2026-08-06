import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGstApplied,
  normalizeLineItemMapping,
  resolveLineItemTax,
} from '../../../src/utils/xeroLineItemMapping.js';

describe('xeroLineItemMapping', () => {
  it('isGstApplied recognizes 10%', () => {
    assert.equal(isGstApplied('10%'), true);
    assert.equal(isGstApplied('0%'), false);
    assert.equal(isGstApplied(undefined), false);
  });

  it('normalizeLineItemMapping cleans doc types and quote overrides', () => {
    const normalized = normalizeLineItemMapping({
      quote: { accountCode: ' 200 ', taxType: 'OUTPUT', taxFreeType: 'EXEMPTOUTPUT' },
      invoice: { accountCode: 123 },
      quoteOverrides: {
        material: { accountCode: ' 260 ', taxType: ' OUTPUT ' },
      },
    });

    assert.deepEqual(normalized.quote, {
      accountCode: '200',
      taxType: 'OUTPUT',
      taxFreeType: 'EXEMPTOUTPUT',
    });
    assert.deepEqual(normalized.invoice, {
      accountCode: '',
      taxType: '',
      taxFreeType: '',
    });
    assert.deepEqual(normalized.purchaseOrder, {
      accountCode: '',
      taxType: '',
      taxFreeType: '',
    });
    assert.deepEqual(normalized.quoteOverrides.material, {
      accountCode: '260',
      taxType: 'OUTPUT',
      taxFreeType: '',
    });
    assert.deepEqual(normalized.quoteOverrides.quoteService, {
      accountCode: '',
      taxType: '',
      taxFreeType: '',
    });
  });

  it('resolveLineItemTax uses doc mapping and GST defaults', () => {
    const business = {
      xeroLineItemMapping: {
        invoice: {
          accountCode: '200',
          taxType: 'OUTPUT',
          taxFreeType: 'EXEMPTOUTPUT',
        },
      },
    };

    assert.deepEqual(resolveLineItemTax(business, 'invoice', '10%'), {
      accountCode: '200',
      taxType: 'OUTPUT',
    });
    assert.deepEqual(resolveLineItemTax(business, 'invoice', '0%'), {
      accountCode: '200',
      taxType: 'EXEMPTOUTPUT',
    });
  });

  it('resolveLineItemTax prefers quote override then falls back', () => {
    const business = {
      xeroLineItemMapping: {
        quote: {
          accountCode: '200',
          taxType: 'OUTPUT',
          taxFreeType: 'EXEMPTOUTPUT',
        },
        quoteOverrides: {
          material: {
            accountCode: '260',
            taxType: 'OUTPUT',
            taxFreeType: 'EXEMPTOUTPUT',
          },
          quoteService: {
            accountCode: '',
            taxType: '',
            taxFreeType: '',
          },
        },
      },
    };

    assert.deepEqual(
      resolveLineItemTax(business, 'quote', '10%', 'material'),
      { accountCode: '260', taxType: 'OUTPUT' }
    );
    assert.deepEqual(
      resolveLineItemTax(business, 'quote', '10%', 'quoteService'),
      { accountCode: '200', taxType: 'OUTPUT' }
    );
  });
});
