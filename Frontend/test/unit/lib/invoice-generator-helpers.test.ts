import { describe, it, expect, vi } from 'vitest';

import {
  TRANSACTION_STATUS_FILTERS,
  getTransactionStatusSearchValue,
  getFundingSourceCode,
  formatDateForCsvExport,
  formatNumberForCsvExport,
  buildInvoiceGeneratorSearchParams,
  validateInvoiceGenerationInputs,
  buildInvoiceItemIds,
  getInvoiceGeneratorBoardFlags,
  applyExclusiveInvoiceDateRange,
  type InvoiceGeneratorFilterParams,
} from '@/lib/invoice-generator-helpers';

/**
 * Every filter option must round-trip through getTransactionStatusSearchValue,
 * because the value the <Select> stores is not the value the ISO+ API expects.
 */
describe('getTransactionStatusSearchValue', () => {
  it('maps each non-"all" filter value to the ISO+ transaction status string', () => {
    expect(getTransactionStatusSearchValue('delivered')).toBe('Delivered - To be claimed and invoiced.');
    expect(getTransactionStatusSearchValue('cancelled')).toBe(
      'Cancelled - To be claimed and invoiced if applicable.',
    );
    expect(getTransactionStatusSearchValue('adjustment-refund')).toBe(
      'Adjustment (Refund) - To be claimed and invoiced.',
    );
    expect(getTransactionStatusSearchValue('adjustment-charge')).toBe(
      'Adjustment (Charge) - To be claimed and invoiced.',
    );
  });

  it('returns an empty string for "all", so no transactionStatus param is sent', () => {
    expect(getTransactionStatusSearchValue('all')).toBe('');
  });

  it('returns an empty string for a value that is not a known filter', () => {
    expect(getTransactionStatusSearchValue('delivered ')).toBe('');
    expect(getTransactionStatusSearchValue('')).toBe('');
  });

  it('offers exactly one option per selectable value, "all" first', () => {
    expect(TRANSACTION_STATUS_FILTERS.map((option) => option.value)).toEqual([
      'all',
      'delivered',
      'cancelled',
      'adjustment-refund',
      'adjustment-charge',
    ]);
  });
});

describe('getFundingSourceCode', () => {
  it('returns an empty string when the funding source is missing or blank', () => {
    expect(getFundingSourceCode(undefined)).toBe('');
    expect(getFundingSourceCode('')).toBe('');
  });

  it('maps the known Support at Home funding sources to their claim codes', () => {
    expect(getFundingSourceCode('Home Support(HS) Quarterly')).toBe('ON');
    expect(getFundingSourceCode('Home Support Care Management')).toBe('CM');
    expect(getFundingSourceCode('Restorative Care Pathway')).toBe('RC');
    expect(getFundingSourceCode('Assistive Technology - Short-term')).toBe('AT');
    expect(getFundingSourceCode('End-of-Life Pathway')).toBe('EL');
    expect(getFundingSourceCode('Home Modification')).toBe('HM');
    expect(getFundingSourceCode('Primary Supplements')).toBe('PS');
    expect(getFundingSourceCode('Unspent Home Care Package (HCP) Funds')).toBe('HCP');
  });

  it('matches case-insensitively and on a substring of the funding source', () => {
    expect(getFundingSourceCode('  restorative care pathway (2026)')).toBe('RC');
    expect(getFundingSourceCode('FUNDED VIA HOME MODIFICATION')).toBe('HM');
  });

  /**
   * Characterization of a real defect: the map is scanned in insertion order and
   * 'Assistive Technology' sits above 'Assistive Technology - Ongoing', so the
   * broader key wins and the 'AS' code is unreachable.
   */
  it('returns AT (not AS) for "Assistive Technology - Ongoing" because the broader key matches first', () => {
    expect(getFundingSourceCode('Assistive Technology - Ongoing')).toBe('AT');
  });

  it('falls back to the singular "primary supplement" spelling', () => {
    expect(getFundingSourceCode('Primary Supplement')).toBe('PS');
  });

  it('falls back to HCP for the loose home care package spellings', () => {
    expect(getFundingSourceCode('Unspent Home Care Package')).toBe('HCP');
    expect(getFundingSourceCode('Leftover HCP Funds')).toBe('HCP');
    expect(getFundingSourceCode('Home Care Package Level 3')).toBe('HCP');
  });

  it('falls back to the first four characters upper-cased for an unknown funding source', () => {
    expect(getFundingSourceCode('Other funding')).toBe('OTHE');
    expect(getFundingSourceCode('ab')).toBe('AB');
  });
});

describe('formatDateForCsvExport', () => {
  it('returns an empty string for null, undefined and an empty date', () => {
    expect(formatDateForCsvExport(null, 'Australia/Sydney')).toBe('');
    expect(formatDateForCsvExport(undefined, 'Australia/Sydney')).toBe('');
    expect(formatDateForCsvExport('', 'Australia/Sydney')).toBe('');
  });

  it('formats an instant in the business timezone, not in UTC', () => {
    // 2026-03-14T14:00Z is 2026-03-15 01:00 in Sydney (UTC+11 during AEDT).
    expect(formatDateForCsvExport('2026-03-14T14:00:00.000Z', 'Australia/Sydney')).toBe('2026-03-15');
    expect(formatDateForCsvExport('2026-03-14T14:00:00.000Z', 'UTC')).toBe('2026-03-14');
  });

  it('returns an empty string for an unparseable date', () => {
    expect(formatDateForCsvExport('not-a-date', 'Australia/Sydney')).toBe('');
  });
});

describe('formatNumberForCsvExport', () => {
  it('returns an empty string for null, undefined and an empty string', () => {
    expect(formatNumberForCsvExport(null)).toBe('');
    expect(formatNumberForCsvExport(undefined)).toBe('');
    expect(formatNumberForCsvExport('')).toBe('');
  });

  it('formats zero and negative amounts to two decimal places rather than dropping them', () => {
    expect(formatNumberForCsvExport(0)).toBe('0.00');
    expect(formatNumberForCsvExport(-12.5)).toBe('-12.50');
  });

  it('coerces numeric strings and rounds to two decimals', () => {
    expect(formatNumberForCsvExport('3.456')).toBe('3.46');
    expect(formatNumberForCsvExport(2.675)).toBe('2.67');
    expect(formatNumberForCsvExport(120)).toBe('120.00');
  });

  it('returns an empty string when the value is not numeric', () => {
    expect(formatNumberForCsvExport('abc')).toBe('');
  });
});

function makeFilters(overrides: Partial<InvoiceGeneratorFilterParams> = {}): InvoiceGeneratorFilterParams {
  return {
    statusFilter: 'all',
    participantFilter: 'all',
    transactionStatusFilter: 'all',
    paymentStatusFilter: 'all',
    jobStatusFilter: 'all',
    isNdisBoard: false,
    scheduledServiceDateRange: undefined,
    serviceDeliveryDateRange: undefined,
    sortBy: 'scheduledServiceDate',
    sortOrder: 'desc',
    currentPage: 1,
    itemsPerPage: 25,
    businessTimezone: 'Australia/Sydney',
    getTransactionStatusSearchValue: vi.fn(() => ''),
    dateToStartOfDayISO: vi.fn((date: Date) => `START(${date.toISOString()})`),
    dateToEndOfDayISO: vi.fn((date: Date) => `END(${date.toISOString()})`),
    ...overrides,
  };
}

describe('buildInvoiceGeneratorSearchParams', () => {
  it('sends only paging and sorting when every filter is at its default', () => {
    const params = buildInvoiceGeneratorSearchParams(makeFilters());
    expect([...params.entries()]).toEqual([
      ['sortBy', 'scheduledServiceDate'],
      ['sortOrder', 'desc'],
      ['page', '1'],
      ['limit', '25'],
    ]);
  });

  it('appends status, participant and paymentStatus once they leave "all"', () => {
    const params = buildInvoiceGeneratorSearchParams(
      makeFilters({
        statusFilter: 'pending',
        participantFilter: 'Jane Doe',
        paymentStatusFilter: 'Paid',
        currentPage: 3,
        itemsPerPage: 50,
      }),
    );
    expect([...params.entries()]).toEqual([
      ['status', 'pending'],
      ['participant', 'Jane Doe'],
      ['paymentStatus', 'Paid'],
      ['sortBy', 'scheduledServiceDate'],
      ['sortOrder', 'desc'],
      ['page', '3'],
      ['limit', '50'],
    ]);
  });

  it('omits the participant when it is empty as well as when it is "all"', () => {
    expect(buildInvoiceGeneratorSearchParams(makeFilters({ participantFilter: '' })).has('participant')).toBe(false);
    expect(buildInvoiceGeneratorSearchParams(makeFilters({ participantFilter: 'all' })).has('participant')).toBe(false);
  });

  it('appends the ISO+ transaction status string returned by the injected mapper', () => {
    const params = buildInvoiceGeneratorSearchParams(
      makeFilters({
        transactionStatusFilter: 'delivered',
        getTransactionStatusSearchValue: vi.fn(() => 'Delivered - To be claimed and invoiced.'),
      }),
    );
    expect(params.get('transactionStatus')).toBe('Delivered - To be claimed and invoiced.');
  });

  it('drops the transaction status when the mapper returns a falsy value', () => {
    const params = buildInvoiceGeneratorSearchParams(
      makeFilters({ transactionStatusFilter: 'all', getTransactionStatusSearchValue: vi.fn(() => null) }),
    );
    expect(params.has('transactionStatus')).toBe(false);
  });

  it('sends jobStatus only on an NDIS board', () => {
    expect(
      buildInvoiceGeneratorSearchParams(makeFilters({ isNdisBoard: false, jobStatusFilter: 'Completed' })).has(
        'jobStatus',
      ),
    ).toBe(false);
    expect(
      buildInvoiceGeneratorSearchParams(makeFilters({ isNdisBoard: true, jobStatusFilter: 'Completed' })).get(
        'jobStatus',
      ),
    ).toBe('Completed');
    expect(
      buildInvoiceGeneratorSearchParams(makeFilters({ isNdisBoard: true, jobStatusFilter: 'all' })).has('jobStatus'),
    ).toBe(false);
  });

  it('sends both ends of a scheduled service date range through the timezone helpers', () => {
    const params = buildInvoiceGeneratorSearchParams(
      makeFilters({
        scheduledServiceDateRange: {
          from: new Date('2026-03-01T00:00:00.000Z'),
          to: new Date('2026-03-31T00:00:00.000Z'),
        },
      }),
    );
    expect(params.get('startDate')).toBe('START(2026-03-01T00:00:00.000Z)');
    expect(params.get('endDate')).toBe('END(2026-03-31T00:00:00.000Z)');
  });

  it('closes an open-ended scheduled range on its own "from" date', () => {
    const params = buildInvoiceGeneratorSearchParams(
      makeFilters({ scheduledServiceDateRange: { from: new Date('2026-03-01T00:00:00.000Z'), to: undefined } }),
    );
    expect(params.get('startDate')).toBe('START(2026-03-01T00:00:00.000Z)');
    expect(params.get('endDate')).toBe('END(2026-03-01T00:00:00.000Z)');
  });

  it('sends an end date with no start date when only "to" is set', () => {
    const params = buildInvoiceGeneratorSearchParams(
      makeFilters({
        scheduledServiceDateRange: { from: undefined, to: new Date('2026-03-31T00:00:00.000Z') } as never,
      }),
    );
    expect(params.has('startDate')).toBe(false);
    expect(params.get('endDate')).toBe('END(2026-03-31T00:00:00.000Z)');
  });

  it('sends the service delivery range under its own parameter names', () => {
    const params = buildInvoiceGeneratorSearchParams(
      makeFilters({
        serviceDeliveryDateRange: {
          from: new Date('2026-02-01T00:00:00.000Z'),
          to: new Date('2026-02-28T00:00:00.000Z'),
        },
      }),
    );
    expect(params.get('serviceDeliveryStart')).toBe('START(2026-02-01T00:00:00.000Z)');
    expect(params.get('serviceDeliveryEnd')).toBe('END(2026-02-28T00:00:00.000Z)');
    expect(params.has('startDate')).toBe(false);
  });

  it('does not AND scheduled and service delivery ranges when both are set', () => {
    const params = buildInvoiceGeneratorSearchParams(
      makeFilters({
        scheduledServiceDateRange: {
          from: new Date('2026-08-03T00:00:00.000Z'),
          to: new Date('2026-08-15T00:00:00.000Z'),
        },
        serviceDeliveryDateRange: {
          from: new Date('2026-07-25T00:00:00.000Z'),
          to: new Date('2026-07-30T00:00:00.000Z'),
        },
      }),
    );
    expect(params.has('startDate')).toBe(false);
    expect(params.has('endDate')).toBe(false);
    expect(params.get('serviceDeliveryStart')).toBe('START(2026-07-25T00:00:00.000Z)');
    expect(params.get('serviceDeliveryEnd')).toBe('END(2026-07-30T00:00:00.000Z)');
  });

  it('passes the business timezone to both date helpers', () => {
    const dateToStartOfDayISO = vi.fn(() => 'start');
    const dateToEndOfDayISO = vi.fn(() => 'end');
    buildInvoiceGeneratorSearchParams(
      makeFilters({
        businessTimezone: 'Australia/Perth',
        scheduledServiceDateRange: { from: new Date('2026-03-01T00:00:00.000Z'), to: undefined },
        dateToStartOfDayISO,
        dateToEndOfDayISO,
      }),
    );
    expect(dateToStartOfDayISO).toHaveBeenCalledWith(expect.any(Date), 'Australia/Perth');
    expect(dateToEndOfDayISO).toHaveBeenCalledWith(expect.any(Date), 'Australia/Perth');
  });
});

describe('applyExclusiveInvoiceDateRange', () => {
  const scheduled = { from: new Date('2026-08-03T00:00:00.000Z'), to: new Date('2026-08-15T00:00:00.000Z') };
  const delivery = { from: new Date('2026-07-25T00:00:00.000Z'), to: new Date('2026-07-30T00:00:00.000Z') };

  it('clears Service Delivery Date when a Scheduled range is chosen', () => {
    expect(applyExclusiveInvoiceDateRange('scheduled', scheduled, {
      scheduledServiceDateRange: undefined,
      serviceDeliveryDateRange: delivery,
    })).toEqual({
      scheduledServiceDateRange: scheduled,
      serviceDeliveryDateRange: undefined,
    });
  });

  it('clears Scheduled Service Date when a Service Delivery range is chosen', () => {
    expect(applyExclusiveInvoiceDateRange('serviceDelivery', delivery, {
      scheduledServiceDateRange: scheduled,
      serviceDeliveryDateRange: undefined,
    })).toEqual({
      scheduledServiceDateRange: undefined,
      serviceDeliveryDateRange: delivery,
    });
  });

  it('keeps the other range when a picker is cleared', () => {
    expect(applyExclusiveInvoiceDateRange('scheduled', undefined, {
      scheduledServiceDateRange: scheduled,
      serviceDeliveryDateRange: delivery,
    })).toEqual({
      scheduledServiceDateRange: undefined,
      serviceDeliveryDateRange: delivery,
    });
  });
});

describe('validateInvoiceGenerationInputs', () => {
  it('rejects a zero selection before looking at the dates', () => {
    expect(validateInvoiceGenerationInputs(0, '', '')).toBe(
      'Please select at least one item to include in the invoice.',
    );
  });

  it('rejects a missing invoice date', () => {
    expect(validateInvoiceGenerationInputs(2, '', '2026-03-31')).toBe('Please enter an invoice date.');
  });

  it('rejects a missing due date', () => {
    expect(validateInvoiceGenerationInputs(2, '2026-03-01', '')).toBe('Please enter a due date.');
  });

  it('returns null when a selection and both dates are present', () => {
    expect(validateInvoiceGenerationInputs(1, '2026-03-01', '2026-03-31')).toBeNull();
  });
});

describe('buildInvoiceItemIds', () => {
  const records = [
    { id: 'item-1:0', sourceItemId: 'src-1', participant: 'Jane Doe' },
    { id: 'item-2:1', participant: 'Jane Doe' },
    { id: 'item-1:1', sourceItemId: 'src-1', participant: 'Jane Doe' },
  ];

  it('returns every selected row id verbatim on a non-NDIS board, duplicates included', () => {
    expect(buildInvoiceItemIds([...records, { id: 'item-2:1' }], false)).toEqual([
      'item-1:0',
      'item-2:1',
      'item-1:1',
      'item-2:1',
    ]);
  });

  it('collapses NDIS rows to unique parent item ids, preferring sourceItemId', () => {
    expect(buildInvoiceItemIds(records, true)).toEqual(['src-1', 'item-2']);
  });

  it('splits an NDIS id on the first colon only', () => {
    expect(buildInvoiceItemIds([{ id: 'board:item:3' }], true)).toEqual(['board']);
  });

  it('drops NDIS rows that carry neither a sourceItemId nor an id', () => {
    expect(buildInvoiceItemIds([{ id: '' }, { id: 'keep-me' }], true)).toEqual(['keep-me']);
  });

  it('returns an empty array for an empty selection on either board type', () => {
    expect(buildInvoiceItemIds([], true)).toEqual([]);
    expect(buildInvoiceItemIds([], false)).toEqual([]);
  });
});

describe('getInvoiceGeneratorBoardFlags', () => {
  it('flags the Low Cat care-management board', () => {
    expect(getInvoiceGeneratorBoardFlags('Care Management - SaH - Low Cat')).toEqual({
      isLowCatBoard: true,
      isCareManagementBoard: true,
      isNdisBoard: false,
      isNdisCertificationOrVerificationBoard: false,
    });
  });

  it('flags the NDIS certification board as both NDIS and certification/verification', () => {
    expect(getInvoiceGeneratorBoardFlags('Care Management - NDIS - Certification')).toEqual({
      isLowCatBoard: false,
      isCareManagementBoard: true,
      isNdisBoard: true,
      isNdisCertificationOrVerificationBoard: true,
    });
  });

  it('flags the NDIS verification board the same way', () => {
    expect(getInvoiceGeneratorBoardFlags('Care Management - NDIS - Verification')
      .isNdisCertificationOrVerificationBoard).toBe(true);
  });

  it('detects NDIS case-insensitively on a board that is not care management', () => {
    expect(getInvoiceGeneratorBoardFlags('ndis service delivery')).toEqual({
      isLowCatBoard: false,
      isCareManagementBoard: false,
      isNdisBoard: true,
      isNdisCertificationOrVerificationBoard: false,
    });
  });

  it('returns all flags false for an unrelated board label', () => {
    expect(getInvoiceGeneratorBoardFlags('Support at Home - Standard')).toEqual({
      isLowCatBoard: false,
      isCareManagementBoard: false,
      isNdisBoard: false,
      isNdisCertificationOrVerificationBoard: false,
    });
  });
});
