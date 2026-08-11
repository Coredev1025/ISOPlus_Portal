import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MonthlyStatementStatementPanel } from '@/lib/monthly-statement-page-components';

/**
 * `MonthlyStatementStatementPanel` is the only export of the module, but it is a
 * facade over five private sections — the statement header, the budget mini
 * charts, the individualised budget tables, the service records table and the
 * summary footer. Each is exercised here through the public component, which is
 * how the product renders them.
 *
 * The panel is what a participant's statement looks like before it becomes a
 * PDF, so the figures on screen are the ones that get printed: every currency
 * assertion below is hand-derived, not read back out of a formatter.
 */

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

const formatCurrency = (amount?: number | null) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(amount || 0);

const formatDate = (value: string) => (value ? value.slice(0, 10) : '-');

const STATEMENT_DATA = {
  participant: 'Grace Hopper',
  participantProfile: 'Home Support',
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
  fundingSources: ['Home Support Quarterly Budget'],
  summary: {
    totalServices: 7,
    totalHours: 12,
    totalAmount: 3120.25,
    govSubsidy: 2496.2,
    participantContribution: 624.05,
  },
};

const BUSINESS_DETAILS = {
  companyName: 'Hillsgrade Care',
  phoneNumber: '03 9000 0000',
  businessEmail: 'accounts@hillsgrade.example',
  address: '1 Provider Way, Melbourne',
  location: '',
  country: 'Australia',
  suburb: 'Melbourne',
  state: 'VIC',
  postcode: '3000',
  companyRegistrationId: 'ABN 12 345 678 901',
};

const CHART_CONFIGS = [
  {
    code: 'HSQ',
    title: 'Home Support Quarterly Budget',
    subtitle: 'January - March',
    hasData: true,
    serviceCount: 5,
    metrics: [{ label: 'Expenditure', value: 800 }],
    data: [
      { name: 'available', label: 'Available fund', shortLabel: 'Available', value: 2000, color: '#22c55e' },
      { name: 'expenditure', label: 'March expenditure', shortLabel: 'March', value: 800, color: '#ef4444' },
      { name: 'remaining', label: 'Remaining balance', shortLabel: 'Remaining', value: 1200, color: '#3b82f6' },
    ],
    chartConfig: {
      available: { label: 'Available fund', color: '#22c55e' },
      expenditure: { label: 'March expenditure', color: '#ef4444' },
      remaining: { label: 'Remaining balance', color: '#3b82f6' },
    },
  },
  {
    code: 'HSCM',
    title: 'Home Support Care Management Budget',
    subtitle: 'March',
    hasData: false,
    serviceCount: 0,
    metrics: [],
    data: [
      { name: 'available', label: 'Available fund', shortLabel: 'Available', value: 0, color: '#22c55e' },
    ],
    chartConfig: { available: { label: 'Available fund', color: '#22c55e' } },
  },
];

const HSQ_COLUMNS = [
  'Funding Stream',
  'Fund Amount ($)',
  'Quarterly Budget ($)',
  'Allocated Care Management Time (Hr.)',
  'Notes',
];

const BUDGET_SECTIONS = [
  {
    categoryCode: 'HSQ',
    sectionTitle: 'Home Support Quarterly Budget',
    columns: HSQ_COLUMNS,
    items: [
      {
        id: 'b-1',
        'Funding Stream': 'Home Support',
        'Fund Amount ($)': 5000,
        'Quarterly Budget ($)': 1250,
        'Allocated Care Management Time (Hr.)': 3.5,
        Notes: 'Q1 allocation',
      },
      {
        id: 'b-2',
        'Funding Stream': 'Home Support',
        'Fund Amount ($)': -125.5,
        'Quarterly Budget ($)': 0,
        'Allocated Care Management Time (Hr.)': 0,
        Notes: '',
      },
    ],
  },
  {
    categoryCode: 'HMB',
    sectionTitle: 'Home Modification Budget',
    columns: HSQ_COLUMNS,
    items: [],
  },
];

const isCurrencyColumn = (label: string) => label.includes('($');
const isHourColumn = (label: string) => label.includes('(Hr.)');

const formatBudgetCellDisplay = (columnLabel: string, item: Record<string, any>) => {
  const raw = item[columnLabel];
  if (isHourColumn(columnLabel)) return Number(raw ?? 0).toFixed(2);
  if (isCurrencyColumn(columnLabel)) return formatCurrency(Number(raw ?? 0));
  return (raw ?? '') || 'N/A';
};

const SERVICE_ITEMS = [
  {
    id: 's-1',
    participant: 'Grace Hopper',
    service: 'Personal Care',
    serviceProvider: 'Hillsgrade Care',
    scheduledServiceDate: '2026-03-02T09:00:00.000Z',
    serviceDeliveryDate: '2026-03-02T11:00:00.000Z',
    transactionStatus: 'Service Delivered',
    committedAtHmForDelivery: 1,
    unit: 'Hour',
    quantity: 2,
    unitPrice: 100,
    totalAmount: 200,
    govSubsidy: 150,
    participantContribution: 50,
    fundingSource: 'Home Support Quarterly Budget',
    notes: '<p>Two hours of personal care</p>',
  },
  {
    id: 's-2',
    participantName: 'Grace Hopper',
    taskName: 'Domestic Assistance',
    deliveredBy: 'Second Provider',
    scheduledShiftStart: '2026-03-05T09:00:00.000Z',
    actualShiftEndDateTime: '2026-03-05T10:00:00.000Z',
    transactionStatus: '',
    committedAtHmForDelivery: 0,
    unit: 'Hour',
    quantity: 1,
    unitPrice: 80.5,
    totalAmount: 80.5,
    govSubsidy: 60.5,
    participantContribution: 20,
    fundingSource: '',
    notes: '',
  },
  {
    id: 's-3',
    participant: 'Grace Hopper',
    service: 'Refund adjustment',
    serviceProvider: 'Hillsgrade Care',
    scheduledServiceDate: null,
    serviceDeliveryDate: null,
    transactionStatus: 'Cancelled - Provider',
    unit: 'Each',
    quantity: 0,
    unitPrice: 42.75,
    totalAmount: -42.75,
    govSubsidy: -42.75,
    participantContribution: 0,
    fundingSource: 'Home Support Quarterly Budget',
    notes: '',
  },
];

const getServiceProviderLabel = (service: Record<string, any>) =>
  service.serviceProvider || service.deliveredBy || 'N/A';

const sanitizeNotesHtml = (html: string) =>
  html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    statementData: STATEMENT_DATA,
    businessDetails: BUSINESS_DETAILS,
    loading: false,
    exportingSection: null,
    handleSaHMonthlyStatement: vi.fn(),

    loadingServiceItems: false,
    chartConfigs: CHART_CONFIGS,
    chartCardRefs: { current: [] as (HTMLElement | null)[] },
    chartContainerRef: { current: null },
    formatCurrency,
    ChartXAxisTick: () => null,
    ChartBarValueLabel: () => null,

    categorizedBudgetSections: BUDGET_SECTIONS,
    handleBudgetCategoryExportCSV: vi.fn(),
    isCurrencyColumn,
    isHourColumn,
    formatBudgetCellDisplay,

    serviceTransactionStatusFilter: 'all',
    setServiceTransactionStatusFilter: vi.fn(),
    serviceFundingSourceFilter: 'all',
    setServiceFundingSourceFilter: vi.fn(),
    distinctTransactionStatuses: ['Service Delivered', 'Cancelled - Provider'],
    distinctFundingSources: ['Home Support Quarterly Budget'],
    fetchServiceItems: vi.fn(),
    servicePagination: { page: 1, limit: 25 },
    serviceSortBy: 'scheduledServiceDate',
    serviceSortOrder: 'desc',
    setServiceSortBy: vi.fn(),
    setServiceSortOrder: vi.fn(),
    handleServiceExportCSV: vi.fn(),
    serviceItems: SERVICE_ITEMS,
    handleServicePageChange: vi.fn(),
    serviceTotalPages: 3,
    formatDate,
    getServiceProviderLabel,
    sanitizeNotesHtml,
    ...overrides,
  };
}

function renderPanel(overrides: Record<string, unknown> = {}) {
  const props = baseProps(overrides);
  render(<MonthlyStatementStatementPanel {...props} />);
  return props;
}

/** The card a heading belongs to — the five sections repeat a lot of text. */
function cardFor(heading: string) {
  return screen.getByRole('heading', { name: heading }).closest('div.shadow-lg') as HTMLElement;
}

function budgetSectionFor(heading: string) {
  return screen.getByRole('heading', { name: heading }).closest('div.border') as HTMLElement;
}

describe('MonthlyStatementStatementPanel gate', () => {
  it('renders nothing at all until a statement has been loaded', () => {
    const { container } = render(
      <MonthlyStatementStatementPanel {...baseProps({ statementData: null })} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders the statement once one is loaded', () => {
    renderPanel();

    expect(
      screen.getByRole('heading', { name: 'Support at Home Monthly Statement' }),
    ).toBeInTheDocument();
  });
});

describe('MonthlyStatementStatementPanel statement header', () => {
  it('names the period and the participant', () => {
    renderPanel();

    const header = within(cardFor('Support at Home Monthly Statement'));
    expect(header.getByText('March 2026')).toBeInTheDocument();
    expect(header.getByText('Grace Hopper')).toBeInTheDocument();
  });

  it('shows the participant address and locality', () => {
    renderPanel();

    expect(screen.getByText('12 Ada Street')).toBeInTheDocument();
    expect(screen.getByText('Carlton, VIC, 3053')).toBeInTheDocument();
  });

  it('joins only the locality parts that exist', () => {
    renderPanel({
      statementData: { ...STATEMENT_DATA, participantSuburb: 'Carlton', participantState: '', participantPostcode: '3053' },
    });

    expect(screen.getByText('Carlton, 3053')).toBeInTheDocument();
  });

  it('falls back to an em dash when there is no locality at all', () => {
    renderPanel({
      statementData: { ...STATEMENT_DATA, participantSuburb: '', participantState: '', participantPostcode: '' },
    });

    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('says the address is not provided when it is missing', () => {
    renderPanel({ statementData: { ...STATEMENT_DATA, participantAddress: '' } });

    expect(screen.getByText('Not provided')).toBeInTheDocument();
    expect(screen.queryByText('12 Ada Street')).not.toBeInTheDocument();
  });

  it('shows the identifiers it was given', () => {
    renderPanel();

    expect(screen.getByText('AC-778899')).toBeInTheDocument();
    expect(screen.getByText('PRV-001')).toBeInTheDocument();
  });

  it('says both identifiers are not provided when they are missing', () => {
    renderPanel({ statementData: { ...STATEMENT_DATA, myAgedCareIdNumber: '', providerId: '' } });

    expect(screen.getAllByText('Not provided')).toHaveLength(2);
  });
});

describe('MonthlyStatementStatementPanel service provider block', () => {
  it('shows the provider details once a company name is configured', () => {
    renderPanel();

    const block = within(
      screen.getByRole('heading', { name: 'Service Provider Details' }).parentElement!,
    );
    expect(block.getByText('Hillsgrade Care')).toBeInTheDocument();
    expect(block.getByText('accounts@hillsgrade.example')).toBeInTheDocument();
    expect(block.getByText('ABN 12 345 678 901')).toBeInTheDocument();
    expect(block.getByText('1 Provider Way, Melbourne')).toBeInTheDocument();
  });

  it('hides the whole block while the company name is blank', () => {
    renderPanel({ businessDetails: { ...BUSINESS_DETAILS, companyName: '' } });

    expect(screen.queryByRole('heading', { name: 'Service Provider Details' })).not.toBeInTheDocument();
    expect(screen.queryByText('accounts@hillsgrade.example')).not.toBeInTheDocument();
  });

  it('marks a missing registration ID as N/A', () => {
    renderPanel({ businessDetails: { ...BUSINESS_DETAILS, companyRegistrationId: '' } });

    const block = within(
      screen.getByRole('heading', { name: 'Service Provider Details' }).parentElement!,
    );
    expect(block.getByText('Registration ID:').parentElement).toHaveTextContent('Registration ID: N/A');
  });
});

describe('MonthlyStatementStatementPanel generate action', () => {
  it('offers to generate the statement', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: 'Generate Monthly Statement' })).toBeEnabled();
  });

  it('generates when pressed', async () => {
    const user = userEvent.setup();
    const props = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Generate Monthly Statement' }));

    expect(props.handleSaHMonthlyStatement).toHaveBeenCalledTimes(1);
  });

  it('reports progress and locks out while the PDF is being built', () => {
    renderPanel({ exportingSection: 'statement-pdf' });

    expect(screen.getByRole('button', { name: 'Generating...' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Generate Monthly Statement' })).not.toBeInTheDocument();
  });

  it('locks out while the statement itself is reloading', () => {
    renderPanel({ loading: true });

    expect(screen.getByRole('button', { name: 'Generate Monthly Statement' })).toBeDisabled();
  });

  it('stays available while an unrelated section is exporting', () => {
    renderPanel({ exportingSection: 'service-csv' });

    expect(screen.getByRole('button', { name: 'Generate Monthly Statement' })).toBeEnabled();
  });
});

describe('MonthlyStatementStatementPanel budget mini charts', () => {
  it('renders one card per funding stream, titled', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Budget Mini Charts' })).toBeInTheDocument();
    expect(screen.getAllByText('Home Support Quarterly Budget').length).toBeGreaterThan(0);
    expect(screen.getByText('Home Support Care Management Budget')).toBeInTheDocument();
  });

  it('registers each card with the ref collection the PDF capture reads', () => {
    const props = renderPanel();

    expect(props.chartCardRefs.current).toHaveLength(2);
    expect(props.chartCardRefs.current[0]).toBeInstanceOf(HTMLElement);
    expect(props.chartCardRefs.current[1]).toBeInstanceOf(HTMLElement);
  });

  it('says so when the period produced no chartable services', () => {
    renderPanel({ chartConfigs: [] });

    expect(screen.getByText('No services found for the selected period')).toBeInTheDocument();
    expect(screen.queryByText('Home Support Care Management Budget')).not.toBeInTheDocument();
  });

  it('shows neither the cards nor the empty state while service items are loading', () => {
    renderPanel({ loadingServiceItems: true });

    expect(screen.queryByText('No services found for the selected period')).not.toBeInTheDocument();
    expect(screen.queryByText('Home Support Care Management Budget')).not.toBeInTheDocument();
  });
});

describe('MonthlyStatementStatementPanel individualised budgets', () => {
  it('renders a section per funding stream', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Individualised Budgets' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Home Modification Budget' })).toBeInTheDocument();
  });

  it('renders the column headings it was handed', () => {
    renderPanel();

    expect(screen.getByRole('columnheader', { name: 'Fund Amount ($)' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Allocated Care Management Time (Hr.)' })).toBeInTheDocument();
  });

  it('formats currency cells as currency and hour cells to two decimals', () => {
    renderPanel();

    expect(screen.getByRole('cell', { name: '$5,000.00' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '$1,250.00' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '3.50' })).toBeInTheDocument();
  });

  it('keeps a negative budget amount negative', () => {
    renderPanel();

    expect(screen.getByRole('cell', { name: '-$125.50' })).toBeInTheDocument();
  });

  it('falls back to N/A for a blank plain cell', () => {
    renderPanel();

    // b-2 has an empty Notes value; b-1's reads "Q1 allocation".
    const section = within(budgetSectionFor('Home Support Quarterly Budget'));
    expect(section.getByRole('cell', { name: 'Q1 allocation' })).toBeInTheDocument();
    expect(section.getAllByRole('cell', { name: 'N/A' })).toHaveLength(1);
  });

  it('says so for a stream with no budget items', () => {
    renderPanel();

    expect(screen.getByText('No budget items found for this stream.')).toBeInTheDocument();
  });

  it('exports the stream that was asked for', async () => {
    const user = userEvent.setup();
    const props = renderPanel();

    const section = screen.getByRole('heading', { name: 'Home Modification Budget' })
      .closest('div.border')!;
    await user.click(within(section as HTMLElement).getByRole('button', { name: 'Export CSV' }));

    expect(props.handleBudgetCategoryExportCSV).toHaveBeenCalledWith('HMB', 'Home Modification Budget');
  });

  it('locks out only the stream that is currently exporting', () => {
    renderPanel({ exportingSection: 'budget-HSQ' });

    const exports = screen.getAllByRole('button', { name: 'Export CSV' });
    // Two budget sections plus the service records export.
    expect(exports).toHaveLength(3);
    expect(exports[0]).toBeDisabled();
    expect(exports[1]).toBeEnabled();
  });

  it('shows no budget tables at all while service items are loading', () => {
    renderPanel({ loadingServiceItems: true });

    expect(screen.queryByRole('heading', { name: 'Home Modification Budget' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Individualised Budgets' })).toBeInTheDocument();
  });
});

describe('MonthlyStatementStatementPanel service records table', () => {
  it('lists one row per service', () => {
    renderPanel();

    const table = screen.getByRole('heading', { name: 'Service Records' })
      .closest('div.shadow-lg')!;
    // 1 header row + 3 service rows
    expect(within(table as HTMLElement).getAllByRole('row')).toHaveLength(4);
  });

  it('shows each amount as currency', () => {
    renderPanel();

    expect(screen.getByRole('cell', { name: '$200.00' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '$150.00' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '$50.00' })).toBeInTheDocument();
  });

  it('keeps a negative service amount negative', () => {
    renderPanel();

    // s-3 carries -42.75 as both total and subsidy.
    expect(screen.getAllByRole('cell', { name: '-$42.75' })).toHaveLength(2);
  });

  it('falls back to the alternate participant, task and date fields', () => {
    renderPanel();

    expect(screen.getByRole('cell', { name: 'Domestic Assistance' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Second Provider' })).toBeInTheDocument();
    // s-2 falls back to scheduledShiftStart and actualShiftEndDateTime, both on
    // 5 March, so the row shows that date in two separate columns.
    expect(screen.getAllByRole('cell', { name: '2026-03-05' })).toHaveLength(2);
  });

  it('says N/A where a service has no dates at all', () => {
    renderPanel();

    // s-3 has neither scheduled nor delivery date, and no funding source.
    expect(screen.getAllByRole('cell', { name: 'N/A' }).length).toBeGreaterThanOrEqual(3);
  });

  it('says so when the period produced no services', () => {
    renderPanel({ serviceItems: [] });

    expect(screen.getByText('No service records found for the selected period')).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Personal Care' })).not.toBeInTheDocument();
  });

  it('shows neither rows nor the empty state while services are loading', () => {
    renderPanel({ loadingServiceItems: true });

    expect(screen.queryByText('No service records found for the selected period')).not.toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Personal Care' })).not.toBeInTheDocument();
  });

  it('renders a single service on its own', () => {
    renderPanel({ serviceItems: [SERVICE_ITEMS[0]] });

    const table = screen.getByRole('heading', { name: 'Service Records' })
      .closest('div.shadow-lg')!;
    expect(within(table as HTMLElement).getAllByRole('row')).toHaveLength(2);
  });
});

describe('MonthlyStatementStatementPanel service record filters', () => {
  it('refetches from page one when the transaction status changes', async () => {
    const user = userEvent.setup();
    const props = renderPanel();

    await user.click(screen.getByLabelText('Transaction Status'));
    await user.click(await screen.findByRole('option', { name: 'Cancelled - Provider' }));

    expect(props.setServiceTransactionStatusFilter).toHaveBeenCalledWith('Cancelled - Provider');
    expect(props.fetchServiceItems).toHaveBeenCalledWith(
      1,
      25,
      'scheduledServiceDate',
      'desc',
      'Cancelled - Provider',
      'all',
    );
  });

  it('refetches from page one when the funding source changes, keeping the status filter', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ serviceTransactionStatusFilter: 'Service Delivered' });

    await user.click(screen.getByLabelText('Funding Source'));
    await user.click(await screen.findByRole('option', { name: 'Home Support Quarterly Budget' }));

    expect(props.setServiceFundingSourceFilter).toHaveBeenCalledWith('Home Support Quarterly Budget');
    expect(props.fetchServiceItems).toHaveBeenCalledWith(
      1,
      25,
      'scheduledServiceDate',
      'desc',
      'Service Delivered',
      'Home Support Quarterly Budget',
    );
  });

  it('disables both filters while services are loading', () => {
    renderPanel({ loadingServiceItems: true });

    expect(screen.getByLabelText('Transaction Status')).toBeDisabled();
    expect(screen.getByLabelText('Funding Source')).toBeDisabled();
  });

  it('exports the service records when asked', async () => {
    const user = userEvent.setup();
    const props = renderPanel();

    const section = screen.getByRole('heading', { name: 'Service Records' })
      .closest('div.shadow-lg')!;
    await user.click(within(section as HTMLElement).getByRole('button', { name: 'Export CSV' }));

    expect(props.handleServiceExportCSV).toHaveBeenCalledTimes(1);
  });

  it('locks the service export out while it is running', () => {
    renderPanel({ exportingSection: 'service-csv' });

    const section = screen.getByRole('heading', { name: 'Service Records' })
      .closest('div.shadow-lg')!;
    expect(within(section as HTMLElement).getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });
});

describe('MonthlyStatementStatementPanel service record sorting', () => {
  it('sorts ascending when an inactive column is chosen', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ serviceSortBy: 'scheduledServiceDate', serviceSortOrder: 'asc' });

    await user.click(screen.getByRole('button', { name: 'Service Delivery Date' }));

    expect(props.setServiceSortBy).toHaveBeenCalledWith('serviceDeliveryDate');
    expect(props.setServiceSortOrder).toHaveBeenCalledWith('asc');
    expect(props.fetchServiceItems).toHaveBeenCalledWith(1, 25, 'serviceDeliveryDate', 'asc');
  });

  it('flips to descending when the active ascending column is chosen again', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ serviceSortBy: 'scheduledServiceDate', serviceSortOrder: 'asc' });

    await user.click(screen.getByRole('button', { name: 'Scheduled Service Date' }));

    expect(props.setServiceSortOrder).toHaveBeenCalledWith('desc');
    expect(props.fetchServiceItems).toHaveBeenCalledWith(1, 25, 'scheduledServiceDate', 'desc');
  });

  it('returns to ascending when the active descending column is chosen again', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ serviceSortBy: 'scheduledServiceDate', serviceSortOrder: 'desc' });

    await user.click(screen.getByRole('button', { name: 'Scheduled Service Date' }));

    expect(props.setServiceSortOrder).toHaveBeenCalledWith('asc');
    expect(props.fetchServiceItems).toHaveBeenCalledWith(1, 25, 'scheduledServiceDate', 'asc');
  });

  it('asks for the page size it was given, not a hard-coded one', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ servicePagination: { page: 2, limit: 50 } });

    await user.click(screen.getByRole('button', { name: 'Service Delivery Date' }));

    expect(props.fetchServiceItems).toHaveBeenCalledWith(1, 50, 'serviceDeliveryDate', 'asc');
  });
});

describe('MonthlyStatementStatementPanel service record pagination', () => {
  const pageNav = () => screen.getByRole('navigation', { name: 'pagination' });

  it('lists the pages it was told about', () => {
    renderPanel({ serviceTotalPages: 3, servicePagination: { page: 1, limit: 25 } });

    const texts = Array.from(pageNav().querySelectorAll('a')).map((a) => a.textContent?.trim());
    expect(texts).toEqual(['Previous', '1', '2', '3', 'Next']);
  });

  it('elides the middle of a long run of pages', () => {
    renderPanel({ serviceTotalPages: 10, servicePagination: { page: 5, limit: 25 } });

    const texts = Array.from(pageNav().querySelectorAll('a')).map((a) => a.textContent?.trim());
    expect(texts).toEqual(['Previous', '1', '4', '5', '6', '10', 'Next']);
  });

  it('asks for the page that was clicked', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ serviceTotalPages: 3, servicePagination: { page: 1, limit: 25 } });

    await user.click(within(pageNav()).getByText('3'));

    expect(props.handleServicePageChange).toHaveBeenCalledWith(3);
  });

  it('steps forward one page from Next', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ serviceTotalPages: 3, servicePagination: { page: 2, limit: 25 } });

    await user.click(within(pageNav()).getByText('Next'));

    expect(props.handleServicePageChange).toHaveBeenCalledWith(3);
  });

  it('steps back one page from Previous', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ serviceTotalPages: 3, servicePagination: { page: 2, limit: 25 } });

    await user.click(within(pageNav()).getByText('Previous'));

    expect(props.handleServicePageChange).toHaveBeenCalledWith(1);
  });

  it('hides pagination entirely when there are no services', () => {
    renderPanel({ serviceItems: [] });

    expect(screen.queryByRole('navigation', { name: 'pagination' })).not.toBeInTheDocument();
  });
});

describe('MonthlyStatementStatementPanel summary footer', () => {
  function tileValue(label: string) {
    const labelNode = screen.getByText(label);
    return labelNode.parentElement!.querySelector('p.font-semibold')!.textContent;
  }

  it('repeats the statement period', () => {
    renderPanel();

    expect(tileValue('Statement period')).toBe('March 2026');
  });

  it('counts the services in the period', () => {
    renderPanel();

    expect(tileValue('Total services')).toBe('7 services');
  });

  it('shows the subsidy and contribution totals as currency', () => {
    renderPanel();

    expect(tileValue('Government subsidy')).toBe('$2,496.20');
    expect(tileValue('Participant contribution')).toBe('$624.05');
  });

  it('renders zeroed totals as currency rather than blanks', () => {
    renderPanel({
      statementData: {
        ...STATEMENT_DATA,
        summary: { ...STATEMENT_DATA.summary, totalServices: 0, govSubsidy: 0, participantContribution: 0 },
      },
    });

    expect(tileValue('Total services')).toBe('0 services');
    expect(tileValue('Government subsidy')).toBe('$0.00');
  });

  it('stamps the day the statement was generated as dd/MM/yyyy', () => {
    const now = new Date();
    const expected = [
      String(now.getDate()).padStart(2, '0'),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getFullYear()),
    ].join('/');

    renderPanel();

    expect(tileValue('Generated')).toBe(expected);
  });
});
