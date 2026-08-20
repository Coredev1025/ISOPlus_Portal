import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FinancialSettingsForm,
  type BankDetailsForm,
  type DocumentSequences,
} from '@/lib/financial-settings-form';

const BANK: BankDetailsForm = {
  bankName: 'CBA',
  bankAccountName: 'Acme',
  bsb: '062000',
  accountNumber: '12345678',
  accountsReceivableTerms: 'Net 14',
  accountsPayableTerms: 'Net 30',
};

const SEQUENCES: DocumentSequences = {
  invoice: { prefix: 'INV-', nextNumber: 1000 },
  purchaseOrder: { prefix: 'PO-', nextNumber: 2000 },
  quote: { prefix: 'QT-', nextNumber: 3000 },
  statement: { prefix: 'STM-', nextNumber: 4000 },
};

function renderForm(
  overrides: Partial<ComponentProps<typeof FinancialSettingsForm>> = {}
) {
  const props = {
    bankDetails: BANK,
    sequences: SEQUENCES,
    loading: false,
    errors: [] as string[],
    apiError: '',
    showSuccess: false,
    onBankChange: vi.fn(),
    onSequencePrefixChange: vi.fn(),
    onSequenceNextChange: vi.fn(),
    onRestoreDefaults: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
  const view = render(<FinancialSettingsForm {...props} />);
  return { ...props, ...view };
}

describe('FinancialSettingsForm', () => {
  afterEach(() => {
    cleanup();
  });

  it('relocates bank details and document numbering with statement + disabled credit note (Epic 3)', () => {
    const { container } = renderForm();

    expect(screen.getByRole('heading', { name: 'Bank Details' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Document Number Configuration' })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/payment reference/i)).not.toBeInTheDocument();

    expect(screen.getByText('Statement Numbers')).toBeInTheDocument();
    expect(screen.queryByText(/^new$/i)).not.toBeInTheDocument();
    expect(container.querySelector('#statement-prefix')).not.toBeDisabled();
    expect(container.querySelector('#statement-next')).not.toBeDisabled();
    expect(
      screen.getByText(/feeds statement automation/i)
    ).toBeInTheDocument();

    expect(screen.getByText('Credit Note Numbers')).toBeInTheDocument();
    expect(screen.getByText(/later phase/i)).toBeInTheDocument();
    expect(container.querySelector('#credit-note-prefix')).toBeDisabled();
    expect(container.querySelector('#credit-note-next')).toBeDisabled();
  });

  it('wires bank field changes', async () => {
    const user = userEvent.setup();
    const { onBankChange } = renderForm();

    await user.type(screen.getByLabelText('Bank Name'), 'Z');
    expect(onBankChange).toHaveBeenCalledWith('bankName', expect.any(String));
  });

  it('shows errors, api error, success, and save/restore actions', async () => {
    const user = userEvent.setup();
    const { onRestoreDefaults, onSave } = renderForm({
      errors: ['BSB is invalid'],
      apiError: 'Server down',
      showSuccess: true,
    });

    expect(screen.getByText('BSB is invalid')).toBeInTheDocument();
    expect(screen.getByText('Server down')).toBeInTheDocument();
    expect(
      screen.getByText(/financial settings saved successfully/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /restore defaults/i }));
    expect(onRestoreDefaults).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(onSave).toHaveBeenCalled();
  });

  it('confirms before reducing a document next number', async () => {
    const user = userEvent.setup();
    const { container, onSequenceNextChange } = renderForm();
    const invoiceNext = container.querySelector('#invoice-next') as HTMLInputElement;

    fireEvent.change(invoiceNext, { target: { value: '999' } });

    expect(
      await screen.findByText(/reducing the next number may result in duplicate/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(onSequenceNextChange).toHaveBeenCalledWith('invoice', 999);
  });

  it('applies an increased next number without confirmation', () => {
    const { container, onSequenceNextChange } = renderForm();
    const invoiceNext = container.querySelector('#invoice-next') as HTMLInputElement;

    fireEvent.change(invoiceNext, { target: { value: '1001' } });

    expect(onSequenceNextChange).toHaveBeenCalledWith('invoice', 1001);
    expect(
      screen.queryByText(/reducing the next number may result in duplicate/i)
    ).not.toBeInTheDocument();
  });

  it('wires remaining bank fields and sequence prefixes', () => {
    const {
      container,
      onBankChange,
      onSequencePrefixChange,
      onSequenceNextChange,
    } = renderForm();

    fireEvent.change(screen.getByLabelText('Account Name'), {
      target: { value: 'New Name' },
    });
    fireEvent.change(screen.getByLabelText('BSB'), { target: { value: '111111' } });
    fireEvent.change(screen.getByLabelText('Account Number'), {
      target: { value: '999' },
    });
    fireEvent.change(screen.getByLabelText(/accounts receivable payment terms/i), {
      target: { value: 'Net 7' },
    });
    fireEvent.change(screen.getByLabelText(/accounts payable payment terms/i), {
      target: { value: 'Net 21' },
    });

    expect(onBankChange).toHaveBeenCalledWith('bankAccountName', 'New Name');
    expect(onBankChange).toHaveBeenCalledWith('bsb', '111111');
    expect(onBankChange).toHaveBeenCalledWith('accountNumber', '999');
    expect(onBankChange).toHaveBeenCalledWith('accountsReceivableTerms', 'Net 7');
    expect(onBankChange).toHaveBeenCalledWith('accountsPayableTerms', 'Net 21');

    fireEvent.change(container.querySelector('#invoice-prefix')!, {
      target: { value: 'INV2-' },
    });
    fireEvent.change(container.querySelector('#po-prefix')!, {
      target: { value: 'PO2-' },
    });
    fireEvent.change(container.querySelector('#quote-prefix')!, {
      target: { value: 'QT2-' },
    });
    fireEvent.change(container.querySelector('#statement-prefix')!, {
      target: { value: 'ST2-' },
    });

    expect(onSequencePrefixChange).toHaveBeenCalledWith('invoice', 'INV2-');
    expect(onSequencePrefixChange).toHaveBeenCalledWith('purchaseOrder', 'PO2-');
    expect(onSequencePrefixChange).toHaveBeenCalledWith('quote', 'QT2-');
    expect(onSequencePrefixChange).toHaveBeenCalledWith('statement', 'ST2-');

    fireEvent.change(container.querySelector('#po-next')!, { target: { value: '2001' } });
    fireEvent.change(container.querySelector('#quote-next')!, { target: { value: '3001' } });
    fireEvent.change(container.querySelector('#statement-next')!, {
      target: { value: '4001' },
    });
    expect(onSequenceNextChange).toHaveBeenCalledWith('purchaseOrder', 2001);
    expect(onSequenceNextChange).toHaveBeenCalledWith('quote', 3001);
    expect(onSequenceNextChange).toHaveBeenCalledWith('statement', 4001);
  });

  it('allows a next number of 0 on invoice, PO, quote and statement inputs', () => {
    const { container } = renderForm();
    expect(container.querySelector('#invoice-next')).toHaveAttribute('min', '0');
    expect(container.querySelector('#po-next')).toHaveAttribute('min', '0');
    expect(container.querySelector('#quote-next')).toHaveAttribute('min', '0');
    expect(container.querySelector('#statement-next')).toHaveAttribute('min', '0');
  });
});
