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

    // Statement Numbers is hidden; omit STM- on PUT so merge keeps the live
    // automation counter (sending clone defaults would overwrite it).
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
      statementOfAccount: { prefix: 'SOA-', nextNumber: 27 },
    });
    expect(
      Object.keys(JSON.parse(String(body.get('documentNumbering'))))
    ).not.toContain('statement');
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

  // KAN-292
  describe('first save of the document numbers', () => {
    const FRESH = {
      ...PROFILE,
      documentNumberingInitialized: false,
      documentNumbering: {
        invoice: { prefix: 'INV-', nextNumber: 1 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
        quote: { prefix: 'QT-', nextNumber: 1 },
        statement: { prefix: 'STM-', nextNumber: 1 },
        statementOfAccount: { prefix: 'SOA-', nextNumber: 1 },
      },
    };

    async function renderFresh() {
      (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: FRESH });
      const view = render(<FinancialSettingsPanel workspaceId="ws-1" />);
      await screen.findByDisplayValue('CBA');
      return view;
    }

    it('starts the number fields empty and editable, not showing the default 1', async () => {
      const { container } = await renderFresh();
      for (const id of ['invoice-next', 'po-next', 'quote-next', 'statement-of-account-next']) {
        const input = container.querySelector(`#${id}`) as HTMLInputElement;
        expect(input.value).toBe('');
        expect(input).toBeEnabled();
      }
    });

    it('refuses to save until every document type has a number, and says which', async () => {
      const user = userEvent.setup();
      const { container } = await renderFresh();
      await user.type(container.querySelector('#invoice-next')!, '1200');

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      expect(await screen.findByText(/purchase order: enter a starting number/i)).toBeInTheDocument();
      expect(screen.getByText(/quote: enter a starting number/i)).toBeInTheDocument();
      expect(screen.getByText(/statement of account: enter a starting number/i)).toBeInTheDocument();
      expect(screen.queryByText(/invoice: enter a starting number/i)).not.toBeInTheDocument();
      expect(axios.put).not.toHaveBeenCalled();
    });

    it.each(['0', '-3', '1.5', '12a'])('rejects %s as a starting number', async (bad) => {
      const user = userEvent.setup();
      const { container } = await renderFresh();
      for (const id of ['po-next', 'quote-next', 'statement-of-account-next']) {
        await user.type(container.querySelector(`#${id}`)!, '5');
      }
      // A number input discards non-numeric text, so write the raw value directly.
      const invoice = container.querySelector('#invoice-next') as HTMLInputElement;
      const { fireEvent } = await import('@testing-library/react');
      fireEvent.change(invoice, { target: { value: bad } });

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      expect(axios.put).not.toHaveBeenCalled();
    });

    it('sends the chosen numbers and asks the server to set them', async () => {
      const user = userEvent.setup();
      (axios.put as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 200,
        data: { ...PROFILE, documentNumberingInitialized: true },
      });
      const { container } = await renderFresh();
      await user.type(container.querySelector('#invoice-next')!, '1200');
      await user.type(container.querySelector('#po-next')!, '35');
      await user.type(container.querySelector('#quote-next')!, '410');
      await user.type(container.querySelector('#statement-of-account-next')!, '8');

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(axios.put).toHaveBeenCalled());
      const [, body] = (axios.put as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(body.get('initializeDocumentNumbering')).toBe('true');
      expect(JSON.parse(String(body.get('documentNumbering')))).toEqual({
        invoice: { prefix: 'INV-', nextNumber: 1200 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 35 },
        quote: { prefix: 'QT-', nextNumber: 410 },
        statementOfAccount: { prefix: 'SOA-', nextNumber: 8 },
      });
    });

    it('turns the fields read-only once the server reports them set', async () => {
      const user = userEvent.setup();
      (axios.put as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 200,
        data: {
          ...FRESH,
          documentNumberingInitialized: true,
          documentNumbering: {
            ...FRESH.documentNumbering,
            invoice: { prefix: 'INV-', nextNumber: 1200 },
          },
        },
      });
      const { container } = await renderFresh();
      for (const [id, v] of [['invoice-next', '1200'], ['po-next', '35'], ['quote-next', '410'], ['statement-of-account-next', '8']]) {
        await user.type(container.querySelector(`#${id}`)!, v);
      }
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(container.querySelector('#invoice-next')).toBeDisabled());
      expect((container.querySelector('#invoice-next') as HTMLInputElement).value).toBe('1200');
    });

    it('tells the user when the server did not apply the numbers they typed, and shows the current ones', async () => {
      const user = userEvent.setup();
      (axios.put as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 200,
        data: {
          ...FRESH,
          documentNumberingInitialized: true,
          initialNumbersApplied: false,
          documentNumbering: {
            ...FRESH.documentNumbering,
            invoice: { prefix: 'INV-', nextNumber: 1042 },
          },
        },
      });
      const { container } = await renderFresh();
      for (const [id, v] of [['invoice-next', '1200'], ['po-next', '35'], ['quote-next', '410'], ['statement-of-account-next', '8']]) {
        await user.type(container.querySelector(`#${id}`)!, v);
      }

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      expect(await screen.findByText(/your starting numbers were not saved/i)).toBeInTheDocument();
      expect(showSaveSuccessToast).not.toHaveBeenCalled();
      expect(showSaveErrorToast).toHaveBeenCalled();
      // The fields now show what the server holds, read-only.
      await waitFor(() => expect(container.querySelector('#invoice-next')).toBeDisabled());
      expect((container.querySelector('#invoice-next') as HTMLInputElement).value).toBe('1042');
    });

    it('does not ask for the numbers again when the server says they are set', async () => {
      (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { ...PROFILE, documentNumberingInitialized: true },
      });
      const { container } = render(<FinancialSettingsPanel workspaceId="ws-1" />);
      await screen.findByDisplayValue('CBA');
      expect(container.querySelector('#invoice-next')).toBeDisabled();
    });

    it('asks for the numbers when the workspace has no profile yet (404)', async () => {
      (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
        name: 'Error',
        response: { status: 404, data: {} },
      });
      const { container } = render(<FinancialSettingsPanel workspaceId="ws-1" />);
      await screen.findByRole('button', { name: /save changes/i });
      expect(container.querySelector('#invoice-next')).toBeEnabled();
    });
  });
});
