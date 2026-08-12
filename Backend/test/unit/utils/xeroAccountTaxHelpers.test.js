import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/xero.js', () => ({
  getAccounts: vi.fn(),
  getTaxRates: vi.fn(),
  isAccountTaxRateMatched: vi.fn(),
}));

vi.mock('../../../src/services/isoplus.js', () => ({
  setIntegrationMessage: vi.fn(),
}));

import { getAccounts, getTaxRates, isAccountTaxRateMatched } from '../../../src/services/xero.js';
import { setIntegrationMessage } from '../../../src/services/isoplus.js';
import {
  ACCOUNT_TAX_MISMATCH_RESPONSE,
  loadXeroChartOptions,
  rejectIfAccountTaxMismatch,
} from '../../../src/utils/xeroAccountTaxHelpers.js';

describe('loadXeroChartOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads accounts then tax rates sequentially', async () => {
    const order = [];
    getAccounts.mockImplementation(async () => {
      order.push('accounts');
      return [{ Code: '200' }];
    });
    getTaxRates.mockImplementation(async () => {
      order.push('taxRates');
      return [{ TaxType: 'OUTPUT' }];
    });

    const chart = await loadXeroChartOptions('ws-1');
    expect(order).toEqual(['accounts', 'taxRates']);
    expect(chart).toEqual({
      accounts: [{ Code: '200' }],
      taxRates: [{ TaxType: 'OUTPUT' }],
    });
  });
});

describe('rejectIfAccountTaxMismatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when accountCode is missing', async () => {
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };

    const result = await rejectIfAccountTaxMismatch({
      workspaceId: 'ws-1',
      boardId: 'board-1',
      itemId: 'item-1',
      accountCode: undefined,
      taxType: 'OUTPUT',
      res,
      chart: { accounts: [], taxRates: [] },
    });

    expect(setIntegrationMessage).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      message: 'Account code is required. Configure account mapping in Finance Settings.',
    });
    expect(result).toBe(true);
  });

  it('returns null when chart match passes', async () => {
    isAccountTaxRateMatched.mockResolvedValue(true);
    const res = { status: vi.fn() };

    const result = await rejectIfAccountTaxMismatch({
      workspaceId: 'ws-1',
      boardId: 'board-1',
      itemId: 'item-1',
      accountCode: '200',
      taxType: 'OUTPUT',
      res,
      chart: { accounts: [], taxRates: [] },
    });

    expect(result).toBeNull();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns soft mismatch response when rates conflict', async () => {
    isAccountTaxRateMatched.mockResolvedValue(false);
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };

    const result = await rejectIfAccountTaxMismatch({
      workspaceId: 'ws-1',
      boardId: 'board-1',
      itemId: 'item-1',
      accountCode: '200',
      taxType: 'INPUT',
      res,
      chart: { accounts: [], taxRates: [] },
    });

    expect(json).toHaveBeenCalledWith(ACCOUNT_TAX_MISMATCH_RESPONSE);
    expect(result).toBe(true);
  });
});
