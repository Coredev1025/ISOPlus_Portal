import { describe, expect, it } from 'vitest';
import {
  PAYABLE_MATERIAL_FEE_FIELD,
  buildUsedMaterialLineItem,
  getPayableMaterialFeeAmount,
} from '../../../src/utils/xeroMaterialLineHelpers.js';

describe('xeroMaterialLineHelpers', () => {
  it('reads payable material fee amount when positive', () => {
    expect(
      getPayableMaterialFeeAmount({ [PAYABLE_MATERIAL_FEE_FIELD]: 25 })
    ).toBe(25);
    expect(
      getPayableMaterialFeeAmount({ [PAYABLE_MATERIAL_FEE_FIELD]: 0 })
    ).toBe(0);
    expect(getPayableMaterialFeeAmount({})).toBe(0);
  });

  it('builds Used Material/Part line with fallback account', () => {
    expect(
      buildUsedMaterialLineItem(
        12.5,
        { taxType: 'OUTPUT', accountCode: '' },
        '200'
      )
    ).toEqual({
      description: 'Used Material/Part',
      quantity: 1,
      unitAmount: 12.5,
      taxType: 'OUTPUT',
      accountCode: '200',
    });
  });
});
