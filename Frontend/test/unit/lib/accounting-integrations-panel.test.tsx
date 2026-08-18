import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  default: (props: { alt: string }) => <img alt={props.alt} />,
}));

vi.mock('@/app/utils/axiosConfig', () => ({
  default: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('@/lib/toast-utils', () => ({
  showFetchErrorToast: vi.fn(),
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
  showSaveErrorToast: vi.fn(),
  showSaveSuccessToast: vi.fn(),
}));

import axios from '@/app/utils/axiosConfig';
import { AccountingIntegrationsPanel } from '@/lib/accounting-integrations-panel';
import { showFetchErrorToast } from '@/lib/toast-utils';

describe('AccountingIntegrationsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:3001';
  });

  afterEach(() => {
    cleanup();
  });

  it('shows loading then connected Xero UI from the business profile', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (String(url).includes('account-tax-options')) {
        return Promise.resolve({ data: { accounts: [], taxRates: [] } });
      }
      return Promise.resolve({
        data: {
          xeroIntegrated: true,
          xeroLineItemMapping: {
            invoice: { accountCode: '200', taxType: 'OUTPUT', taxRatePercent: 10 },
          },
        },
      });
    });

    render(<AccountingIntegrationsPanel workspaceId="ws-1" />);

    expect(screen.getByText(/loading accounting integrations/i)).toBeInTheDocument();
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    expect(screen.getByText(/default account & tax mapping/i)).toBeInTheDocument();
  });

  it('shows not connected when Xero is not integrated', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { xeroIntegrated: false },
    });

    render(<AccountingIntegrationsPanel workspaceId="ws-1" />);

    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect xero/i })).toBeInTheDocument();
  });

  // Epic 4.1 — provider shell at full tab width (no nested max-width wrapper).
  it('renders the Accounting Integrations shell with Xero / MYOB / QuickBooks sub-tabs', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { xeroIntegrated: false },
    });

    render(<AccountingIntegrationsPanel workspaceId="ws-1" />);

    expect(
      await screen.findByRole('heading', { name: 'Accounting Integrations' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^xero$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^xero$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /myob/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /quickbooks/i })).toBeInTheDocument();
  });

  // Epic 4.2 — Connect / Test Connection live in this layout (no behaviour change).
  it('exposes Connect Xero and Test Connection after profile load', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { xeroIntegrated: false },
    });

    render(<AccountingIntegrationsPanel workspaceId="ws-1" />);

    expect(
      await screen.findByRole('button', { name: /connect xero/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /test connection/i })
    ).toBeInTheDocument();
  });

  // Epic 4.3 — sync toggles visible but disabled.
  it('shows the four sync toggles disabled after profile load', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { xeroIntegrated: false },
    });

    render(<AccountingIntegrationsPanel workspaceId="ws-1" />);

    expect(await screen.findByText('Invoice Sync Status')).toBeInTheDocument();
    expect(screen.getByText('Customer Sync Status')).toBeInTheDocument();
    expect(screen.getByText('Payment Sync Status')).toBeInTheDocument();
    expect(screen.getByText('Contact Sync')).toBeInTheDocument();

    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(4);
    for (const toggle of switches) {
      expect(toggle).toBeDisabled();
      expect(toggle).not.toBeChecked();
    }
  });

  // Epic 4.4 — MYOB / QuickBooks stay inactive.
  it('keeps MYOB and QuickBooks sub-tabs disabled', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { xeroIntegrated: false },
    });

    render(<AccountingIntegrationsPanel workspaceId="ws-1" />);

    expect(await screen.findByRole('button', { name: /myob/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /quickbooks/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^xero$/i })).not.toBeDisabled();
  });

  it('toasts when profile load fails', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      name: 'Error',
      response: { status: 500, data: { message: 'nope' } },
    });

    render(<AccountingIntegrationsPanel workspaceId="ws-1" />);

    await waitFor(() => {
      expect(showFetchErrorToast).toHaveBeenCalledWith(
        'accounting integration settings',
        'nope'
      );
    });
  });

  it('does not toast Not Found when the business profile is missing', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      name: 'Error',
      response: { status: 404, data: { message: 'Business not found' } },
    });

    render(<AccountingIntegrationsPanel workspaceId="ws-1" />);

    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect xero/i })).toBeInTheDocument();
    expect(showFetchErrorToast).not.toHaveBeenCalled();
  });

  it('toasts when loading accounting settings times out', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'ECONNABORTED',
      message: 'timeout of 15000ms exceeded',
    });

    render(<AccountingIntegrationsPanel workspaceId="ws-1" />);

    await waitFor(() => {
      expect(showFetchErrorToast).toHaveBeenCalledWith(
        'accounting integration settings',
        expect.stringMatching(/timed out/i)
      );
    });
  });

  it('offers a button to open Xero logs after profile load, not an inline log table', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (String(url).includes('/api/audit')) {
        return Promise.resolve({
          data: {
            items: [
              {
                createdAt: '2026-08-01T00:00:00.000Z',
                action: 'Connected Xero',
                detail: 'Linked organisation Acme',
                userEmail: 'owner@example.com',
                success: true,
                category: 'Xero',
              },
            ],
            total: 1,
            page: 1,
            totalPages: 1,
          },
        });
      }
      return Promise.resolve({ data: { xeroIntegrated: false } });
    });

    render(<AccountingIntegrationsPanel workspaceId="ws-1" />);

    const logsButton = await screen.findByRole('button', { name: /view xero logs/i });
    const testConnection = screen.getByRole('button', { name: /test connection/i });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Linked organisation Acme')).not.toBeInTheDocument();

    expect(testConnection.parentElement).toBe(logsButton.parentElement);
    expect(
      testConnection.compareDocumentPosition(logsButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
