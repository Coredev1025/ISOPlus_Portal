import { describe, it, expect, vi } from 'vitest';
import {
  validateStatementDateInputs,
  groupBudgetItemsByFolder,
  buildStatementSummary,
  buildMonthlyStatementQueryParams,
  buildStatementViewModel,
  getTransactionStatusBadgeVariant,
} from '@/lib/monthly-statement-helpers';

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

describe('validateStatementDateInputs', () => {
  it('accepts January and December but rejects the months either side of them', () => {
    expect(validateStatementDateInputs(1, 2026, 2026)).toBeNull();
    expect(validateStatementDateInputs(12, 2026, 2026)).toBeNull();
    expect(validateStatementDateInputs(0, 2026, 2026)).toBe('Please select a valid month (01-12)');
    expect(validateStatementDateInputs(13, 2026, 2026)).toBe('Please select a valid month (01-12)');
  });

  it('allows next year but rejects the year after it', () => {
    expect(validateStatementDateInputs(6, 2027, 2026)).toBeNull();
    expect(validateStatementDateInputs(6, 2028, 2026)).toBe(
      'Cannot generate statements for future years beyond next year',
    );
  });

  it('allows exactly ten years ago but rejects eleven', () => {
    expect(validateStatementDateInputs(6, 2016, 2026)).toBeNull();
    expect(validateStatementDateInputs(6, 2015, 2026)).toBe(
      'Cannot generate statements for years more than 10 years ago',
    );
  });

  it('reports the month problem first when both month and year are out of range', () => {
    expect(validateStatementDateInputs(13, 2099, 2026)).toBe('Please select a valid month (01-12)');
  });

  it('lets NaN through every comparison, so callers must check for NaN themselves', () => {
    expect(validateStatementDateInputs(Number.NaN, Number.NaN, 2026)).toBeNull();
  });
});

describe('groupBudgetItemsByFolder', () => {
  const hsqItems = [
    { id: 'b1', name: 'Home Support Quarterly Budget', availableFunds: 3000, remainingBudget: 1250.5 },
    { id: 'b2', name: 'Home Support Quarterly Budget', availableFunds: 3000, remainingBudget: 900 },
  ];
  const cmItems = [{ id: 'b3', name: 'Care Management Budget', availableFunds: 500, remainingBudget: 125 }];

  it('returns empty results when budgetItems is undefined', () => {
    expect(groupBudgetItemsByFolder(undefined)).toEqual({ grouped: {}, flat: [] });
  });

  it('returns empty results when the items map is missing', () => {
    expect(groupBudgetItemsByFolder({} as never)).toEqual({ grouped: {}, flat: [] });
  });

  it('keeps only non-empty folders and flattens them in folder order', () => {
    const result = groupBudgetItemsByFolder({
      items: {
        'Home Support Quarterly': { items: hsqItems },
        'Empty Folder': { items: [] },
        'Care Management': { items: cmItems },
      },
    });

    expect(Object.keys(result.grouped)).toEqual(['Home Support Quarterly', 'Care Management']);
    expect(result.grouped['Home Support Quarterly']).toEqual(hsqItems);
    expect(result.flat).toEqual([hsqItems[0], hsqItems[1], cmItems[0]]);
  });

  it('drops folders whose items are missing or not an array', () => {
    const result = groupBudgetItemsByFolder({
      items: {
        Broken: { items: 'not-an-array' as never },
        Absent: {},
        Good: { items: cmItems },
      },
    });

    expect(Object.keys(result.grouped)).toEqual(['Good']);
    expect(result.flat).toEqual(cmItems);
  });

  it('returns empty results when every folder is empty', () => {
    const result = groupBudgetItemsByFolder({ items: { A: { items: [] }, B: { items: [] } } });
    expect(result).toEqual({ grouped: {}, flat: [] });
  });
});

describe('buildStatementSummary', () => {
  const services = [
    {
      id: 's1',
      participant: 'Jane Doe',
      service: 'Personal Care',
      unit: 'Hour',
      quantity: 2.5,
      unitPrice: 70.5,
      totalAmount: 176.25,
      govSubsidy: 158.5,
      participantContribution: 17.75,
    },
    {
      id: 's2',
      participant: 'Jane Doe',
      service: 'Domestic Assistance',
      unit: 'Hours',
      quantity: 1.5,
      unitPrice: 70,
      totalAmount: 105,
      govSubsidy: 94.5,
      participantContribution: 10.5,
    },
    {
      id: 's3',
      participant: 'Jane Doe',
      service: 'Meal Delivery',
      unit: 'Each',
      quantity: 3,
      unitPrice: 15.25,
      totalAmount: 45.75,
      govSubsidy: 40.25,
      participantContribution: 5.5,
    },
  ];

  it('sums the services when the backend sends no summary', () => {
    expect(buildStatementSummary(services)).toEqual({
      totalServices: 3,
      totalHours: 4,
      totalAmount: 327,
      govSubsidy: 293.25,
      participantContribution: 33.75,
    });
  });

  it('counts hours only for units containing "hour", case-insensitively', () => {
    const summary = buildStatementSummary([
      { unit: 'HOUR', quantity: 1 },
      { unit: 'hourly', quantity: 2 },
      { unit: 'Hours', quantity: 0.25 },
      { unit: 'Each', quantity: 100 },
      { unit: 'Km', quantity: 50 },
      { quantity: 8 },
    ]);

    expect(summary.totalHours).toBe(3.25);
    expect(summary.totalServices).toBe(6);
  });

  it('returns zeros for an empty month with no services', () => {
    expect(buildStatementSummary([])).toEqual({
      totalServices: 0,
      totalHours: 0,
      totalAmount: 0,
      govSubsidy: 0,
      participantContribution: 0,
    });
  });

  it('treats missing money fields as zero rather than NaN', () => {
    expect(buildStatementSummary([{ unit: 'Hour' }, { unit: 'Hour', quantity: 2 }])).toEqual({
      totalServices: 2,
      totalHours: 2,
      totalAmount: 0,
      govSubsidy: 0,
      participantContribution: 0,
    });
  });

  it('sums negative amounts, so a reversal reduces the totals', () => {
    const summary = buildStatementSummary([
      { unit: 'Hour', quantity: 2, totalAmount: 150, govSubsidy: 135, participantContribution: 15 },
      { unit: 'Hour', quantity: -2, totalAmount: -150, govSubsidy: -135, participantContribution: -15 },
    ]);

    expect(summary).toEqual({
      totalServices: 2,
      totalHours: 0,
      totalAmount: 0,
      govSubsidy: 0,
      participantContribution: 0,
    });
  });

  it('does not round, so float error in the source amounts survives into the total', () => {
    const summary = buildStatementSummary([{ totalAmount: 0.1 }, { totalAmount: 0.2 }]);
    expect(summary.totalAmount).toBe(0.30000000000000004);
  });

  it('prefers backend values over the computed fallback', () => {
    const summary = buildStatementSummary(services, {
      totalServices: 42,
      totalHours: 99.5,
      totalAmount: 1000,
      govSubsidy: 900,
      participantContribution: 100,
    });

    expect(summary).toEqual({
      totalServices: 42,
      totalHours: 99.5,
      totalAmount: 1000,
      govSubsidy: 900,
      participantContribution: 100,
    });
  });

  it('keeps a backend zero instead of falling back to the computed total', () => {
    const summary = buildStatementSummary(services, {
      totalAmount: 0,
      govSubsidy: 0,
      participantContribution: 0,
    });

    expect(summary.totalAmount).toBe(0);
    expect(summary.govSubsidy).toBe(0);
    expect(summary.participantContribution).toBe(0);
    expect(summary.totalServices).toBe(3);
    expect(summary.totalHours).toBe(4);
  });

  it('falls back per field when the backend summary is partial', () => {
    const summary = buildStatementSummary(services, { totalHours: 12 });

    expect(summary).toEqual({
      totalServices: 3,
      totalHours: 12,
      totalAmount: 327,
      govSubsidy: 293.25,
      participantContribution: 33.75,
    });
  });
});

describe('buildMonthlyStatementQueryParams', () => {
  const base = {
    participant: 'Jane Doe',
    startDate: '2026-03-01T00:00:00.000Z',
    endDate: '2026-03-31T23:59:59.999Z',
    month: '03',
    year: '2026',
    budgetPage: 1,
    budgetLimit: 10,
    servicePage: 2,
    serviceLimit: 25,
  };

  it('omits sorting and filtering when none are supplied', () => {
    expect(buildMonthlyStatementQueryParams(base)).toEqual({
      participant: 'Jane Doe',
      startDate: '2026-03-01T00:00:00.000Z',
      endDate: '2026-03-31T23:59:59.999Z',
      month: '03',
      year: '2026',
      budgetPage: 1,
      budgetLimit: 10,
      servicePage: 2,
      serviceLimit: 25,
    });
  });

  it('defaults the sort order to asc when a sort field is given without one', () => {
    const params = buildMonthlyStatementQueryParams({ ...base, serviceSortBy: 'scheduledServiceDate' });
    expect(params).toMatchObject({ serviceSortBy: 'scheduledServiceDate', serviceSortOrder: 'asc' });
  });

  it('keeps an explicit desc sort order', () => {
    const params = buildMonthlyStatementQueryParams({
      ...base,
      serviceSortBy: 'serviceDeliveryDate',
      serviceSortOrder: 'desc',
    });
    expect(params).toMatchObject({ serviceSortBy: 'serviceDeliveryDate', serviceSortOrder: 'desc' });
  });

  it('drops the sort order entirely when the sort field is an empty string', () => {
    const params = buildMonthlyStatementQueryParams({ ...base, serviceSortBy: '', serviceSortOrder: 'desc' });
    expect(params).not.toHaveProperty('serviceSortBy');
    expect(params).not.toHaveProperty('serviceSortOrder');
  });

  it('renames the filters and omits them when set to "all"', () => {
    const withFilters = buildMonthlyStatementQueryParams({
      ...base,
      serviceTransactionStatusFilter: 'Delivered',
      serviceFundingSourceFilter: 'Home Support',
    });
    expect(withFilters).toMatchObject({
      serviceTransactionStatus: 'Delivered',
      serviceFundingSource: 'Home Support',
    });

    const allFilters = buildMonthlyStatementQueryParams({
      ...base,
      serviceTransactionStatusFilter: 'all',
      serviceFundingSourceFilter: 'all',
    });
    expect(allFilters).not.toHaveProperty('serviceTransactionStatus');
    expect(allFilters).not.toHaveProperty('serviceFundingSource');
  });

  it('omits an empty-string filter', () => {
    const params = buildMonthlyStatementQueryParams({
      ...base,
      serviceTransactionStatusFilter: '',
      serviceFundingSourceFilter: 'Care Management',
    });
    expect(params).not.toHaveProperty('serviceTransactionStatus');
    expect(params).toMatchObject({ serviceFundingSource: 'Care Management' });
  });
});

describe('buildStatementViewModel', () => {
  const services = [
    {
      id: 's1',
      participant: 'Jane Doe',
      service: 'Personal Care',
      unit: 'Hour',
      quantity: 2,
      totalAmount: 140,
      govSubsidy: 126,
      participantContribution: 14,
      fundingSource: 'Home Support',
      transactionStatus: 'Delivered',
    },
  ];

  const apiData = {
    participant: 'Jane Doe',
    participantProfile: 'Jane Doe (AC-99887766)',
    month: 'March',
    monthNumber: '3',
    year: 2026,
    budgetCategories: [{ code: 'HSQ', name: 'Home Support Quarterly Budget', availableFunds: 3000, remainingBudget: 1200 }],
    summary: {
      totalServices: 1,
      totalHours: 2,
      totalAmount: 140,
      govSubsidy: 126,
      participantContribution: 14,
    },
    participantAddress: '12 Smith Street',
    participantSuburb: 'Newtown',
    participantState: 'NSW',
    participantPostcode: '2042',
    myAgedCareIdNumber: 'AC-99887766',
    providerId: 'PRV-001',
    fundingSources: ['Home Support', 'Care Management'],
  };

  const categorized = [{ code: 'HSQ', name: 'Home Support Quarterly Budget', services: [] }];

  it('maps the API payload onto the view model and pads the month number', () => {
    const categorizeServices = vi.fn(() => categorized);
    const vm = buildStatementViewModel(apiData, services, [{ id: 'b1' }], 'Someone Else', '07', '2020', MONTHS, 'FALLBACK', categorizeServices);

    expect(vm).toEqual({
      participant: 'Jane Doe',
      participantProfile: 'Jane Doe (AC-99887766)',
      month: 'March',
      year: '2026',
      monthNumber: '03',
      services,
      budgetCategories: categorized,
      budgetItems: [{ id: 'b1' }],
      serviceItems: services,
      summary: {
        totalServices: 1,
        totalHours: 2,
        totalAmount: 140,
        govSubsidy: 126,
        participantContribution: 14,
      },
      participantAddress: '12 Smith Street',
      participantSuburb: 'Newtown',
      participantState: 'NSW',
      participantPostcode: '2042',
      myAgedCareIdNumber: 'AC-99887766',
      providerId: 'PRV-001',
      fundingSources: ['Home Support', 'Care Management'],
    });
  });

  it('categorizes with the padded month and stringified year, not the raw API values', () => {
    const categorizeServices = vi.fn(() => categorized);
    buildStatementViewModel(apiData, services, [], 'Jane Doe', '07', '2020', MONTHS, '', categorizeServices);

    expect(categorizeServices).toHaveBeenCalledWith(services, apiData.budgetCategories, '03', '2026');
  });

  it('falls back to the selected month and year when the API omits them', () => {
    const vm = buildStatementViewModel(
      { fundingSources: [] },
      [],
      [],
      'Jane Doe',
      '07',
      '2026',
      MONTHS,
      'PRV-FALLBACK',
      () => [],
    );

    expect(vm.monthNumber).toBe('07');
    expect(vm.month).toBe('July');
    expect(vm.year).toBe('2026');
    expect(vm.participant).toBe('Jane Doe');
    expect(vm.participantProfile).toBe('Jane Doe');
  });

  it('derives the month label from the month list when the API sends only a month number', () => {
    const vm = buildStatementViewModel(
      { monthNumber: '11', fundingSources: [] },
      [],
      [],
      'Jane Doe',
      '01',
      '2026',
      MONTHS,
      '',
      () => [],
    );

    expect(vm.month).toBe('November');
    expect(vm.monthNumber).toBe('11');
  });

  it('uses the month number as its own label when no month matches', () => {
    const vm = buildStatementViewModel(
      { monthNumber: '13', fundingSources: [] },
      [],
      [],
      'Jane Doe',
      '01',
      '2026',
      MONTHS,
      '',
      () => [],
    );

    expect(vm.month).toBe('13');
  });

  it('turns an unselected month into "00" instead of the "01" default, because "" is not nullish', () => {
    const vm = buildStatementViewModel({ fundingSources: [] }, [], [], 'Jane Doe', '', '2026', MONTHS, '', () => []);

    expect(vm.monthNumber).toBe('00');
    expect(vm.month).toBe('00');
  });

  it('uses the "01" default only when the selected month is nullish', () => {
    const vm = buildStatementViewModel(
      { fundingSources: [] },
      [],
      [],
      'Jane Doe',
      undefined as unknown as string,
      '2026',
      MONTHS,
      '',
      () => [],
    );

    expect(vm.monthNumber).toBe('01');
    expect(vm.month).toBe('January');
  });

  it('falls back to the business registration id when the API provider id is blank', () => {
    const blank = buildStatementViewModel(
      { providerId: '', fundingSources: [] },
      [],
      [],
      'Jane Doe',
      '03',
      '2026',
      MONTHS,
      'PRV-FALLBACK',
      () => [],
    );
    expect(blank.providerId).toBe('PRV-FALLBACK');

    const present = buildStatementViewModel(
      { providerId: 'PRV-API', fundingSources: [] },
      [],
      [],
      'Jane Doe',
      '03',
      '2026',
      MONTHS,
      'PRV-FALLBACK',
      () => [],
    );
    expect(present.providerId).toBe('PRV-API');
  });

  it('defaults the participant address fields to empty strings but keeps a blank API address as-is', () => {
    const missing = buildStatementViewModel({ fundingSources: [] }, [], [], 'Jane Doe', '03', '2026', MONTHS, '', () => []);
    expect(missing.participantAddress).toBe('');
    expect(missing.participantSuburb).toBe('');
    expect(missing.participantState).toBe('');
    expect(missing.participantPostcode).toBe('');
    expect(missing.myAgedCareIdNumber).toBe('');
  });

  it('passes fundingSources straight through, including when it is absent', () => {
    const vm = buildStatementViewModel({}, [], [], 'Jane Doe', '03', '2026', MONTHS, '', () => []);
    expect(vm.fundingSources).toBeUndefined();
  });

  it('throws on a null payload, because fundingSources is read without optional chaining', () => {
    expect(() =>
      buildStatementViewModel(null as unknown as Record<string, unknown>, [], [], 'Jane Doe', '03', '2026', MONTHS, '', () => []),
    ).toThrow(TypeError);
  });

  it('computes the summary from the services when the API sends none', () => {
    const vm = buildStatementViewModel({ fundingSources: [] }, services, [], 'Jane Doe', '03', '2026', MONTHS, '', () => []);

    expect(vm.summary).toEqual({
      totalServices: 1,
      totalHours: 2,
      totalAmount: 140,
      govSubsidy: 126,
      participantContribution: 14,
    });
  });
});

describe('getTransactionStatusBadgeVariant', () => {
  it('marks cancelled statuses destructive regardless of case', () => {
    expect(getTransactionStatusBadgeVariant('Cancelled')).toBe('destructive');
    expect(getTransactionStatusBadgeVariant('CANCELLED BY PROVIDER')).toBe('destructive');
  });

  it('marks delivered statuses default', () => {
    expect(getTransactionStatusBadgeVariant('Delivered')).toBe('default');
    expect(getTransactionStatusBadgeVariant('Partially delivered')).toBe('default');
  });

  it('falls back to secondary for other, empty and missing statuses', () => {
    expect(getTransactionStatusBadgeVariant('Scheduled')).toBe('secondary');
    expect(getTransactionStatusBadgeVariant('')).toBe('secondary');
    expect(getTransactionStatusBadgeVariant(undefined)).toBe('secondary');
  });

  it('prefers destructive when a status mentions both cancelled and delivered', () => {
    expect(getTransactionStatusBadgeVariant('Cancelled after delivered')).toBe('destructive');
  });

  it('classifies "Not delivered" as default, because the match is a substring test', () => {
    expect(getTransactionStatusBadgeVariant('Not delivered')).toBe('default');
  });
});
