import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ContextProvider } from '@/app/context';
import { MonthlyStatementPageView } from '@/lib/monthly-statement-page-view';
import { server } from '../../msw/server';

/**
 * The monthly statement page view is a shell around four private pieces: the
 * participant/month/year toolbar, the statement panel, the "nothing loaded yet"
 * card, and the help + business-details dialogs. The toolbar's gating (which
 * selections make Load Statement pressable) and the business dialog's country →
 * state dependency are the parts with real logic, so they carry most of the
 * tests below.
 */

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
  usePathname: () => '/workspace/ws-1/board/b-1/monthly-statement',
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
  server.use(http.get('*/api/auth/verify', () => HttpResponse.json({ user: ADA })));
  push.mockReset();
  window.localStorage.clear();
});

const MONTHS = [
  { value: '01', label: 'January' },
  { value: '02', label: 'February' },
  { value: '03', label: 'March' },
  { value: '04', label: 'April' },
  { value: '05', label: 'May' },
  { value: '06', label: 'June' },
  { value: '07', label: 'July' },
  { value: '08', label: 'August' },
  { value: '09', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
];

const YEARS = ['2024', '2025', '2026'];

const COUNTRY_STATES: Record<string, string[]> = {
  Australia: ['VIC', 'NSW', 'QLD'],
  'New Zealand': [],
};

const BUSINESS_DETAILS = {
  companyName: 'Hillsgrade Care',
  phoneNumber: '03 9000 0000',
  businessEmail: 'accounts@hillsgrade.example',
  address: '1 Provider Way',
  location: '',
  country: 'Australia',
  suburb: 'Melbourne',
  state: 'VIC',
  postcode: '3000',
  companyRegistrationId: 'ABN 12 345 678 901',
};

const formatCurrency = (amount?: number | null) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(amount || 0);

const STATEMENT_DATA = {
  participant: 'Grace Hopper',
  month: 'March',
  year: '2026',
  monthNumber: '03',
  participantAddress: '12 Ada Street',
  participantSuburb: 'Carlton',
  participantState: 'VIC',
  participantPostcode: '3053',
  myAgedCareIdNumber: 'AC-778899',
  providerId: 'PRV-001',
  services: [],
  budgetCategories: [],
  fundingSources: [],
  summary: {
    totalServices: 7,
    totalHours: 12,
    totalAmount: 3120.25,
    govSubsidy: 2496.2,
    participantContribution: 624.05,
  },
};

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    router,
    id: 'ws-1',
    boardId: 'b-1',
    isPrintMode: false,
    loadingParticipants: false,
    uniqueParticipants: ['Grace Hopper', 'Alan Turing'],
    selectedParticipant: 'Grace Hopper',
    setSelectedParticipant: vi.fn(),
    months: MONTHS,
    selectedMonth: '03',
    setSelectedMonth: vi.fn(),
    years: YEARS,
    selectedYear: '2026',
    setSelectedYear: vi.fn(),
    handleManualSync: vi.fn(),
    isManualSyncing: false,
    syncStatuses: [],
    setShowHelpDialog: vi.fn(),
    fetchStatementData: vi.fn(),
    loading: false,
    exportingSection: null,

    // No statement loaded by default, which is what keeps the statement panel
    // (covered in its own file) out of the way here.
    statementData: null,
    businessDetails: BUSINESS_DETAILS,
    formatCurrency,
    formatDate: (value: string) => (value ? value.slice(0, 10) : '-'),
    loadingServiceItems: false,
    chartConfigs: [],
    chartCardRefs: { current: [] as (HTMLElement | null)[] },
    chartContainerRef: { current: null },
    ChartXAxisTick: () => null,
    ChartBarValueLabel: () => null,
    categorizedBudgetSections: [],
    handleBudgetCategoryExportCSV: vi.fn(),
    isCurrencyColumn: (label: string) => label.includes('($'),
    isHourColumn: (label: string) => label.includes('(Hr.)'),
    formatBudgetCellDisplay: () => '',
    serviceTransactionStatusFilter: 'all',
    setServiceTransactionStatusFilter: vi.fn(),
    serviceFundingSourceFilter: 'all',
    setServiceFundingSourceFilter: vi.fn(),
    distinctTransactionStatuses: [],
    distinctFundingSources: [],
    fetchServiceItems: vi.fn(),
    servicePagination: { page: 1, limit: 25 },
    serviceSortBy: 'scheduledServiceDate',
    serviceSortOrder: 'desc',
    setServiceSortBy: vi.fn(),
    setServiceSortOrder: vi.fn(),
    handleServiceExportCSV: vi.fn(),
    serviceItems: [],
    handleServicePageChange: vi.fn(),
    serviceTotalPages: 1,
    getServiceProviderLabel: () => 'N/A',
    sanitizeNotesHtml: (html: string) => html,
    handleSaHMonthlyStatement: vi.fn(),

    showHelpDialog: false,
    showBusinessDialog: false,
    setShowBusinessDialog: vi.fn(),
    businessDetailsErrors: [] as string[],
    setBusinessDetails: vi.fn(),
    countryStates: COUNTRY_STATES,
    handleSaveBusinessDetails: vi.fn(),
    ...overrides,
  };
}

async function renderView(overrides: Record<string, unknown> = {}) {
  const props = baseProps(overrides);
  render(
    <ContextProvider>
      <MonthlyStatementPageView {...props} />
    </ContextProvider>,
  );
  // The Header verifies the session on mount; wait for the resulting state
  // update so it never lands after the test finishes.
  await screen.findByText('AL');
  return props;
}

describe('MonthlyStatementPageView toolbar', () => {
  it('names the page and says what it produces', async () => {
    await renderView();

    expect(
      screen.getByRole('heading', { name: 'Monthly Statement Generator', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/generate the Support at Home monthly statement/)).toBeInTheDocument();
  });

  it('returns to the board when Back is pressed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderView({ id: 'ws-4', boardId: 'b-9' });

    await user.click(screen.getByRole('button', { name: 'Back to Board' }));

    expect(push).toHaveBeenCalledWith('/workspace/ws-4/board/b-9');
  });

  it('disappears entirely in print mode', async () => {
    await renderView({ isPrintMode: true });

    expect(screen.queryByRole('heading', { name: 'Monthly Statement Generator' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to Board' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load Statement' })).not.toBeInTheDocument();
  });

  it('keeps the rest of the page in print mode', async () => {
    await renderView({ isPrintMode: true });

    expect(screen.getByRole('heading', { name: 'No Statement Loaded' })).toBeInTheDocument();
  });
});

/**
 * Radix Select triggers are comboboxes whose accessible name computes to '' —
 * the toolbar's three appear in render order: participant, month, year.
 */
const participantSelect = () => screen.getAllByRole('combobox')[0];
const monthSelect = () => screen.getAllByRole('combobox')[1];
const yearSelect = () => screen.getAllByRole('combobox')[2];

describe('MonthlyStatementPageView participant picker', () => {
  it('shows the participant that is already chosen', async () => {
    await renderView({ selectedParticipant: 'Alan Turing' });

    expect(participantSelect()).toHaveTextContent('Alan Turing');
  });

  it('waits, disabled, while the participant list loads', async () => {
    await renderView({ loadingParticipants: true, selectedParticipant: '', uniqueParticipants: [] });

    expect(participantSelect()).toBeDisabled();
    expect(participantSelect()).toHaveTextContent('Loading participants...');
  });

  it('prompts for a choice once the list has loaded', async () => {
    await renderView({ selectedParticipant: '' });

    expect(participantSelect()).toBeEnabled();
    expect(participantSelect()).toHaveTextContent('Select participant');
  });

  it('lists every participant it was given', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderView({ selectedParticipant: '' });

    await user.click(participantSelect());

    expect(await screen.findByRole('option', { name: 'Grace Hopper' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Alan Turing' })).toBeInTheDocument();
  });

  it('says so, disabled, when there are no participants at all', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderView({ selectedParticipant: '', uniqueParticipants: [] });

    await user.click(participantSelect());

    expect(await screen.findByRole('option', { name: 'No participants found' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.queryByRole('option', { name: 'Grace Hopper' })).not.toBeInTheDocument();
  });

  it('reports the participant that was chosen', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ selectedParticipant: '' });

    await user.click(participantSelect());
    await user.click(await screen.findByRole('option', { name: 'Alan Turing' }));

    expect(props.setSelectedParticipant).toHaveBeenCalledWith('Alan Turing');
  });
});

describe('MonthlyStatementPageView month and year pickers', () => {
  it('shows the month label for the value it holds', async () => {
    await renderView({ selectedMonth: '03' });

    expect(monthSelect()).toHaveTextContent('March');
  });

  it('reports the month value, not its label', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ selectedMonth: '03' });

    await user.click(monthSelect());
    await user.click(await screen.findByRole('option', { name: 'April' }));

    expect(props.setSelectedMonth).toHaveBeenCalledWith('04');
  });

  it('offers all twelve months', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderView({ selectedMonth: '03' });

    await user.click(monthSelect());

    expect(await screen.findAllByRole('option')).toHaveLength(12);
  });

  it('reports the year that was chosen', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ selectedYear: '2026' });

    await user.click(yearSelect());
    await user.click(await screen.findByRole('option', { name: '2024' }));

    expect(props.setSelectedYear).toHaveBeenCalledWith('2024');
  });

  it('prompts for a month and a year when neither is set', async () => {
    await renderView({ selectedMonth: '', selectedYear: '' });

    expect(monthSelect()).toHaveTextContent('Select month');
    expect(yearSelect()).toHaveTextContent('Select year');
  });
});

describe('MonthlyStatementPageView Load Statement gate', () => {
  it('is pressable once participant, month and year are all set', async () => {
    await renderView();

    expect(screen.getByRole('button', { name: 'Load Statement' })).toBeEnabled();
  });

  it('loads the statement when pressed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView();

    await user.click(screen.getByRole('button', { name: 'Load Statement' }));

    expect(props.fetchStatementData).toHaveBeenCalledTimes(1);
  });

  it('is blocked while no participant is chosen', async () => {
    await renderView({ selectedParticipant: '' });

    expect(screen.getByRole('button', { name: 'Load Statement' })).toBeDisabled();
  });

  it('is blocked while no month is chosen', async () => {
    await renderView({ selectedMonth: '' });

    expect(screen.getByRole('button', { name: 'Load Statement' })).toBeDisabled();
  });

  it('is blocked while no year is chosen', async () => {
    await renderView({ selectedYear: '' });

    expect(screen.getByRole('button', { name: 'Load Statement' })).toBeDisabled();
  });

  it('is blocked while a load is already running', async () => {
    await renderView({ loading: true });

    expect(screen.getByRole('button', { name: 'Load Statement' })).toBeDisabled();
  });

  it('is blocked while the statement PDF is being generated', async () => {
    await renderView({ exportingSection: 'statement-pdf' });

    expect(screen.getByRole('button', { name: 'Load Statement' })).toBeDisabled();
  });

  it('stays pressable while an unrelated section is exporting', async () => {
    await renderView({ exportingSection: 'service-csv' });

    expect(screen.getByRole('button', { name: 'Load Statement' })).toBeEnabled();
  });
});

describe('MonthlyStatementPageView resync button', () => {
  it('resyncs when pressed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView();

    await user.click(screen.getByRole('button', { name: /Resync Data/ }));

    expect(props.handleManualSync).toHaveBeenCalledTimes(1);
  });

  it('is blocked while this board is already syncing', async () => {
    await renderView({
      boardId: 'b-1',
      syncStatuses: [{ boardId: 'b-1', status: 'started' }],
    });

    expect(screen.getByRole('button', { name: /Resync Data/ })).toBeDisabled();
  });

  it('stays available when a different board is syncing', async () => {
    await renderView({
      boardId: 'b-1',
      syncStatuses: [{ boardId: 'b-2', status: 'in-progress' }],
    });

    expect(screen.getByRole('button', { name: /Resync Data/ })).toBeEnabled();
  });

  it('reports progress while a manual sync is in flight', async () => {
    await renderView({ isManualSyncing: true });

    expect(screen.getByRole('button', { name: /Syncing\.\.\./ })).toBeDisabled();
  });
});

describe('MonthlyStatementPageView empty state', () => {
  it('invites the user to pick a participant when nothing is loaded', async () => {
    await renderView({ statementData: null, loading: false });

    expect(screen.getByRole('heading', { name: 'No Statement Loaded' })).toBeInTheDocument();
    expect(
      screen.getByText('Select a participant, month, and year above to generate the monthly statement'),
    ).toBeInTheDocument();
  });

  it('stands down while a statement is being fetched', async () => {
    await renderView({ statementData: null, loading: true });

    expect(screen.queryByRole('heading', { name: 'No Statement Loaded' })).not.toBeInTheDocument();
  });

  it('stands down once a statement has arrived', async () => {
    await renderView({ statementData: STATEMENT_DATA });

    expect(screen.queryByRole('heading', { name: 'No Statement Loaded' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Support at Home Monthly Statement' }),
    ).toBeInTheDocument();
  });
});

describe('MonthlyStatementPageView help dialog', () => {
  it('stays closed by default', async () => {
    await renderView({ showHelpDialog: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('explains what resync does when open', async () => {
    await renderView({ showHelpDialog: true });

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Understanding how resync works')).toBeInTheDocument();
    expect(dialog.getByText(/downloads brand-new data from the server/)).toBeInTheDocument();
  });

  it('closes on Got it', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ showHelpDialog: true });

    await user.click(screen.getByRole('button', { name: 'Got it' }));

    expect(props.setShowHelpDialog).toHaveBeenCalledWith(false);
  });
});

describe('MonthlyStatementPageView business details dialog', () => {
  it('stays closed by default', async () => {
    await renderView({ showBusinessDialog: false });

    expect(screen.queryByLabelText('Company Name *')).not.toBeInTheDocument();
  });

  it('shows the current details when open', async () => {
    await renderView({ showBusinessDialog: true });

    expect(screen.getByLabelText('Company Name *')).toHaveValue('Hillsgrade Care');
    expect(screen.getByLabelText('Company Registration ID *')).toHaveValue('ABN 12 345 678 901');
    expect(screen.getByLabelText('Phone Number *')).toHaveValue('03 9000 0000');
    expect(screen.getByLabelText('Business Email *')).toHaveValue('accounts@hillsgrade.example');
    expect(screen.getByLabelText('Street Address')).toHaveValue('1 Provider Way');
    expect(screen.getByLabelText('Suburb')).toHaveValue('Melbourne');
    expect(screen.getByLabelText('Postcode')).toHaveValue('3000');
  });

  it('reports an edited field without dropping the rest', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ showBusinessDialog: true });

    await user.type(screen.getByLabelText('Suburb'), 'X');

    expect(props.setBusinessDetails).toHaveBeenCalledWith({
      ...BUSINESS_DETAILS,
      suburb: 'MelbourneX',
    });
  });

  it('lists validation errors when there are any', async () => {
    await renderView({
      showBusinessDialog: true,
      businessDetailsErrors: ['Company name is required', 'Business email is invalid'],
    });

    expect(screen.getByText('Please correct the following errors:')).toBeInTheDocument();
    expect(screen.getByText('Company name is required')).toBeInTheDocument();
    expect(screen.getByText('Business email is invalid')).toBeInTheDocument();
  });

  it('shows no error panel when there are none', async () => {
    await renderView({ showBusinessDialog: true, businessDetailsErrors: [] });

    expect(screen.queryByText('Please correct the following errors:')).not.toBeInTheDocument();
  });

  it('clears the state when the country changes', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ showBusinessDialog: true });

    await user.click(screen.getByLabelText('Country'));
    await user.click(await screen.findByRole('option', { name: 'New Zealand' }));

    expect(props.setBusinessDetails).toHaveBeenCalledWith({
      ...BUSINESS_DETAILS,
      country: 'New Zealand',
      state: '',
    });
  });

  it('offers the states of the chosen country', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ showBusinessDialog: true });

    await user.click(screen.getByLabelText('State / Province'));
    await user.click(await screen.findByRole('option', { name: 'QLD' }));

    expect(props.setBusinessDetails).toHaveBeenCalledWith({ ...BUSINESS_DETAILS, state: 'QLD' });
  });

  it('asks for a country first when none is chosen', async () => {
    await renderView({
      showBusinessDialog: true,
      businessDetails: { ...BUSINESS_DETAILS, country: '', state: '' },
    });

    expect(screen.getByLabelText('State / Province')).toBeDisabled();
    expect(screen.getByText('Select country first')).toBeInTheDocument();
  });

  it('says so when the chosen country has no states', async () => {
    await renderView({
      showBusinessDialog: true,
      businessDetails: { ...BUSINESS_DETAILS, country: 'New Zealand', state: '' },
    });

    expect(screen.getByLabelText('State / Province')).toBeDisabled();
    expect(screen.getByText('No states available')).toBeInTheDocument();
  });

  it('saves when Save Details is pressed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ showBusinessDialog: true });

    await user.click(screen.getByRole('button', { name: 'Save Details' }));

    expect(props.handleSaveBusinessDetails).toHaveBeenCalledTimes(1);
    expect(props.setShowBusinessDialog).not.toHaveBeenCalled();
  });

  it('closes without saving when Cancel is pressed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = await renderView({ showBusinessDialog: true });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(props.setShowBusinessDialog).toHaveBeenCalledWith(false);
    expect(props.handleSaveBusinessDetails).not.toHaveBeenCalled();
  });
});
