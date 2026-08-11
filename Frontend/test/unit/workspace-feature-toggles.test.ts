import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/app/utils/axiosConfig', () => ({
  default: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));

import axios from '@/app/utils/axiosConfig';
import {
  fetchWorkspaceFeatureToggles,
  saveWorkspaceFeatureToggles,
  fetchInvoiceStatementAutomationFlag,
} from '@/lib/workspace-feature-toggles';

describe('workspace-feature-toggles (Epic 2 / KAN-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:3001';
  });

  it('fetchWorkspaceFeatureToggles GETs the feature-toggles API and coerces the flag', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { invoiceStatementAutomation: 1 },
    });

    await expect(fetchWorkspaceFeatureToggles('ws-abc')).resolves.toEqual({
      invoiceStatementAutomation: true,
    });

    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:3001/api/workspaces/ws-abc/feature-toggles'
    );
  });

  it('fetchWorkspaceFeatureToggles defaults missing flag to false', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} });

    await expect(fetchWorkspaceFeatureToggles('ws-1')).resolves.toEqual({
      invoiceStatementAutomation: false,
    });
  });

  it('saveWorkspaceFeatureToggles PUTs the boolean and returns the coerced response', async () => {
    (axios.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { invoiceStatementAutomation: true },
    });

    await expect(saveWorkspaceFeatureToggles('ws-2', true)).resolves.toEqual({
      invoiceStatementAutomation: true,
    });

    expect(axios.put).toHaveBeenCalledWith(
      'http://localhost:3001/api/workspaces/ws-2/feature-toggles',
      { invoiceStatementAutomation: true }
    );
  });

  it('fetchInvoiceStatementAutomationFlag reads business profile featureToggles', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        name: 'Acme',
        featureToggles: { invoiceStatementAutomation: true },
      },
    });

    await expect(fetchInvoiceStatementAutomationFlag('ws-3')).resolves.toBe(true);
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:3001/api/business/profile',
      { params: { workspaceId: 'ws-3' } }
    );
  });

  it('fetchInvoiceStatementAutomationFlag returns false when the profile call fails', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'));

    await expect(fetchInvoiceStatementAutomationFlag('ws-4')).resolves.toBe(false);
  });

  it('fetchInvoiceStatementAutomationFlag returns false when featureToggles is absent', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { name: 'Acme' },
    });

    await expect(fetchInvoiceStatementAutomationFlag('ws-5')).resolves.toBe(false);
  });
});
