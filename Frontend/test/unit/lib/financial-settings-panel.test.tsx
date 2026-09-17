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
  showFetchErrorToast: vi.fn(),
  showFetchSuccessToast: vi.fn(),
  showSaveErrorToast: vi.fn(),
  showSaveSuccessToast: vi.fn(),
}));

import axios from '@/app/utils/axiosConfig';
import { FinancialSettingsPanel } from '@/lib/financial-settings-panel';
import {
  showFetchErrorToast,
  showFetchSuccessToast,
  showSaveErrorToast,
  showSaveSuccessToast,
} from '@/lib/toast-utils';

const PROFILE = {
  name: 'Acme Care',
  phone: '',
  email: '',
  companyRegistrationId: '',
  address: {},
  abn: '',
  acn: '',
  bankDetails: {
    bankName: 'CBA',
    accountName: 'Acme',
    bsb: '062000',
    accountNumber: '12345678',
    accountsReceivableTerms: 'Net 14',
    accountsPayableTerms: 'Net 30',
  },
  documentNumbering: {
    invoice: { prefix: 'INV-', nextNumber: 1042 },
    purchaseOrder: { prefix: 'PO-', nextNumber: 1000 },
    quote: { prefix: 'QT-', nextNumber: 1007 },
    statement: { prefix: 'STM-', nextNumber: 1000 },
    statementOfAccount: { prefix: 'SOA-', nextNumber: 27 },
  },
};

describe('FinancialSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:3001';
  });

  afterEach(() => {
    cleanup();
  });

  it('loads profile data into the form', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: PROFILE });

    render(<FinancialSettingsPanel workspaceId="ws-1" />);

    expect(await screen.findByDisplayValue('CBA')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Acme')).toBeInTheDocument();
    expect(showFetchSuccessToast).toHaveBeenCalledWith('Financial settings');
  });

  it('blocks save when business name is missing and maps API validation errors', async () => {
    const user = userEvent.setup();
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ...PROFILE, name: '' },
    });

    render(<FinancialSettingsPanel workspaceId="ws-1" />);
    await screen.findByDisplayValue('CBA');

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(
      await screen.findByText(/set company name in configure business first/i)
    ).toBeInTheDocument();
    expect(axios.put).not.toHaveBeenCalled();
    expect(showSaveErrorToast).toHaveBeenCalled();
  });

  it('saves merged bank details and document numbering', async () => {
    const user = userEvent.setup();
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: PROFILE });
    (axios.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 200,
      data: PROFILE,
    });

    render(<FinancialSettingsPanel workspaceId="ws-1" />);
    await screen.findByDisplayValue('CBA');

    // Statement Numbers / Credit Note are gone from the form; STM- still rides
    // along on save because monthly budget statements claim that series.
    expect(screen.queryByText('Statement Numbers')).not.toBeInTheDocument();
    expect(screen.queryByText('Credit Note Numbers')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(axios.put).toHaveBeenCalled());
    const [, body] = (axios.put as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(body.get('documentNumbering')))).toEqual({
      invoice: { prefix: 'INV-', nextNumber: 1042 },
      purchaseOrder: { prefix: 'PO-', nextNumber: 1000 },
      quote: { prefix: 'QT-', nextNumber: 1007 },
      statement: { prefix: 'STM-', nextNumber: 1000 },
      // Omitting this resets the stored series to schema default 1 on PUT.
      statementOfAccount: { prefix: 'SOA-', nextNumber: 27 },
    });
    expect(showSaveSuccessToast).toHaveBeenCalledWith('Financial settings');
  });

  it('toasts fetch failures', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      name: 'Error',
      response: { data: { message: 'boom' } },
    });

    render(<FinancialSettingsPanel workspaceId="ws-1" />);

    await waitFor(() => {
      expect(showFetchErrorToast).toHaveBeenCalledWith('financial settings', 'boom');
    });
  });

  it('does not toast when the business profile is missing (404)', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      name: 'Error',
      response: { status: 404, data: { message: 'BusinessProfile not found' } },
    });

    render(<FinancialSettingsPanel workspaceId="ws-1" />);

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalled();
    });
    expect(showFetchErrorToast).not.toHaveBeenCalled();
    expect(showFetchSuccessToast).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /save changes/i })).toBeInTheDocument();
  });

  it('remaps save validation errors for missing business name', async () => {
    const user = userEvent.setup();
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: PROFILE });
    (axios.put as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: {
        data: { errors: ['Business name is required'] },
      },
    });

    render(<FinancialSettingsPanel workspaceId="ws-1" />);
    await screen.findByDisplayValue('CBA');

    expect(
      screen.queryByRole('button', { name: /restore defaults/i })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(
      await screen.findByText(/set company name in configure business first/i)
    ).toBeInTheDocument();
    expect(showSaveErrorToast).toHaveBeenCalled();
  });

  it('shows a generic api error when save fails without validation errors', async () => {
    const user = userEvent.setup();
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: PROFILE });
    (axios.put as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { data: { message: 'profile locked' } },
    });

    render(<FinancialSettingsPanel workspaceId="ws-1" />);
    await screen.findByDisplayValue('CBA');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('profile locked')).toBeInTheDocument();
  });
});