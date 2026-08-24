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

    await expect(fetchInvoiceStatementAutomationFlag('ws-3')).resolves.toBe('on');
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:3001/api/business/profile',
      { params: { workspaceId: 'ws-3' } }
    );
  });

  it('fetchInvoiceStatementAutomationFlag returns off when featureToggles is absent', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { name: 'Acme' },
    });

    await expect(fetchInvoiceStatementAutomationFlag('ws-5')).resolves.toBe('off');
  });

  /**
   * The reproduction for the defect this replaced.
   *
   * Every failure used to collapse to `false`, which the tab gate reads as
   * "this workspace does not have the feature". A transient 503 on the profile
   * call therefore hid the Invoice & Statement Automation tab and rewrote
   * ?tab=automation to ?tab=financial, with nothing said. "The server did not
   * answer" and "the answer is no" have to stay distinguishable.
   */
  it.each([500, 502, 503, 504])(
    'fetchInvoiceStatementAutomationFlag reports %i as unavailable, not off',
    async (status) => {
      (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
        response: { status },
      });

      await expect(fetchInvoiceStatementAutomationFlag('ws-4')).resolves.toBe(
        'unavailable'
      );
    }
  );

  it('fetchInvoiceStatementAutomationFlag reports a network failure as unavailable', async () => {
    // No `response` at all — DNS, CORS, offline. Indistinguishable from a 5xx
    // as far as "we do not know" goes.
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'));

    await expect(fetchInvoiceStatementAutomationFlag('ws-4b')).resolves.toBe(
      'unavailable'
    );
  });

  /**
   * 4xx keeps the old behaviour deliberately. The profile may be genuinely
   * missing, or not readable by this user — both are a real answer of "not
   * available to you", not an outage, and must not leave a tab on screen that
   * the server will refuse.
   */
  it.each([401, 403, 404])(
    'fetchInvoiceStatementAutomationFlag treats %i as off',
    async (status) => {
      (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
        response: { status },
      });

      await expect(fetchInvoiceStatementAutomationFlag('ws-6')).resolves.toBe('off');
    }
  );
});
