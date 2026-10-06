import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/utils/axiosConfig', () => ({
  default: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));

vi.mock('@/lib/toast-utils', () => ({
  showErrorToast: vi.fn(),
  showSaveErrorToast: vi.fn(),
  showSaveSuccessToast: vi.fn(),
}));

import axios from '@/app/utils/axiosConfig';
import {
  EMPTY_LINE_ITEM_MAPPING,
  XeroAccountTaxMapping,
} from '@/lib/xero-account-tax-mapping';
import { buildDefaultLineItemMapping } from '@/lib/xero-account-tax-mapping-options';
import { showErrorToast, showSaveErrorToast, showSaveSuccessToast } from '@/lib/toast-utils';

const OPTIONS = {
  accounts: [
    {
      code: '200',
      name: 'Sales',
      type: 'REVENUE',
      class: 'REVENUE',
      status: 'ACTIVE',
    },
    {
      code: '310',
      name: 'Cost of Goods Sold',
      type: 'EXPENSE',
      class: 'EXPENSE',
      status: 'ACTIVE',
    },
  ],
  taxRates: [
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
    {
      taxType: 'EXEMPTOUTPUT',
      name: 'GST Free Income',
      status: 'ACTIVE',
      canApplyToRevenue: true,
      canApplyToExpenses: false,
      effectiveRate: 0,
    },
    {
      taxType: 'EXEMPTEXPENSES',
      name: 'GST Free Expenses',
      status: 'ACTIVE',
      canApplyToRevenue: false,
      canApplyToExpenses: true,
      effectiveRate: 0,
    },
  ],
};

describe('XeroAccountTaxMapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:3001';
  });

  afterEach(() => {
    cleanup();
  });

  it('prompts to connect when disconnected', () => {
    render(
      <XeroAccountTaxMapping
        workspaceId="ws-1"
        isConnected={false}
        initialMapping={EMPTY_LINE_ITEM_MAPPING}
        onMappingSaved={vi.fn()}
      />
    );

    expect(
      screen.getByText(/connect to xero to load accounts and tax rates/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Mapping' })).toBeDisabled();
  });

  it('loads options when connected and saves mapping', async () => {
    const user = userEvent.setup();
    const onMappingSaved = vi.fn();
    const initial = buildDefaultLineItemMapping();
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: OPTIONS });
    (axios.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        xeroLineItemMapping: {
          ...initial,
          invoice: { accountCode: '200', taxType: 'OUTPUT', taxRatePercent: 10 },
        },
      },
    });

    render(
      <XeroAccountTaxMapping
        workspaceId="ws-1"
        isConnected
        initialMapping={initial}
        onMappingSaved={onMappingSaved}
      />
    );

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith(
        'http://localhost:3001/api/business/xero/account-tax-options',
        expect.objectContaining({ params: { workspaceId: 'ws-1' } })
      );
    });

    await user.click(screen.getByRole('button', { name: /save mapping/i }));

    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    expect(showSaveSuccessToast).toHaveBeenCalledWith('Account & tax mapping');
    expect(onMappingSaved).toHaveBeenCalled();
  });

  it('notifies when options fail to load', async () => {
    const onOptionsLoadFailed = vi.fn();
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      name: 'Error',
      response: { data: { message: 'auth expired' } },
    });

    render(
      <XeroAccountTaxMapping
        workspaceId="ws-1"
        isConnected
        initialMapping={buildDefaultLineItemMapping()}
        onMappingSaved={vi.fn()}
        onOptionsLoadFailed={onOptionsLoadFailed}
      />
    );

    await waitFor(() => {
      expect(onOptionsLoadFailed).toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalled();
    });
  });

  it('does not toast Not Found when Xero chart data is missing', async () => {
    const onOptionsLoadFailed = vi.fn();
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      name: 'Error',
      response: { status: 400, data: { message: 'Xero integration not found' } },
    });

    render(
      <XeroAccountTaxMapping
        workspaceId="ws-1"
        isConnected
        initialMapping={buildDefaultLineItemMapping()}
        onMappingSaved={vi.fn()}
        onOptionsLoadFailed={onOptionsLoadFailed}
      />
    );

    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    expect(showErrorToast).not.toHaveBeenCalled();
    expect(onOptionsLoadFailed).not.toHaveBeenCalled();
  });

  it('toasts when loading Xero accounts times out', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'ECONNABORTED',
      message: 'timeout of 15000ms exceeded',
    });

    render(
      <XeroAccountTaxMapping
        workspaceId="ws-1"
        isConnected
        initialMapping={buildDefaultLineItemMapping()}
        onMappingSaved={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        'Failed to load Xero accounts/tax rates',
        expect.objectContaining({
          description: expect.stringMatching(/timed out/i),
        })
      );
    });
  });

  it('toasts when save mapping fails', async () => {
    const user = userEvent.setup();
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: OPTIONS });
    (axios.put as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { data: { message: 'save blocked' } },
    });

    render(
      <XeroAccountTaxMapping
        workspaceId="ws-1"
        isConnected
        initialMapping={buildDefaultLineItemMapping()}
        onMappingSaved={vi.fn()}
      />
    );

    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /save mapping/i }));

    await waitFor(() => {
      expect(showSaveErrorToast).toHaveBeenCalledWith(
        'Account & tax mapping',
        'save blocked'
      );
    });
  });

  // Epic 4.5 — document-type defaults + Quote line-item override table.
  it('renders Quote, Purchase Order, Invoice mapping and the Quote override table', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: OPTIONS });

    render(
      <XeroAccountTaxMapping
        workspaceId="ws-1"
        isConnected
        initialMapping={buildDefaultLineItemMapping()}
        onMappingSaved={vi.fn()}
      />
    );

    expect(
      screen.getByText(/^default account & tax mapping/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/^quote$/i)).toBeInTheDocument();
    expect(screen.getByText(/^purchase order$/i)).toBeInTheDocument();
    expect(screen.getByText(/^invoice$/i)).toBeInTheDocument();
    expect(screen.getByText(/line-item type/i)).toBeInTheDocument();
    expect(screen.getByText('Quote Service')).toBeInTheDocument();
    expect(screen.getByText('Material')).toBeInTheDocument();

    await waitFor(() => expect(axios.get).toHaveBeenCalled());
  });

  it('keeps account and tax rate independent — tax can be set before account', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: OPTIONS });

    render(
      <XeroAccountTaxMapping
        workspaceId="ws-1"
        isConnected
        initialMapping={buildDefaultLineItemMapping()}
        onMappingSaved={vi.fn()}
      />
    );

    await waitFor(() => expect(axios.get).toHaveBeenCalled());

    for (const label of screen.getAllByText('Tax Rate')) {
      const trigger = label.parentElement?.querySelector('button');
      expect(trigger).toBeTruthy();
      expect(trigger).not.toBeDisabled();
    }

    expect(screen.queryByText(/select an account first/i)).not.toBeInTheDocument();
  });

  it('persists default account/tax pairs when connected with an empty mapping', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: OPTIONS });
    (axios.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { xeroLineItemMapping: buildDefaultLineItemMapping() },
    });
    const onMappingSaved = vi.fn();

    render(
      <XeroAccountTaxMapping
        workspaceId="ws-1"
        isConnected
        initialMapping={EMPTY_LINE_ITEM_MAPPING}
        onMappingSaved={onMappingSaved}
      />
    );

    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    expect(axios.put).toHaveBeenCalledWith(
      'http://localhost:3001/api/business/xero/line-item-mapping',
      expect.objectContaining({
        workspaceId: 'ws-1',
        mapping: expect.objectContaining({
          invoice: expect.objectContaining({
            accountCode: '200',
            taxType: 'EXEMPTOUTPUT',
          }),
          purchaseOrder: expect.objectContaining({
            accountCode: '310',
            taxType: 'EXEMPTEXPENSES',
          }),
        }),
      })
    );
    await waitFor(() => expect(onMappingSaved).toHaveBeenCalled());
    expect(showSaveSuccessToast).not.toHaveBeenCalled();
  });
});
