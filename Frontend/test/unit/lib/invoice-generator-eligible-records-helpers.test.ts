import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  buildEligibleRecordsSearchParams,
  showEligibleRecordsLoadedToasts,
  fetchEligibleInvoiceRecords,
  runEligibleRecordsLoad,
} from '@/lib/invoice-generator-eligible-records-helpers';
import type { InvoiceGeneratorServiceRecord } from '@/lib/invoice-generator-types';

function makeRecord(overrides: Partial<InvoiceGeneratorServiceRecord> = {}): InvoiceGeneratorServiceRecord {
  return {
    id: 'item-1:0',
    sourceItemId: 'item-1',
    status: 'pending',
    participant: 'Jane Doe',
    scheduledServiceDate: '2026-03-10T00:00:00.000Z',
    serviceDeliveryDate: '2026-03-11T00:00:00.000Z',
    jobStatus: 'Completed',
    unit: 'Hour',
    quantity: 2,
    unitPrice: 65.5,
    totalAmount: 131,
    govSubsidy: 100,
    participantContribution: 31,
    notes: 'Domestic assistance',
    service: 'Home Support',
    gst: 'GST Free',
    transactionStatus: 'Delivered - To be claimed and invoiced.',
    paymentStatus: 'Unpaid',
    fundingSource: 'Home Support(HS) Quarterly',
    careRecipientIdentifier: 'AC12345678',
    serviceIdentifier: 'SVC-001',
    ...overrides,
  };
}

const baseParamOptions = {
  isNdisBoard: false,
  participantFilter: 'all',
  scheduledServiceDateRange: undefined,
  serviceDeliveryDateRange: undefined,
  transactionStatusFilter: 'all',
  paymentStatusFilter: 'all',
  jobStatusFilter: 'all',
  sortBy: 'scheduledServiceDate',
  sortOrder: 'desc',
  businessTimezone: 'UTC',
};

describe('buildEligibleRecordsSearchParams', () => {
  it('always asks for every status and the first 1000 rows', () => {
    const params = buildEligibleRecordsSearchParams(baseParamOptions);
    expect([...params.entries()]).toEqual([
      ['status', 'all'],
      ['sortBy', 'scheduledServiceDate'],
      ['sortOrder', 'desc'],
      ['page', '1'],
      ['limit', '1000'],
    ]);
  });

  it('omits the participant for the empty and "all" selections and sends it otherwise', () => {
    expect(buildEligibleRecordsSearchParams({ ...baseParamOptions, participantFilter: '' }).has('participant')).toBe(
      false,
    );
    expect(buildEligibleRecordsSearchParams({ ...baseParamOptions, participantFilter: 'all' }).has('participant')).toBe(
      false,
    );
    expect(
      buildEligibleRecordsSearchParams({ ...baseParamOptions, participantFilter: 'Jane Doe' }).get('participant'),
    ).toBe('Jane Doe');
  });

  it('expands a scheduled date range to the start and end of those days in UTC', () => {
    const params = buildEligibleRecordsSearchParams({
      ...baseParamOptions,
      scheduledServiceDateRange: {
        from: new Date('2026-03-10T05:00:00.000Z'),
        to: new Date('2026-03-12T05:00:00.000Z'),
      },
    });
    expect(params.get('startDate')).toBe('2026-03-10T00:00:00.000Z');
    expect(params.get('endDate')).toBe('2026-03-12T23:59:59.999Z');
  });

  it('resolves the day boundaries in the business timezone, not in UTC', () => {
    // 2026-06-15T20:00Z is 2026-06-16 06:00 in Sydney (UTC+10 during AEST),
    // so the day being asked for is the 16th, running 14:00Z to 13:59:59.999Z.
    const params = buildEligibleRecordsSearchParams({
      ...baseParamOptions,
      businessTimezone: 'Australia/Sydney',
      scheduledServiceDateRange: { from: new Date('2026-06-15T20:00:00.000Z'), to: undefined },
    });
    expect(params.get('startDate')).toBe('2026-06-15T14:00:00.000Z');
    expect(params.get('endDate')).toBe('2026-06-16T13:59:59.999Z');
  });

  it('closes an open-ended scheduled range on its own "from" day', () => {
    const params = buildEligibleRecordsSearchParams({
      ...baseParamOptions,
      scheduledServiceDateRange: { from: new Date('2026-03-10T05:00:00.000Z'), to: undefined },
    });
    expect(params.get('startDate')).toBe('2026-03-10T00:00:00.000Z');
    expect(params.get('endDate')).toBe('2026-03-10T23:59:59.999Z');
  });

  it('sends an end date without a start date when only "to" is set', () => {
    const params = buildEligibleRecordsSearchParams({
      ...baseParamOptions,
      scheduledServiceDateRange: { from: undefined, to: new Date('2026-03-12T05:00:00.000Z') } as never,
    });
    expect(params.has('startDate')).toBe(false);
    expect(params.get('endDate')).toBe('2026-03-12T23:59:59.999Z');
  });

  it('sends the service delivery range under its own parameter names', () => {
    const params = buildEligibleRecordsSearchParams({
      ...baseParamOptions,
      serviceDeliveryDateRange: {
        from: new Date('2026-02-01T05:00:00.000Z'),
        to: new Date('2026-02-28T05:00:00.000Z'),
      },
    });
    expect(params.get('serviceDeliveryStart')).toBe('2026-02-01T00:00:00.000Z');
    expect(params.get('serviceDeliveryEnd')).toBe('2026-02-28T23:59:59.999Z');
    expect(params.has('startDate')).toBe(false);
  });

  it('maps the transaction status filter to the ISO+ string and drops it for "all"', () => {
    expect(
      buildEligibleRecordsSearchParams({ ...baseParamOptions, transactionStatusFilter: 'cancelled' }).get(
        'transactionStatus',
      ),
    ).toBe('Cancelled - To be claimed and invoiced if applicable.');
    expect(
      buildEligibleRecordsSearchParams({ ...baseParamOptions, transactionStatusFilter: 'all' }).has('transactionStatus'),
    ).toBe(false);
  });

  it('sends paymentStatus once it leaves "all"', () => {
    expect(
      buildEligibleRecordsSearchParams({ ...baseParamOptions, paymentStatusFilter: 'Paid' }).get('paymentStatus'),
    ).toBe('Paid');
    expect(buildEligibleRecordsSearchParams(baseParamOptions).has('paymentStatus')).toBe(false);
  });

  it('sends jobStatus only on an NDIS board', () => {
    expect(
      buildEligibleRecordsSearchParams({
        ...baseParamOptions,
        isNdisBoard: false,
        jobStatusFilter: 'Completed',
      }).has('jobStatus'),
    ).toBe(false);
    expect(
      buildEligibleRecordsSearchParams({
        ...baseParamOptions,
        isNdisBoard: true,
        jobStatusFilter: 'Completed',
      }).get('jobStatus'),
    ).toBe('Completed');
  });
});

describe('showEligibleRecordsLoadedToasts', () => {
  it('says nothing when no records came back', () => {
    const showInfoToast = vi.fn();
    showEligibleRecordsLoadedToasts([], 0, showInfoToast);
    expect(showInfoToast).not.toHaveBeenCalled();
  });

  it('warns that the list is truncated when the server holds more than it returned', () => {
    const showInfoToast = vi.fn();
    showEligibleRecordsLoadedToasts([makeRecord(), makeRecord({ id: 'item-2:0' })], 1500, showInfoToast);
    expect(showInfoToast).toHaveBeenCalledWith('Loaded 2 of 1500 eligible records', {
      description: 'Showing first 1000 records. Use filters to narrow down if needed.',
    });
  });

  it('uses the singular noun for exactly one record', () => {
    const showInfoToast = vi.fn();
    showEligibleRecordsLoadedToasts([makeRecord()], 1, showInfoToast);
    expect(showInfoToast).toHaveBeenCalledWith('Loaded 1 eligible record', {
      description:
        'All records (including invoiced) are shown. You can select which ones to include in the invoice.',
    });
  });

  it('uses the plural noun when the full set was returned', () => {
    const showInfoToast = vi.fn();
    showEligibleRecordsLoadedToasts([makeRecord(), makeRecord({ id: 'item-2:0' })], 2, showInfoToast);
    expect(showInfoToast).toHaveBeenCalledWith('Loaded 2 eligible records', expect.any(Object));
  });
});

describe('fetchEligibleInvoiceRecords', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:4001';
  });

  it('calls the standard invoice-generator endpoint and returns the response body', async () => {
    const payload = { items: [makeRecord()], total: 1, statusFieldLabel: 'Claim Status' };
    const get = vi.fn().mockResolvedValue({ data: payload });
    const signal = new AbortController().signal;

    const data = await fetchEligibleInvoiceRecords({
      ...baseParamOptions,
      axios: { get },
      id: 'ws-1',
      boardId: 'board-9',
      participantFilter: 'Jane Doe',
      signal,
    });

    expect(data).toBe(payload);
    expect(get).toHaveBeenCalledWith('http://localhost:4001/api/items/ws-1/board-9/invoice-generator', {
      params: {
        status: 'all',
        participant: 'Jane Doe',
        sortBy: 'scheduledServiceDate',
        sortOrder: 'desc',
        page: '1',
        limit: '1000',
      },
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal,
    });
  });

  it('calls the NDIS endpoint on an NDIS board', async () => {
    const get = vi.fn().mockResolvedValue({ data: { items: [], total: 0 } });
    await fetchEligibleInvoiceRecords({
      ...baseParamOptions,
      isNdisBoard: true,
      jobStatusFilter: 'Completed',
      axios: { get },
      id: 'ws-1',
      boardId: 'board-9',
      signal: new AbortController().signal,
    });

    expect(get).toHaveBeenCalledWith(
      'http://localhost:4001/api/items/ws-1/board-9/invoice-generator-ndis',
      expect.objectContaining({ params: expect.objectContaining({ jobStatus: 'Completed' }) }),
    );
  });
});

type LoadHarness = ReturnType<typeof makeLoadHarness>;

function makeLoadHarness(getImpl: (config: { signal: AbortSignal }) => Promise<{ data?: unknown }>) {
  const eligibleRecords: InvoiceGeneratorServiceRecord[][] = [];
  const selectedItems: Set<string>[] = [];
  const loading: boolean[] = [];
  const labels: string[] = [];
  const isGeneratingInvoiceRef = { current: false };
  const eligibleRecordsAbortControllerRef: { current: AbortController | null } = { current: null };
  const showInfoToast = vi.fn();
  const showErrorToast = vi.fn();

  return {
    eligibleRecords,
    selectedItems,
    loading,
    labels,
    isGeneratingInvoiceRef,
    eligibleRecordsAbortControllerRef,
    showInfoToast,
    showErrorToast,
    args: {
      showInvoiceModal: true,
      isGeneratingInvoiceRef,
      eligibleRecordsAbortControllerRef,
      setLoadingEligible: (value: boolean) => loading.push(value),
      setEligibleRecords: (records: InvoiceGeneratorServiceRecord[]) => eligibleRecords.push(records),
      setSelectedItems: (items: Set<string>) => selectedItems.push(items),
      setNdisStatusFieldLabel: (label: string) => labels.push(label),
      fetchOptions: {
        ...baseParamOptions,
        axios: { get: (_url: string, config: object) => getImpl(config as { signal: AbortSignal }) },
        id: 'ws-1',
        boardId: 'board-9',
      },
      showInfoToast,
      showErrorToast,
    },
  };
}

describe('runEligibleRecordsLoad', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:4001';
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('clears the records and fetches nothing while the modal is closed', async () => {
    const get = vi.fn();
    const harness = makeLoadHarness(get as never);
    await runEligibleRecordsLoad({ ...harness.args, showInvoiceModal: false });

    expect(harness.eligibleRecords).toEqual([[]]);
    expect(get).not.toHaveBeenCalled();
    expect(harness.loading).toEqual([]);
  });

  it('stores the returned records, selects them all and toggles the loading flag', async () => {
    const records = [makeRecord(), makeRecord({ id: 'item-2:0', participant: 'Jane Doe' })];
    const harness = makeLoadHarness(async () => ({ data: { items: records, total: 2 } }));
    await runEligibleRecordsLoad(harness.args);

    expect(harness.eligibleRecords).toEqual([records]);
    expect(harness.selectedItems).toEqual([new Set(['item-1:0', 'item-2:0'])]);
    expect(harness.loading).toEqual([true, false]);
    expect(harness.showInfoToast).toHaveBeenCalledWith('Loaded 2 eligible records', expect.any(Object));
  });

  it('aborts a request that is still in flight before starting the next one', async () => {
    const previous = new AbortController();
    const harness = makeLoadHarness(async () => ({ data: { items: [], total: 0 } }));
    harness.eligibleRecordsAbortControllerRef.current = previous;

    await runEligibleRecordsLoad(harness.args);

    expect(previous.signal.aborted).toBe(true);
    expect(harness.eligibleRecordsAbortControllerRef.current).not.toBe(previous);
    expect(harness.eligibleRecordsAbortControllerRef.current?.signal.aborted).toBe(false);
  });

  it('adopts the NDIS status field label only on an NDIS board', async () => {
    const ndis = makeLoadHarness(async () => ({
      data: { items: [makeRecord()], total: 1, statusFieldLabel: 'Claim Status' },
    }));
    await runEligibleRecordsLoad({
      ...ndis.args,
      fetchOptions: { ...ndis.args.fetchOptions, isNdisBoard: true },
    });
    expect(ndis.labels).toEqual(['Claim Status']);

    const standard = makeLoadHarness(async () => ({
      data: { items: [makeRecord()], total: 1, statusFieldLabel: 'Claim Status' },
    }));
    await runEligibleRecordsLoad(standard.args);
    expect(standard.labels).toEqual([]);
  });

  it('reports that nothing matched when the response carries no items array', async () => {
    const harness = makeLoadHarness(async () => ({ data: { total: 0 } }));
    await runEligibleRecordsLoad(harness.args);

    expect(harness.showInfoToast).toHaveBeenCalledWith('No eligible records found', {
      description: 'No records match your current filters.',
    });
    expect(harness.eligibleRecords).toEqual([]);
    expect(harness.loading).toEqual([true, false]);
  });

  it('stays silent while an invoice is being generated but still applies the records', async () => {
    const records = [makeRecord()];
    const harness = makeLoadHarness(async () => ({ data: { items: records, total: 1 } }));
    harness.isGeneratingInvoiceRef.current = true;

    await runEligibleRecordsLoad(harness.args);

    expect(harness.eligibleRecords).toEqual([records]);
    expect(harness.showInfoToast).not.toHaveBeenCalled();
  });

  it('shows the failure toast and empties the list when the request fails', async () => {
    const harness = makeLoadHarness(async () => {
      throw new Error('Request failed with status code 500');
    });
    await runEligibleRecordsLoad(harness.args);

    expect(harness.showErrorToast).toHaveBeenCalledWith('Failed to fetch eligible records', {
      description: 'Request failed with status code 500',
    });
    expect(harness.eligibleRecords).toEqual([[]]);
  });

  it('describes a non-Error rejection as an unknown error', async () => {
    const harness = makeLoadHarness(async () => {
      throw { status: 502 };
    });
    await runEligibleRecordsLoad(harness.args);

    expect(harness.showErrorToast).toHaveBeenCalledWith('Failed to fetch eligible records', {
      description: 'Unknown error',
    });
  });

  it('swallows an axios cancellation without toasting or clearing the records', async () => {
    const harness = makeLoadHarness(async (config) => {
      (harness.eligibleRecordsAbortControllerRef.current as AbortController).abort();
      const error = new Error('canceled') as Error & { code?: string };
      error.code = 'ERR_CANCELED';
      void config;
      throw error;
    });
    await runEligibleRecordsLoad(harness.args);

    expect(harness.showErrorToast).not.toHaveBeenCalled();
    expect(harness.eligibleRecords).toEqual([]);
    // The request was superseded, so the newer load owns the loading flag.
    expect(harness.loading).toEqual([true]);
  });

  it('swallows a DOM AbortError the same way', async () => {
    const harness = makeLoadHarness(async () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    });
    await runEligibleRecordsLoad(harness.args);

    expect(harness.showErrorToast).not.toHaveBeenCalled();
    expect(harness.eligibleRecords).toEqual([]);
    expect(harness.loading).toEqual([true, false]);
  });

  it('passes the fresh abort signal down to the request', async () => {
    let seen: AbortSignal | undefined;
    const harness: LoadHarness = makeLoadHarness(async (config) => {
      seen = config.signal;
      return { data: { items: [], total: 0 } };
    });
    await runEligibleRecordsLoad(harness.args);

    expect(seen).toBe(harness.eligibleRecordsAbortControllerRef.current?.signal);
  });
});
