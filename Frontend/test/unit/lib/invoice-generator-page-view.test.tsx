import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ContextProvider } from '@/app/context';
import { InvoiceGeneratorPageView } from '@/lib/invoice-generator-page-view';
import { buildInvoiceGeneratorTableColumns } from '@/lib/invoice-generator-table-columns';
import type { InvoiceGeneratorServiceRecord } from '@/lib/invoice-generator-types';
import { server } from '../../msw/server';

/**
 * The invoice generator page view owns the parts nobody else does: which of the
 * four summary tiles a board sees, which of loading / error / empty / rows the
 * table body shows, what a click on a sortable column header asks for, and how
 * the toolbar gates resync and CSV export. It also composes the filters row,
 * the invoice dialog and the pagination controls for real, so the wiring
 * between them is checked here rather than mocked away.
 */

// One router object for the whole file. Next's real useRouter returns a stable
// reference; a factory that built a fresh object per call would re-run every
// effect that lists `router` in its deps.
const push = vi.fn();
const router = {
  push,
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/workspace/ws-1/board/b-1/invoice-generator',
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  globalThis.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as never;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  globalThis.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never;
});

const ADA = {
  id: 'u-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  avatar: '',
  role: 'support_admin',
};

beforeEach(() => {
  // NEXT_PUBLIC_BACKEND_URL is unset under vitest, so the Header's session check
  // goes to `undefined/api/auth/verify`. Match it by suffix.
  server.use(
    http.get('*/api/auth/verify', () => HttpResponse.json({ user: ADA })),
  );
  push.mockReset();
  window.localStorage.clear();
});

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(amount || 0);

const formatDisplayDate = (value?: string | null) => (value ? value.slice(0, 10) : '-');
const stripHtml = (value?: string) => (value ? value.replace(/<[^>]*>/g, '').trim() : '');

/** Default (Support-at-Home) board records: contribution is what gets invoiced. */
const RECORDS: InvoiceGeneratorServiceRecord[] = [
  {
    id: 'r-1',
    status: 'pending',
    participant: 'Grace Hopper',
    service: 'Personal Care',
    scheduledServiceDate: '2026-03-02T09:00:00.000Z',
    serviceDeliveryDate: '2026-03-02T11:00:00.000Z',
    transactionStatus: 'Service Delivered',
    unit: 'Hour',
    quantity: 2,
    unitPrice: 100,
    totalAmount: 200,
    govSubsidy: 150,
    participantContribution: 50,
    fundingSource: 'Home Support Quarterly Budget',
    notes: '<p>Two hours of personal care</p>',
    paymentStatus: 'Gov Claim Submitted',
  },
  {
    id: 'r-2',
    status: 'invoiced',
    participant: 'Alan Turing',
    service: 'Domestic Assistance',
    scheduledServiceDate: '2026-03-05T09:00:00.000Z',
    serviceDeliveryDate: '2026-03-05T10:00:00.000Z',
    transactionStatus: 'Service Delivered',
    unit: 'Hour',
    quantity: 1,
    unitPrice: 80.5,
    totalAmount: 80.5,
    govSubsidy: 60.5,
    participantContribution: 20,
    fundingSource: 'Home Support Quarterly Budget',
    notes: '',
    invoiceNumber: 'INV-0042',
    fileUrl: 'https://files.example.com/INV-0042.pdf',
    paymentStatus: 'Participant Invoiced',
  },
  {
    id: 'r-3',
    status: 'pending',
    participant: 'Ada Lovelace',
    service: 'Refund adjustment',
    scheduledServiceDate: null,
    serviceDeliveryDate: null,
    transactionStatus: 'Cancelled - Provider',
    unit: 'Each',
    quantity: -1,
    unitPrice: 42.75,
    totalAmount: -42.75,
    govSubsidy: -42.75,
    participantContribution: 0,
    fundingSource: '',
    notes: '',
    paymentStatus: '',
  },
];

/** Eligible records for the invoice dialog, deliberately distinct from RECORDS. */
const ELIGIBLE: InvoiceGeneratorServiceRecord[] = [
  { ...RECORDS[0], id: 'e-1', participantContribution: 50 },
  { ...RECORDS[1], id: 'e-2', participantContribution: 20 },
  { ...RECORDS[2], id: 'e-3', participantContribution: -12.5, service: 'Credit note' },
];

function baseProps(overrides: Record<string, unknown> = {}) {
  const props: Record<string, any> = {
    router,
    id: 'ws-1',
    boardId: 'b-1',
    isNdisBoard: false,
    isLowCatBoard: false,
    isNdisCertificationOrVerificationBoard: false,
    isCareManagementBoard: false,
    handleManualSync: vi.fn(),
    isManualSyncing: false,
    syncStatuses: [],
    showHelpDialog: false,
    setShowHelpDialog: vi.fn(),
    handleExportCSV: vi.fn(),
    exportingCSV: false,
    handleOpenInvoiceModal: vi.fn(),
    invoiceLabel: 'Participant Tax Invoice',
    lastSyncedAt: null,
    participantFilter: 'all',
    setParticipantFilter: vi.fn(),
    uniqueParticipants: ['Grace Hopper', 'Alan Turing'],
    scheduledServiceDateRange: undefined,
    setScheduledServiceDateRange: vi.fn(),
    serviceDeliveryDateRange: undefined,
    setServiceDeliveryDateRange: vi.fn(),
    transactionStatusFilter: 'all',
    setTransactionStatusFilter: vi.fn(),
    paymentStatusFilter: 'all',
    setPaymentStatusFilter: vi.fn(),
    ndisPaymentStatusOptions: ['Awaiting Payment', 'Paid'],
    jobStatusFilter: 'all',
    setJobStatusFilter: vi.fn(),
    ndisStatusFieldLabel: 'Job Status',
    statusFilter: 'all',
    setStatusFilter: vi.fn(),
    sortBy: 'scheduledServiceDate',
    setSortBy: vi.fn(),
    sortOrder: 'asc',
    setSortOrder: vi.fn(),
    clearAllFilters: vi.fn(),
    loading: false,
    error: null,
    filteredSummary: {
      totalRecords: 3,
      totalAmount: 237.75,
      totalGovSubsidy: 167.75,
      totalParticipantContribution: 70,
    },
    formatCurrency,
    getInvoiceAmount: (record: InvoiceGeneratorServiceRecord) => record.participantContribution || 0,
    formatDate: (value?: string | null) => (value ? value.slice(0, 10) : '-'),
    tableContainerRef: { current: null },
    canScrollLeft: false,
    canScrollRight: false,
    handleHorizontalScroll: vi.fn(),
    currentItems: RECORDS,
    totalPages: 1,
    currentPage: 1,
    setCurrentPage: vi.fn(),
    showInvoiceModal: false,
    setShowInvoiceModal: vi.fn(),
    eligibleRecords: [],
    setEligibleRecords: vi.fn(),
    selectedItems: new Set<string>(),
    setSelectedItems: vi.fn(),
    loadingEligible: false,
    handleSelectAll: vi.fn(),
    handleToggleItem: vi.fn(),
    invoiceDate: '2026-03-31',
    setInvoiceDate: vi.fn(),
    dueDate: '2026-04-14',
    setDueDate: vi.fn(),
    generatingPDF: false,
    generatingXero: false,
    handleGeneratePDFInvoice: vi.fn(),
    handleGenerateXeroInvoice: vi.fn(),
    onDownloadPdf: vi.fn(),
    PAYMENT_STATUS_FILTERS: [
      { value: 'all', label: 'All Payment Status' },
      { value: 'Gov Claim Submitted', label: 'Gov Claim Submitted' },
    ],
    ...overrides,
  };

  // The real page builds its columns from the same helper, so build them here
  // too rather than inventing a column set the product never renders.
  props.tableColumns =
    overrides.tableColumns ??
    buildInvoiceGeneratorTableColumns({
      isNdisBoard: props.isNdisBoard,
      isLowCatBoard: props.isLowCatBoard,
      ndisStatusFieldLabel: props.ndisStatusFieldLabel,
      formatDisplayDate,
      formatCurrency,
      stripHtml,
      onDownloadPdf: props.onDownloadPdf,
    });

  return props;
}

async function renderView(overrides: Record<string, unknown> = {}) {
  const props = baseProps(overrides);
  render(
    <ContextProvider>
      <InvoiceGeneratorPageView {...props} />
    </ContextProvider>,
  );
  // The Header verifies the session on mount; wait for the resulting state
  // update so it never lands after the test finishes.
  await screen.findByText('AL');
  return props;
}

describe('InvoiceGeneratorPageView masthead', () => {
  it('names the page', async () => {
    await renderView();

    expect(screen.getByRole('heading', { name: 'Invoice Generator', level: 1 })).toBeInTheDocument();
  });

  it('describes a Support at Home board as claims plus participant invoices', async () => {
    await renderView({ isNdisBoard: false, isLowCatBoard: false });

    expect(
      screen.getByText('Manage service records, submit claims and generate participant tax invoices.'),
    ).toBeInTheDocument();
  });

  it('describes an NDIS board as NDIA claim CSV', async () => {
    await renderView({ isNdisBoard: true });

    expect(screen.getByText('Manage NDIS service records and export NDIA claim CSV.')).toBeInTheDocument();
  });

  it('describes a low-category board as plain tax invoices', async () => {
    await renderView({ isLowCatBoard: true });

    expect(screen.getByText('Manage service records and generate tax invoices.')).toBeInTheDocument();
  });

  it('lets NDIS win when a board is somehow flagged as both', async () => {
    await renderView({ isNdisBoard: true, isLowCatBoard: true });

    expect(screen.getByText('Manage NDIS service records and export NDIA claim CSV.')).toBeInTheDocument();
  });

  it('returns to the board when Back is pressed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderView({ id: 'ws-9', boardId: 'b-7' });

    await user.click(screen.getByRole('button', { name: 'Back to Board' }));

    expect(push).toHaveBeenCalledWith('/workspace/ws-9/board/b-7');
  });
});

describe('InvoiceGeneratorPageView last-refreshed line', () => {
  it('says so when the board has never been refreshed', async () => {
    await renderView({ lastSyncedAt: null });

    expect(screen.getByText('Not refreshed yet')).toBeInTheDocument();
  });

  it('reports how long ago the last refresh was', async () => {
    await renderView({ lastSyncedAt: new Date(Date.now() - 5 * 60 * 1000) });

    expect(screen.getByText('Last refreshed 5 minutes ago')).toBeInTheDocument();
    expect(screen.queryByText('Not refreshed yet')).not.toBeInTheDocument();
  });
});

describe('InvoiceGeneratorPageView toolbar actions', () => {
  it('exports CSV when asked', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView();

    await user.click(screen.getByRole('button', { name: 'Export to CSV' }));

    expect(props.handleExportCSV).toHaveBeenCalledTimes(1);
  });

  it('locks CSV export out while an export is already running', async () => {
    await renderView({ exportingCSV: true });

    expect(screen.getByRole('button', { name: 'Export to CSV' })).toBeDisabled();
  });

  it('labels the invoice button from the board type', async () => {
    await renderView({ invoiceLabel: 'Tax Invoice' });

    expect(screen.getByRole('button', { name: 'Tax Invoice' })).toBeInTheDocument();
  });

  it('opens the invoice modal when the invoice button is pressed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView();

    await user.click(screen.getByRole('button', { name: 'Participant Tax Invoice' }));

    expect(props.handleOpenInvoiceModal).toHaveBeenCalledTimes(1);
  });

  it('resyncs when asked', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView();

    await user.click(screen.getByRole('button', { name: /Resync Data/ }));

    expect(props.handleManualSync).toHaveBeenCalledTimes(1);
  });

  it('blocks resync while this board is already syncing', async () => {
    await renderView({
      boardId: 'b-1',
      syncStatuses: [{ boardId: 'b-1', boardName: 'Board 1', status: 'in-progress', syncType: 'manual_triggered_sync', startTime: new Date().toISOString() }],
    });

    expect(screen.getByRole('button', { name: /Resync Data/ })).toBeDisabled();
  });

  it('leaves resync available when a different board is syncing', async () => {
    await renderView({
      boardId: 'b-1',
      syncStatuses: [{ boardId: 'b-2', boardName: 'Board 2', status: 'in-progress', syncType: 'manual_triggered_sync', startTime: new Date().toISOString() }],
    });

    expect(screen.getByRole('button', { name: /Resync Data/ })).toBeEnabled();
  });

  it('leaves resync available when this board has finished syncing', async () => {
    await renderView({
      boardId: 'b-1',
      syncStatuses: [{ boardId: 'b-1', boardName: 'Board 1', status: 'completed', syncType: 'manual_triggered_sync', startTime: new Date().toISOString() }],
    });

    expect(screen.getByRole('button', { name: /Resync Data/ })).toBeEnabled();
  });
});

describe('InvoiceGeneratorPageView summary tiles', () => {
  it('shows the record count and the money total', async () => {
    await renderView();

    expect(screen.getByText('Total Records')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // 200 + 80.50 - 42.75 = 237.75
    expect(screen.getByText('$237.75')).toBeInTheDocument();
  });

  it('breaks out subsidy and contribution on a Support at Home board', async () => {
    await renderView();

    // 150 + 60.50 - 42.75 = 167.75
    expect(screen.getByText('$167.75')).toBeInTheDocument();
    // 50 + 20 + 0 = 70
    expect(screen.getByText('$70.00')).toBeInTheDocument();
    expect(screen.getByText('Total Government Subsidy')).toBeInTheDocument();
    expect(screen.getByText('Total Participant Contribution')).toBeInTheDocument();
  });

  it('drops both breakdown tiles on an NDIS board', async () => {
    await renderView({ isNdisBoard: true });

    expect(screen.queryByText('Total Government Subsidy')).not.toBeInTheDocument();
    expect(screen.queryByText('Total Participant Contribution')).not.toBeInTheDocument();
    expect(screen.getByText('Total Records')).toBeInTheDocument();
  });

  it('drops both breakdown tiles on a low-category board', async () => {
    await renderView({ isLowCatBoard: true });

    expect(screen.queryByText('Total Government Subsidy')).not.toBeInTheDocument();
    expect(screen.queryByText('Total Participant Contribution')).not.toBeInTheDocument();
  });

  it('renders a zero total as currency rather than a blank', async () => {
    // currentItems is emptied so the only currency on screen is the tiles'.
    await renderView({
      currentItems: [],
      filteredSummary: {
        totalRecords: 0,
        totalAmount: 0,
        totalGovSubsidy: 0,
        totalParticipantContribution: 0,
      },
    });

    expect(screen.getAllByText('$0.00')).toHaveLength(3);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('renders a net-negative total with its sign', async () => {
    await renderView({
      currentItems: [],
      filteredSummary: {
        totalRecords: 1,
        totalAmount: -42.75,
        totalGovSubsidy: -42.75,
        totalParticipantContribution: 0,
      },
    });

    // Total Amount and Total Government Subsidy tiles; the contribution tile is $0.00.
    expect(screen.getAllByText('-$42.75')).toHaveLength(2);
    expect(screen.getByText('$0.00')).toBeInTheDocument();
  });
});

describe('InvoiceGeneratorPageView table body', () => {
  it('lists one row per record', async () => {
    await renderView();

    // 1 header row + 3 record rows
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });

  it('shows each participant and service', async () => {
    await renderView();

    expect(screen.getByRole('cell', { name: 'Grace Hopper' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Personal Care' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Alan Turing' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Domestic Assistance' })).toBeInTheDocument();
  });

  it('formats each row amount as currency', async () => {
    await renderView();

    expect(screen.getByRole('cell', { name: '$200.00' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '$150.00' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '$50.00' })).toBeInTheDocument();
    // r-2 bills one unit at 80.50, so unit price and total are the same figure.
    expect(screen.getAllByRole('cell', { name: '$80.50' })).toHaveLength(2);
  });

  it('keeps a negative row amount negative', async () => {
    await renderView();

    // r-3 carries -42.75 as both total and subsidy.
    expect(screen.getAllByRole('cell', { name: '-$42.75' })).toHaveLength(2);
  });

  it('renders a single record on its own', async () => {
    await renderView({ currentItems: [RECORDS[0]] });

    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('cell', { name: 'Grace Hopper' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Alan Turing' })).not.toBeInTheDocument();
  });

  it('offers a download only for the record that has a file', async () => {
    await renderView();

    expect(screen.getByRole('button', { name: 'Invoice #INV-0042' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Invoice #/ })).toHaveLength(1);
  });

  it('downloads that record when the link is pressed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView();

    await user.click(screen.getByRole('button', { name: 'Invoice #INV-0042' }));

    expect(props.onDownloadPdf).toHaveBeenCalledWith('https://files.example.com/INV-0042.pdf', 'INV-0042');
  });

  it('strips markup out of the notes column', async () => {
    await renderView();

    expect(screen.getByRole('cell', { name: 'Two hours of personal care' })).toBeInTheDocument();
  });
});

describe('InvoiceGeneratorPageView table states', () => {
  it('says so while records are loading', async () => {
    await renderView({ loading: true });

    expect(screen.getByText('Loading service records...')).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Grace Hopper' })).not.toBeInTheDocument();
  });

  it('surfaces the error message when the fetch failed', async () => {
    await renderView({ loading: false, error: 'Board sync is still running' });

    expect(screen.getByText('Error: Board sync is still running')).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Grace Hopper' })).not.toBeInTheDocument();
  });

  it('shows the empty state when the filters match nothing', async () => {
    await renderView({ currentItems: [] });

    expect(screen.getByText('No service records found matching your criteria.')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it('prefers loading over an error', async () => {
    await renderView({ loading: true, error: 'boom' });

    expect(screen.getByText('Loading service records...')).toBeInTheDocument();
    expect(screen.queryByText('Error: boom')).not.toBeInTheDocument();
  });

  it('prefers an error over the empty state', async () => {
    await renderView({ loading: false, error: 'boom', currentItems: [] });

    expect(screen.getByText('Error: boom')).toBeInTheDocument();
    expect(screen.queryByText('No service records found matching your criteria.')).not.toBeInTheDocument();
  });
});

describe('InvoiceGeneratorPageView column sorting', () => {
  it('renders the default board column headings', async () => {
    await renderView();

    expect(screen.getByRole('columnheader', { name: /^Participant$/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Scheduled Service Date/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Government Subsidy/ })).toBeInTheDocument();
  });

  it('renames the status column for an NDIS board', async () => {
    await renderView({ isNdisBoard: true, ndisStatusFieldLabel: 'Support Status' });

    expect(screen.getByRole('columnheader', { name: 'Support Status' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Transaction Status' })).not.toBeInTheDocument();
  });

  it('switches the sort column when an inactive sortable header is clicked', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ sortBy: 'scheduledServiceDate', sortOrder: 'desc' });

    await user.click(screen.getByRole('columnheader', { name: /Service Delivery Date/ }));

    expect(props.setSortBy).toHaveBeenCalledWith('serviceDeliveryDate');
    expect(props.setSortOrder).toHaveBeenCalledWith('asc');
  });

  it('flips the order when the active sortable header is clicked again', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ sortBy: 'scheduledServiceDate', sortOrder: 'asc' });

    await user.click(screen.getByRole('columnheader', { name: /Scheduled Service Date/ }));

    expect(props.setSortBy).not.toHaveBeenCalled();
    const updater = props.setSortOrder.mock.calls[0][0] as (prev: 'asc' | 'desc') => string;
    expect(updater('asc')).toBe('desc');
    expect(updater('desc')).toBe('asc');
  });

  it('ignores clicks on a column that cannot be sorted', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView();

    await user.click(screen.getByRole('columnheader', { name: /^Participant$/ }));

    expect(props.setSortBy).not.toHaveBeenCalled();
    expect(props.setSortOrder).not.toHaveBeenCalled();
  });
});

describe('InvoiceGeneratorPageView horizontal scroll affordances', () => {
  it('hides both arrows when the table fits', async () => {
    await renderView({ canScrollLeft: false, canScrollRight: false });

    expect(screen.queryByRole('button', { name: 'Scroll table left' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scroll table right' })).not.toBeInTheDocument();
  });

  it('offers the right arrow when there is more to the right', async () => {
    await renderView({ canScrollRight: true });

    expect(screen.getByRole('button', { name: 'Scroll table right' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scroll table left' })).not.toBeInTheDocument();
  });

  it('scrolls in the direction that was pressed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ canScrollLeft: true, canScrollRight: true });

    await user.click(screen.getByRole('button', { name: 'Scroll table left' }));
    expect(props.handleHorizontalScroll).toHaveBeenLastCalledWith('left');

    await user.click(screen.getByRole('button', { name: 'Scroll table right' }));
    expect(props.handleHorizontalScroll).toHaveBeenLastCalledWith('right');
  });
});

describe('InvoiceGeneratorPageView pagination', () => {
  // PaginationControls renders anchors with no href, so they carry no link role.
  const pageNav = () => screen.getByRole('navigation', { name: 'pagination' });

  it('lists every page while there are few of them', async () => {
    await renderView({ totalPages: 3, currentPage: 1 });

    const texts = Array.from(pageNav().querySelectorAll('a')).map((a) => a.textContent?.trim());
    expect(texts).toEqual(['Previous', '1', '2', '3', 'Next']);
  });

  it('marks the page the user is on', async () => {
    await renderView({ totalPages: 3, currentPage: 2 });

    expect(within(pageNav()).getByText('2').closest('a')).toHaveAttribute('aria-current', 'page');
    expect(within(pageNav()).getByText('1').closest('a')).not.toHaveAttribute('aria-current');
  });

  it('asks for the page that was clicked', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ totalPages: 3, currentPage: 1 });

    await user.click(within(pageNav()).getByText('3'));

    expect(props.setCurrentPage).toHaveBeenCalledWith(3);
  });

  it('renders nothing at all when there are no pages', async () => {
    await renderView({ totalPages: 0, currentPage: 1 });

    expect(screen.queryByRole('navigation', { name: 'pagination' })).not.toBeInTheDocument();
  });
});

describe('InvoiceGeneratorPageView resync help dialog', () => {
  it('stays closed by default', async () => {
    await renderView({ showHelpDialog: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('explains what resync does when open', async () => {
    await renderView({ showHelpDialog: true });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Understanding how resync works')).toBeInTheDocument();
    expect(screen.getByText(/downloads brand-new data from the server/)).toBeInTheDocument();
  });

  it('closes on Got it', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ showHelpDialog: true });

    await user.click(screen.getByRole('button', { name: 'Got it' }));

    expect(props.setShowHelpDialog).toHaveBeenCalledWith(false);
  });
});

describe('InvoiceGeneratorPageView invoice dialog', () => {
  it('is not rendered while closed', async () => {
    await renderView({ showInvoiceModal: false });

    expect(screen.queryByRole('heading', { name: 'Generate Invoice' })).not.toBeInTheDocument();
  });

  it('lists the eligible records once open', async () => {
    await renderView({ showInvoiceModal: true, eligibleRecords: ELIGIBLE });

    // Scoped to the dialog: the same services also appear in the table behind it.
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('heading', { name: 'Generate Invoice' })).toBeInTheDocument();
    expect(dialog.getByText('Personal Care')).toBeInTheDocument();
    expect(dialog.getByText('Domestic Assistance')).toBeInTheDocument();
    expect(dialog.getByText('Credit note')).toBeInTheDocument();
    expect(dialog.getAllByRole('checkbox')).toHaveLength(3);
  });

  it('flags a record that has already been invoiced', async () => {
    await renderView({ showInvoiceModal: true, eligibleRecords: ELIGIBLE });

    // Only e-2 carries an invoiceNumber.
    expect(within(screen.getByRole('dialog')).getAllByText('Invoiced')).toHaveLength(1);
  });

  it("shows each record's own invoice amount", async () => {
    await renderView({ showInvoiceModal: true, eligibleRecords: ELIGIBLE });

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('$50.00')).toBeInTheDocument();
    expect(dialog.getByText('$20.00')).toBeInTheDocument();
    expect(dialog.getByText('-$12.50')).toBeInTheDocument();
  });

  it('totals only the records that are selected', async () => {
    await renderView({
      showInvoiceModal: true,
      eligibleRecords: ELIGIBLE,
      selectedItems: new Set(['e-1', 'e-3']),
    });

    // 50.00 + (-12.50) = 37.50 — e-2's 20.00 is deliberately left out.
    expect(screen.getByText('Total: $37.50 (2 selected)')).toBeInTheDocument();
  });

  it('totals to zero while nothing is selected', async () => {
    await renderView({
      showInvoiceModal: true,
      eligibleRecords: ELIGIBLE,
      selectedItems: new Set<string>(),
    });

    expect(screen.getByText('Total: $0.00 (0 selected)')).toBeInTheDocument();
  });

  it('shows the empty state when nothing is eligible', async () => {
    await renderView({ showInvoiceModal: true, eligibleRecords: [] });

    expect(screen.getByText('No eligible records found matching your filters.')).toBeInTheDocument();
  });

  it('shows a loading state while the eligible list is being fetched', async () => {
    await renderView({ showInvoiceModal: true, loadingEligible: true, eligibleRecords: [] });

    expect(screen.getByText('Loading eligible records...')).toBeInTheDocument();
    expect(screen.queryByText('No eligible records found matching your filters.')).not.toBeInTheDocument();
  });

  it('toggles a record when its checkbox is pressed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ showInvoiceModal: true, eligibleRecords: ELIGIBLE });

    await user.click(screen.getAllByRole('checkbox')[1]);

    expect(props.handleToggleItem).toHaveBeenCalledWith('e-2');
  });

  it('offers Select All while nothing is selected', async () => {
    await renderView({ showInvoiceModal: true, eligibleRecords: ELIGIBLE });

    expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
  });

  it('offers Deselect All once everything is selected', async () => {
    await renderView({
      showInvoiceModal: true,
      eligibleRecords: ELIGIBLE,
      selectedItems: new Set(['e-1', 'e-2', 'e-3']),
    });

    expect(screen.getByRole('button', { name: 'Deselect All' })).toBeInTheDocument();
  });

  it('refuses to generate while nothing is selected', async () => {
    await renderView({ showInvoiceModal: true, eligibleRecords: ELIGIBLE });

    expect(screen.getByRole('button', { name: /Generate PDF Invoice/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Generate Xero Invoice/ })).toBeDisabled();
  });

  it('generates the PDF invoice when pressed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({
      showInvoiceModal: true,
      eligibleRecords: ELIGIBLE,
      selectedItems: new Set(['e-1']),
    });

    await user.click(screen.getByRole('button', { name: /Generate PDF Invoice/ }));

    expect(props.handleGeneratePDFInvoice).toHaveBeenCalledTimes(1);
    expect(props.handleGenerateXeroInvoice).not.toHaveBeenCalled();
  });

  it('generates the Xero invoice when pressed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({
      showInvoiceModal: true,
      eligibleRecords: ELIGIBLE,
      selectedItems: new Set(['e-1']),
    });

    await user.click(screen.getByRole('button', { name: /Generate Xero Invoice/ }));

    expect(props.handleGenerateXeroInvoice).toHaveBeenCalledTimes(1);
    expect(props.handleGeneratePDFInvoice).not.toHaveBeenCalled();
  });

  it('locks both generate buttons while a PDF is in flight', async () => {
    await renderView({
      showInvoiceModal: true,
      eligibleRecords: ELIGIBLE,
      selectedItems: new Set(['e-1']),
      generatingPDF: true,
    });

    expect(screen.getByRole('button', { name: 'Generating...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Generate Xero Invoice/ })).toBeDisabled();
  });

  it('locks both generate buttons while Xero is in flight', async () => {
    await renderView({
      showInvoiceModal: true,
      eligibleRecords: ELIGIBLE,
      selectedItems: new Set(['e-1']),
      generatingXero: true,
    });

    expect(screen.getByRole('button', { name: 'Generating...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Generate PDF Invoice/ })).toBeDisabled();
  });
});
