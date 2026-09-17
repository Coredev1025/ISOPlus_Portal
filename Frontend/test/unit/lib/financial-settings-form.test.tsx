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
    onSequenceNextChange: vi.fn(),
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

  it('confirms before reducing a document next number', async () => {
    const user = userEvent.setup();
    const onSequenceNextChange = vi.fn();

    function Harness() {
      const [sequences, setSequences] = useState(SEQUENCES);
      return (
        <FinancialSettingsForm
          bankDetails={BANK}
          sequences={sequences}
          loading={false}
          errors={[]}
          apiError=""
          showSuccess={false}
          onBankChange={vi.fn()}
          onSequencePrefixChange={vi.fn()}
          onSequenceNextChange={(type: DocumentSequenceType, value: number) => {
            onSequenceNextChange(type, value);
            setSequences((prev) => ({
              ...prev,
              [type]: { ...prev[type], nextNumber: value },
            }));
          }}
          onSave={vi.fn()}
        />
      );
    }

    const { container } = render(<Harness />);
    const invoiceNext = container.querySelector('#invoice-next') as HTMLInputElement;

    fireEvent.focus(invoiceNext);
    fireEvent.change(invoiceNext, { target: { value: '999' } });
    fireEvent.blur(invoiceNext);

    expect(
      await screen.findByText(/reducing the next number may result in duplicate/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(invoiceNext).toHaveValue(999);
    expect(onSequenceNextChange).toHaveBeenCalledWith('invoice', 999);
  });

  it('applies an increased next number without confirmation', () => {
    const { container, onSequenceNextChange } = renderForm();
    const invoiceNext = container.querySelector('#invoice-next') as HTMLInputElement;

    fireEvent.focus(invoiceNext);
    fireEvent.change(invoiceNext, { target: { value: '1001' } });
    fireEvent.blur(invoiceNext);

    expect(onSequenceNextChange).toHaveBeenCalledWith('invoice', 1001);
    expect(
      screen.queryByText(/reducing the next number may result in duplicate/i)
    ).not.toBeInTheDocument();
  });

  // Typing "1081" over "1001" fires onChange("1") first. Confirming on that
  // intermediate value silently commits 1 after Continue — a billing collision.
  it('does not treat the first digit of a larger typed number as a reduction', async () => {
    const user = userEvent.setup();
    const onSequenceNextChange = vi.fn();
    const initial: DocumentSequences = {
      ...SEQUENCES,
      purchaseOrder: { prefix: 'PO-', nextNumber: 1001 },
    };

    function Harness() {
      const [sequences, setSequences] = useState(initial);
      return (
        <FinancialSettingsForm
          bankDetails={BANK}
          sequences={sequences}
          loading={false}
          errors={[]}
          apiError=""
          showSuccess={false}
          onBankChange={vi.fn()}
          onSequencePrefixChange={vi.fn()}
          onSequenceNextChange={(type: DocumentSequenceType, value: number) => {
            onSequenceNextChange(type, value);
            setSequences((prev) => ({
              ...prev,
              [type]: { ...prev[type], nextNumber: value },
            }));
          }}
          onSave={vi.fn()}
        />
      );
    }

    const { container } = render(<Harness />);
    const poNext = container.querySelector('#po-next') as HTMLInputElement;

    fireEvent.focus(poNext);
    fireEvent.change(poNext, { target: { value: '1' } });
    expect(onSequenceNextChange).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/reducing the next number may result in duplicate/i)
    ).not.toBeInTheDocument();

    fireEvent.change(poNext, { target: { value: '1081' } });
    fireEvent.blur(poNext);

    expect(
      screen.queryByText(/reducing the next number may result in duplicate/i)
    ).not.toBeInTheDocument();
    expect(onSequenceNextChange).toHaveBeenLastCalledWith('purchaseOrder', 1081);
    expect(poNext).toHaveValue(1081);

    fireEvent.focus(poNext);
    fireEvent.change(poNext, { target: { value: '500' } });
    fireEvent.blur(poNext);
    expect(
      await screen.findByText(/reducing the next number may result in duplicate/i)
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(poNext).toHaveValue(1081);
  });

  // Keystroke updates must not reach parent state: Save after typing "1" of a
  // longer number would otherwise persist 1 and collide with issued documents.
  it('does not commit a mid-edit next number to parent state before blur', () => {
    const onSequenceNextChange = vi.fn();
    const { container } = renderForm({ onSequenceNextChange });
    const invoiceNext = container.querySelector('#invoice-next') as HTMLInputElement;

    fireEvent.focus(invoiceNext);
    fireEvent.change(invoiceNext, { target: { value: '1' } });

    expect(onSequenceNextChange).not.toHaveBeenCalled();
    expect(invoiceNext).toHaveValue(1);
  });

  it('does not let Save persist an unconfirmed mid-edit reduction', async () => {
    const onSave = vi.fn();
    const onSequenceNextChange = vi.fn();
    const initial: DocumentSequences = {
      ...SEQUENCES,
      purchaseOrder: { prefix: 'PO-', nextNumber: 1001 },
    };

    function Harness() {
      const [sequences, setSequences] = useState(initial);
      return (
        <FinancialSettingsForm
          bankDetails={BANK}
          sequences={sequences}
          loading={false}
          errors={[]}
          apiError=""
          showSuccess={false}
          onBankChange={vi.fn()}
          onSequencePrefixChange={vi.fn()}
          onSequenceNextChange={(type: DocumentSequenceType, value: number) => {
            onSequenceNextChange(type, value);
            setSequences((prev) => ({
              ...prev,
              [type]: { ...prev[type], nextNumber: value },
            }));
          }}
          onSave={onSave}
        />
      );
    }

    const { container } = render(<Harness />);
    const poNext = container.querySelector('#po-next') as HTMLInputElement;

    fireEvent.focus(poNext);
    fireEvent.change(poNext, { target: { value: '1' } });
    fireEvent.blur(poNext);

    expect(
      await screen.findByText(/reducing the next number may result in duplicate/i)
    ).toBeInTheDocument();
    expect(onSequenceNextChange).not.toHaveBeenCalled();

    const saveButton = screen.getByRole('button', {
      name: /save changes/i,
      hidden: true,
    });
    expect(saveButton).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
    expect(onSequenceNextChange).not.toHaveBeenCalledWith('purchaseOrder', 1);
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
    fireEvent.blur(container.querySelector('#po-next')!);
    fireEvent.change(container.querySelector('#quote-next')!, { target: { value: '3001' } });
    fireEvent.blur(container.querySelector('#quote-next')!);
    fireEvent.change(container.querySelector('#statement-next')!, {
      target: { value: '4001' },
    });
    fireEvent.blur(container.querySelector('#statement-next')!);
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
