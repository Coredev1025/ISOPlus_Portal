import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvoiceGeneratorInvoiceDialog } from '@/lib/invoice-generator-invoice-dialog';
import type { InvoiceGeneratorServiceRecord } from '@/lib/invoice-generator-types';

/**
 * This dialog is the last gate before an invoice is generated or pushed to
 * Xero, so the behaviour worth pinning is: what is listed, what the two
 * generate buttons are guarded by, and that closing it clears the selection so
 * a stale set cannot be reused on the next open.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

function record(overrides: Partial<InvoiceGeneratorServiceRecord> = {}): InvoiceGeneratorServiceRecord {
  return {
    id: 'r-1',
    status: 'pending',
    participant: 'Dana Reid',
    scheduledServiceDate: '2026-08-03',
    serviceDeliveryDate: '2026-08-03',
    unit: 'Hour',
    quantity: 2,
    unitPrice: 67.56,
    totalAmount: 135.12,
    govSubsidy: 100,
    participantContribution: 35.12,
    notes: '',
    service: 'Support',
    ...overrides,
  } as InvoiceGeneratorServiceRecord;
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    showInvoiceModal: true,
    setShowInvoiceModal: vi.fn(),
    setSelectedItems: vi.fn(),
    setEligibleRecords: vi.fn(),
    isLowCatBoard: false,
    invoiceDate: '2026-08-10',
    setInvoiceDate: vi.fn(),
    dueDate: '2026-08-24',
    setDueDate: vi.fn(),
    eligibleRecords: [record()],
    selectedItems: new Set<string>(['r-1']),
    handleSelectAll: vi.fn(),
    formatCurrency: (value: number) => `$${value.toFixed(2)}`,
    getInvoiceAmount: (r: InvoiceGeneratorServiceRecord) => r.totalAmount,
    loadingEligible: false,
    handleToggleItem: vi.fn(),
    formatDate: (value?: string | null) => value ?? '',
    isNdisBoard: false,
    handleGeneratePDFInvoice: vi.fn(),
    generatingPDF: false,
    generatingXero: false,
    handleGenerateXeroInvoice: vi.fn(),
    ...overrides,
  };
}

function renderDialog(overrides: Record<string, unknown> = {}) {
  const props = baseProps(overrides);
  render(<InvoiceGeneratorInvoiceDialog {...(props as never)} />);
  return props;
}

describe('InvoiceGeneratorInvoiceDialog visibility', () => {
  it('renders nothing while closed', () => {
    renderDialog({ showInvoiceModal: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names itself Generate Invoice when open', () => {
    renderDialog();

    expect(screen.getByRole('dialog', { name: /Generate Invoice/ })).toBeInTheDocument();
  });

  it('describes a participant tax invoice for a normal board', () => {
    renderDialog({ isLowCatBoard: false });

    expect(screen.getByText(/generate a participant tax invoice/)).toBeInTheDocument();
  });

  it('describes a plain tax invoice for a low-cat board', () => {
    renderDialog({ isLowCatBoard: true });

    expect(screen.getByText(/generate a tax invoice/)).toBeInTheDocument();
    expect(screen.queryByText(/participant tax invoice/)).not.toBeInTheDocument();
  });
});

describe('InvoiceGeneratorInvoiceDialog records', () => {
  it('lists the eligible record by its service, not the participant', () => {
    // Each row shows record.service (falling back to notes, then 'Service') —
    // the participant name is not rendered in this dialog at all.
    renderDialog();

    expect(screen.getByText('Support')).toBeInTheDocument();
    expect(screen.queryByText('Dana Reid')).not.toBeInTheDocument();
  });

  it('falls back to the notes when a record has no service', () => {
    renderDialog({ eligibleRecords: [record({ service: '', notes: 'Ad hoc visit' })] });

    expect(screen.getByText('Ad hoc visit')).toBeInTheDocument();
  });

  it('falls back to "Service" when a record has neither', () => {
    renderDialog({ eligibleRecords: [record({ service: '', notes: '' })] });

    expect(screen.getByText('Service')).toBeInTheDocument();
  });

  it('shows the invoice amount through the supplied formatter', () => {
    renderDialog();

    expect(screen.getByText('$135.12')).toBeInTheDocument();
  });

  it('lists every eligible record', () => {
    renderDialog({
      eligibleRecords: [record(), record({ id: 'r-2', service: 'Transport' })],
      selectedItems: new Set(['r-1', 'r-2']),
    });

    expect(screen.getByText('Support')).toBeInTheDocument();
    expect(screen.getByText('Transport')).toBeInTheDocument();
  });

  it('reports the record that was toggled', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByText('Support'));

    expect(props.handleToggleItem).toHaveBeenCalledWith('r-1');
  });

  it('offers a select-all control that reports back', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: /select/i }));

    expect(props.handleSelectAll).toHaveBeenCalledTimes(1);
  });
});

describe('InvoiceGeneratorInvoiceDialog generate buttons', () => {
  it('offers both a PDF and a Xero action', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: /Generate PDF Invoice/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate Xero Invoice/ })).toBeInTheDocument();
  });

  it('disables both while nothing is selected', () => {
    renderDialog({ selectedItems: new Set() });

    expect(screen.getByRole('button', { name: /Generate PDF Invoice/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Generate Xero Invoice/ })).toBeDisabled();
  });

  it('enables both once something is selected', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: /Generate PDF Invoice/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Generate Xero Invoice/ })).toBeEnabled();
  });

  it('generates a PDF invoice when asked', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: /Generate PDF Invoice/ }));

    expect(props.handleGeneratePDFInvoice).toHaveBeenCalledTimes(1);
    expect(props.handleGenerateXeroInvoice).not.toHaveBeenCalled();
  });

  it('generates a Xero invoice when asked', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: /Generate Xero Invoice/ }));

    expect(props.handleGenerateXeroInvoice).toHaveBeenCalledTimes(1);
    expect(props.handleGeneratePDFInvoice).not.toHaveBeenCalled();
  });

  it('shows a spinner and locks both actions while the PDF is generating', () => {
    renderDialog({ generatingPDF: true });

    expect(screen.getByRole('button', { name: /Generating/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Generate Xero Invoice/ })).toBeDisabled();
  });

  it('locks both actions while the Xero invoice is generating', () => {
    renderDialog({ generatingXero: true });

    expect(screen.getByRole('button', { name: /Generate PDF Invoice/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Generating/ })).toBeDisabled();
  });
});

describe('InvoiceGeneratorInvoiceDialog closing', () => {
  it('closes on Cancel', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(props.setShowInvoiceModal).toHaveBeenCalledWith(false);
  });

  it('clears the selection and the record list when dismissed', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.keyboard('{Escape}');

    expect(props.setShowInvoiceModal).toHaveBeenCalledWith(false);
    expect(props.setSelectedItems).toHaveBeenCalledWith(new Set());
    expect(props.setEligibleRecords).toHaveBeenCalledWith([]);
  });

  it('does not clear anything when Cancel is pressed directly', async () => {
    // Cancel only flips the flag; the reset lives in onOpenChange, which the
    // button does not trigger. Documents current behaviour.
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(props.setSelectedItems).not.toHaveBeenCalled();
    expect(props.setEligibleRecords).not.toHaveBeenCalled();
  });
});
