import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvoiceGeneratorFiltersRow } from '@/lib/invoice-generator-filters-row';
import { TRANSACTION_STATUS_FILTERS } from '@/lib/invoice-generator-helpers';

/**
 * The filter row's real behaviour is conditional: an NDIS board shows a job
 * status filter and a dynamic payment-status list, a non-NDIS board shows a
 * transaction status filter and a fixed payment-status list. Getting that
 * branch wrong shows the wrong filters for a whole board type, so each side is
 * pinned here along with the value each select reports.
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

afterEach(() => {
  cleanup();
});

const PAYMENT_STATUS_FILTERS = [
  { value: 'all', label: 'All Payment Status' },
  { value: 'paid', label: 'Paid' },
  { value: 'unpaid', label: 'Unpaid' },
];

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    isNdisBoard: false,
    participantFilter: 'all',
    setParticipantFilter: vi.fn(),
    uniqueParticipants: ['Dana Reid', 'Sam Okafor'],
    scheduledServiceDateRange: undefined,
    setScheduledServiceDateRange: vi.fn(),
    serviceDeliveryDateRange: undefined,
    setServiceDeliveryDateRange: vi.fn(),
    transactionStatusFilter: 'all',
    setTransactionStatusFilter: vi.fn(),
    jobStatusFilter: 'all',
    setJobStatusFilter: vi.fn(),
    ndisStatusFieldLabel: 'Job Status',
    paymentStatusFilter: 'all',
    setPaymentStatusFilter: vi.fn(),
    ndisPaymentStatusOptions: ['Claimed', 'Unclaimed'],
    paymentStatusFilters: PAYMENT_STATUS_FILTERS,
    ...overrides,
  };
}

function renderRow(overrides: Record<string, unknown> = {}) {
  const props = baseProps(overrides);
  render(<InvoiceGeneratorFiltersRow {...(props as never)} />);
  return props;
}

/** Radix Select triggers are comboboxes; index them in render order. */
function comboboxes() {
  return screen.getAllByRole('combobox');
}

describe('InvoiceGeneratorFiltersRow — shared filters', () => {
  it('always offers a participant filter with an All option', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderRow();

    await user.click(comboboxes()[0]);

    expect(await screen.findByRole('option', { name: 'All Participants' })).toBeInTheDocument();
  });

  it('lists every unique participant', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderRow();

    await user.click(comboboxes()[0]);

    expect(await screen.findByRole('option', { name: 'Dana Reid' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Sam Okafor' })).toBeInTheDocument();
  });

  it('reports the participant that was chosen', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = renderRow();

    await user.click(comboboxes()[0]);
    await user.click(await screen.findByRole('option', { name: 'Dana Reid' }));

    expect(props.setParticipantFilter).toHaveBeenCalledWith('Dana Reid');
  });

  it('renders both date range pickers', () => {
    renderRow();

    expect(screen.getByRole('button', { name: /Scheduled Service Date/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Service Delivery Date/ })).toBeInTheDocument();
  });

  it('renders an empty participant list without an error', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderRow({ uniqueParticipants: [] });

    await user.click(comboboxes()[0]);

    expect(await screen.findByRole('option', { name: 'All Participants' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });
});

describe('InvoiceGeneratorFiltersRow — non-NDIS board', () => {
  it('shows a transaction status filter', () => {
    renderRow({ isNdisBoard: false });

    // participant, transaction status, payment status
    expect(comboboxes()).toHaveLength(3);
  });

  it('lists every transaction status option', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderRow({ isNdisBoard: false });

    await user.click(comboboxes()[1]);

    for (const option of TRANSACTION_STATUS_FILTERS) {
      expect(await screen.findByRole('option', { name: option.label })).toBeInTheDocument();
    }
  });

  it('reports the transaction status that was chosen', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = renderRow({ isNdisBoard: false });
    const target = TRANSACTION_STATUS_FILTERS[1];

    await user.click(comboboxes()[1]);
    await user.click(await screen.findByRole('option', { name: target.label }));

    expect(props.setTransactionStatusFilter).toHaveBeenCalledWith(target.value);
  });

  it('uses the fixed payment status list', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderRow({ isNdisBoard: false });

    await user.click(comboboxes()[2]);

    expect(await screen.findByRole('option', { name: 'Paid' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Unpaid' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Claimed' })).not.toBeInTheDocument();
  });

  it('reports the payment status that was chosen', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = renderRow({ isNdisBoard: false });

    await user.click(comboboxes()[2]);
    await user.click(await screen.findByRole('option', { name: 'Paid' }));

    expect(props.setPaymentStatusFilter).toHaveBeenCalledWith('paid');
  });
});

describe('InvoiceGeneratorFiltersRow — NDIS board', () => {
  it('swaps the transaction status filter for a job status filter', () => {
    renderRow({ isNdisBoard: true });

    // participant, job status, payment status
    expect(comboboxes()).toHaveLength(3);
  });

  it('labels the job status filter from ndisStatusFieldLabel', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderRow({ isNdisBoard: true, ndisStatusFieldLabel: 'Shift Status' });

    await user.click(comboboxes()[1]);

    expect(await screen.findByRole('option', { name: 'All Shift Status' })).toBeInTheDocument();
  });

  it('offers the three fixed job statuses', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderRow({ isNdisBoard: true });

    await user.click(comboboxes()[1]);

    expect(await screen.findByRole('option', { name: 'Scheduled' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Completed' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Cancelled' })).toBeInTheDocument();
  });

  it('reports the job status that was chosen', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = renderRow({ isNdisBoard: true });

    await user.click(comboboxes()[1]);
    await user.click(await screen.findByRole('option', { name: 'Completed' }));

    expect(props.setJobStatusFilter).toHaveBeenCalledWith('Completed');
  });

  it('builds the payment status list from the board-derived options', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderRow({ isNdisBoard: true });

    await user.click(comboboxes()[2]);

    expect(await screen.findByRole('option', { name: 'All Payment Status' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Claimed' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Unclaimed' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Paid' })).not.toBeInTheDocument();
  });

  it('reports the NDIS payment status that was chosen', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = renderRow({ isNdisBoard: true });

    await user.click(comboboxes()[2]);
    await user.click(await screen.findByRole('option', { name: 'Claimed' }));

    expect(props.setPaymentStatusFilter).toHaveBeenCalledWith('Claimed');
  });

  it('shows only the All option when the board yields no payment statuses', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderRow({ isNdisBoard: true, ndisPaymentStatusOptions: [] });

    await user.click(comboboxes()[2]);

    expect(await screen.findByRole('option', { name: 'All Payment Status' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });
});
