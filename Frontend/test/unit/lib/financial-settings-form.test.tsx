import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FinancialSettingsForm,
  type BankDetailsForm,
  type DocumentSequenceType,
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
  statementOfAccount: { prefix: 'SOA-', nextNumber: 5000 },
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

  it('shows invoice, PO, quote and SOA in a 2-per-row grid; hides Statement Numbers and Credit Note', () => {
    const { container } = renderForm();

    expect(screen.getByRole('heading', { name: 'Bank Details' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Document Number Configuration' })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/payment reference/i)).not.toBeInTheDocument();

    expect(screen.getByText('Invoice Numbers')).toBeInTheDocument();
    expect(screen.getByText('Purchase Order Numbers')).toBeInTheDocument();
    expect(screen.getByText('Quote Numbers')).toBeInTheDocument();
    expect(screen.getByText('Statement of Account Numbers')).toBeInTheDocument();

    expect(screen.queryByText('Statement Numbers')).not.toBeInTheDocument();
    expect(screen.queryByText('Credit Note Numbers')).not.toBeInTheDocument();
    expect(screen.queryByText(/later phase/i)).not.toBeInTheDocument();
    expect(container.querySelector('#statement-prefix')).not.toBeInTheDocument();
    expect(container.querySelector('#credit-note-prefix')).not.toBeInTheDocument();

    const numberingGrid = screen.getByTestId('document-numbering-grid');
    expect(numberingGrid.className).toMatch(/\bmd:grid-cols-2\b/);
    expect(numberingGrid.className).not.toMatch(/\bmd:grid-cols-3\b/);
  });

  it('wires bank field changes', async () => {
    const user = userEvent.setup();
    const { onBankChange } = renderForm();

    await user.type(screen.getByLabelText('Bank Name'), 'Z');
    expect(onBankChange).toHaveBeenCalledWith('bankName', expect.any(String));
  });

  it('shows errors, api error, success, and save action', async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm({
      errors: ['BSB is invalid'],
      apiError: 'Server down',
      showSuccess: true,
    });

    expect(screen.getByText('BSB is invalid')).toBeInTheDocument();
    expect(screen.getByText('Server down')).toBeInTheDocument();
    expect(
      screen.getByText(/financial settings saved successfully/i)
    ).toBeInTheDocument();

    expect(
      screen.queryByRole('button', { name: /restore defaults/i })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(onSave).toHaveBeenCalled();
  });

  it('wires remaining bank fields and sequence prefixes', () => {
    const { container, onBankChange, onSequencePrefixChange } = renderForm();

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
    fireEvent.change(container.querySelector('#statement-of-account-prefix')!, {
      target: { value: 'SOA2-' },
    });

    expect(onSequencePrefixChange).toHaveBeenCalledWith('invoice', 'INV2-');
    expect(onSequencePrefixChange).toHaveBeenCalledWith('purchaseOrder', 'PO2-');
    expect(onSequencePrefixChange).toHaveBeenCalledWith('quote', 'QT2-');
    expect(onSequencePrefixChange).toHaveBeenCalledWith(
      'statementOfAccount',
      'SOA2-'
    );
  });

  // KAN-290: the numbering sequence is read-only. The next number is shown,
  // grayed out, and cannot be typed into: a counter is advanced only by the
  // generators that issue the numbers.
  it.each([
    ['invoice', '#invoice-next', 1000],
    ['purchase order', '#po-next', 2000],
    ['quote', '#quote-next', 3000],
    ['statement of account', '#statement-of-account-next', 5000],
  ])('shows the %s next number read-only and grayed out', (_label, selector, value) => {
    const { container } = renderForm();
    const input = container.querySelector(selector) as HTMLInputElement;

    expect(input).toBeInTheDocument();
    expect(input.value).toBe(String(value));
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveAttribute('aria-readonly', 'true');
    expect(input.className).toMatch(/\bbg-muted\b/);
    expect(input.className).toMatch(/\btext-muted-foreground\b/);
    expect(input.className).toMatch(/\bcursor-not-allowed\b/);
  });

  it('keeps the prefix editable next to the read-only number', () => {
    const { container } = renderForm();
    expect(container.querySelector('#invoice-prefix')).not.toBeDisabled();
    expect(container.querySelector('#invoice-prefix')).not.toHaveAttribute('readonly');
  });

  it('says the next numbers are assigned automatically', () => {
    renderForm();
    expect(
      screen.getByText(/next numbers are assigned automatically and cannot be edited/i)
    ).toBeInTheDocument();
    expect(screen.getByText('Next: INV-1000')).toBeInTheDocument();
  });

  it('no longer offers the reduce-the-number warning', () => {
    renderForm();
    expect(screen.queryByText(/Reducing Number Sequence/i)).not.toBeInTheDocument();
  });

  // KAN-292: until the first save the user chooses the first number of each
  // document type; it is explained, exemplified and required.
  describe('before the first numbers have been set', () => {
    const BLANK = { invoice: '', purchaseOrder: '', quote: '', statementOfAccount: '' };

    it.each([
      ['invoice', '#invoice-next', '1001'],
      ['purchase order', '#po-next', '101'],
      ['quote', '#quote-next', '501'],
      ['statement of account', '#statement-of-account-next', '1'],
    ])('lets the user type the %s first number, with an example', async (_l, selector, example) => {
      const user = userEvent.setup();
      const onInitialNumberChange = vi.fn();
      const { container } = renderForm({
        numberingInitialized: false,
        initialNumbers: BLANK,
        onInitialNumberChange,
      });
      const input = container.querySelector(selector) as HTMLInputElement;

      expect(input).toBeEnabled();
      expect(input).not.toHaveAttribute('readonly');
      expect(input).toBeRequired();
      expect(input).toHaveAttribute('placeholder', `e.g. ${example}`);
      expect(input.value).toBe('');

      await user.type(input, '7');
      expect(onInitialNumberChange).toHaveBeenCalled();
    });

    it('shows the typed value, not the stored one, and previews the first number', () => {
      renderForm({
        numberingInitialized: false,
        initialNumbers: { ...BLANK, invoice: '1200' },
        onInitialNumberChange: vi.fn(),
      });
      expect(screen.getByDisplayValue('1200')).toBeInTheDocument();
      expect(screen.getByText('First: INV-1200')).toBeInTheDocument();
    });

    it('explains that the numbers are set once and cannot be changed afterwards', () => {
      renderForm({
        numberingInitialized: false,
        initialNumbers: BLANK,
        onInitialNumberChange: vi.fn(),
      });
      expect(screen.getByText(/enter the number each document type should start from/i)).toBeInTheDocument();
      expect(screen.getByText(/cannot be changed after you save/i)).toBeInTheDocument();
      expect(screen.getByText(/continue from your last number/i)).toBeInTheDocument();
    });

    it('keeps the prefix editable', () => {
      const { container } = renderForm({
        numberingInitialized: false,
        initialNumbers: BLANK,
        onInitialNumberChange: vi.fn(),
      });
      expect(container.querySelector('#invoice-prefix')).not.toBeDisabled();
    });
  });
});
