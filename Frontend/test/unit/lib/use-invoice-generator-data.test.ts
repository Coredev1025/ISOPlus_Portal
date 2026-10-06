import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { createRef } from 'react';
import {
  useInvoiceGeneratorServiceRecords,
  useInvoiceGeneratorPaymentOptions,
  useInvoiceGeneratorParticipants,
} from '@/lib/use-invoice-generator-data';
import { getTransactionStatusSearchValue } from '@/lib/invoice-generator-helpers';
import { dateToStartOfDayISO, dateToEndOfDayISO } from '@/lib/timezone';
import { server } from '../../msw/server';

const BACKEND = 'https://api.isoplus.test';
const WORKSPACE_ID = '1420';
const BOARD_ID = '9911';
const AGED_CARE_URL = `${BACKEND}/api/items/${WORKSPACE_ID}/${BOARD_ID}/invoice-generator`;
const NDIS_URL = `${BACKEND}/api/items/${WORKSPACE_ID}/${BOARD_ID}/invoice-generator-ndis`;

let originalBackendUrl: string | undefined;

// One record shaped like the backend's transformInvoiceGeneratorProcessedItem output.
const SERVICE_RECORD = {
  id: '778001',
  status: 'pending',
  paymentStatus: 'Unpaid',
  participant: 'Jane Doe',
  service: 'Domestic Assistance',
  scheduledServiceDate: '2026-03-10T09:00:00.000Z',
  serviceDeliveryDate: '2026-03-10T11:00:00.000Z',
  unit: 'Hour',
  quantity: 2,
  unitPrice: 72.5,
  totalAmount: 145,
  govSubsidy: 130.5,
  participantContribution: 14.5,
  fundingSource: 'Home Support(HS) Quarterly',
  transactionStatus: 'Delivered - To be claimed and invoiced.',
  notes: 'Client requested a later start.',
  fileUrl: null,
  invoiceNumber: undefined,
  careRecipientIdentifier: 'AC12345678',
  serviceIdentifier: 'HS-ON-01',
  deliveredByThirdParty: 'False',
  itemOrWraparound: '',
  itemDescriptionCode: '',
  itemDescription: '',
  wraparoundDescriptionCode: '',
  wraparoundDescription: '',
  prescribedItem: 'N',
  itemPurchasedMethod: '',
};

const AGED_CARE_PAYLOAD = {
  items: [SERVICE_RECORD],
  total: 37,
  totalAmount: 4821.75,
  totalGovSubsidy: 4339.57,
  totalParticipantContribution: 482.18,
};

function makeServiceRecordProps(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKSPACE_ID,
    boardId: BOARD_ID,
    isNdisBoard: false,
    statusFilter: 'all',
    participantFilter: 'Jane Doe',
    transactionStatusFilter: 'delivered',
    paymentStatusFilter: 'all',
    jobStatusFilter: 'Completed',
    scheduledServiceDateRange: {
      from: new Date('2026-03-10T05:00:00.000Z'),
      to: new Date('2026-03-12T02:30:00.000Z'),
    },
    serviceDeliveryDateRange: undefined,
    sortBy: 'scheduledServiceDate',
    sortOrder: 'desc',
    currentPage: 2,
    itemsPerPage: 25,
    businessTimezone: 'Australia/Sydney',
    refreshKey: 0,
    getTransactionStatusSearchValue,
    dateToStartOfDayISO,
    dateToEndOfDayISO,
    abortControllerRef: createRef<AbortController>() as React.MutableRefObject<AbortController | null>,
    setLoading: vi.fn(),
    setError: vi.fn(),
    setServiceRecords: vi.fn(),
    setSummary: vi.fn(),
    setLastSyncedAt: vi.fn(),
    setNdisStatusFieldLabel: vi.fn(),
    ...overrides,
  };
}

function queryOf(url: string) {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

beforeAll(() => {
  originalBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
  process.env.NEXT_PUBLIC_BACKEND_URL = BACKEND;
});

afterAll(() => {
  process.env.NEXT_PUBLIC_BACKEND_URL = originalBackendUrl;
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useInvoiceGeneratorServiceRecords', () => {
  it('requests the aged-care endpoint with the filters translated into query params', async () => {
    let requestedUrl = '';
    server.use(
      http.get(AGED_CARE_URL, ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json(AGED_CARE_PAYLOAD);
      })
    );

    const props = makeServiceRecordProps();
    renderHook(() => useInvoiceGeneratorServiceRecords(props as any));

    await waitFor(() => expect(props.setServiceRecords).toHaveBeenCalled());

    expect(new URL(requestedUrl).pathname).toBe('/api/items/1420/9911/invoice-generator');
    expect(queryOf(requestedUrl)).toEqual({
      participant: 'Jane Doe',
      transactionStatus: 'Delivered - To be claimed and invoiced.',
      startDate: '2026-03-09T13:00:00.000Z',
      endDate: '2026-03-12T12:59:59.999Z',
      sortBy: 'scheduledServiceDate',
      sortOrder: 'desc',
      page: '2',
      limit: '25',
    });
  });

  it('stores the returned items and summary and stops loading', async () => {
    server.use(http.get(AGED_CARE_URL, () => HttpResponse.json(AGED_CARE_PAYLOAD)));

    const props = makeServiceRecordProps();
    renderHook(() => useInvoiceGeneratorServiceRecords(props as any));

    await waitFor(() => expect(props.setLoading).toHaveBeenCalledTimes(2));

    expect(props.setLoading.mock.calls).toEqual([[true], [false]]);
    expect(props.setError).toHaveBeenCalledWith(null);
    expect(props.setServiceRecords).toHaveBeenCalledWith([SERVICE_RECORD]);
    expect(props.setSummary).toHaveBeenCalledWith({
      totalRecords: 37,
      invoiced: 0,
      pending: 0,
      totalValue: 4821.75,
      totalGovSubsidy: 4339.57,
      totalParticipantContribution: 482.18,
    });
    expect(props.setLastSyncedAt).toHaveBeenCalledTimes(1);
    expect(props.setLastSyncedAt.mock.calls[0][0]).toBeInstanceOf(Date);
    expect(props.setNdisStatusFieldLabel).not.toHaveBeenCalled();
  });

  it('defaults every missing summary field to zero and the items to an empty list', async () => {
    server.use(http.get(AGED_CARE_URL, () => HttpResponse.json({})));

    const props = makeServiceRecordProps();
    renderHook(() => useInvoiceGeneratorServiceRecords(props as any));

    await waitFor(() => expect(props.setSummary).toHaveBeenCalled());

    expect(props.setServiceRecords).toHaveBeenCalledWith([]);
    expect(props.setSummary).toHaveBeenCalledWith({
      totalRecords: 0,
      invoiced: 0,
      pending: 0,
      totalValue: 0,
      totalGovSubsidy: 0,
      totalParticipantContribution: 0,
    });
  });

  it('uses the NDIS endpoint, sends jobStatus, and records the NDIS status field label', async () => {
    let requestedUrl = '';
    server.use(
      http.get(NDIS_URL, ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json({
          items: [SERVICE_RECORD],
          total: 1,
          totalAmount: 145,
          totalGovSubsidy: 130.5,
          totalParticipantContribution: 14.5,
          statusFieldLabel: 'Shift Status',
        });
      })
    );

    const props = makeServiceRecordProps({
      isNdisBoard: true,
      statusFilter: 'pending',
      paymentStatusFilter: 'Unpaid',
      scheduledServiceDateRange: undefined,
      serviceDeliveryDateRange: { from: new Date('2026-03-10T05:00:00.000Z') },
    });
    renderHook(() => useInvoiceGeneratorServiceRecords(props as any));

    await waitFor(() => expect(props.setServiceRecords).toHaveBeenCalled());

    expect(new URL(requestedUrl).pathname).toBe('/api/items/1420/9911/invoice-generator-ndis');
    expect(queryOf(requestedUrl)).toEqual({
      status: 'pending',
      participant: 'Jane Doe',
      transactionStatus: 'Delivered - To be claimed and invoiced.',
      paymentStatus: 'Unpaid',
      jobStatus: 'Completed',
      serviceDeliveryStart: '2026-03-09T13:00:00.000Z',
      serviceDeliveryEnd: '2026-03-10T12:59:59.999Z',
      sortBy: 'scheduledServiceDate',
      sortOrder: 'desc',
      page: '2',
      limit: '25',
    });
    expect(props.setNdisStatusFieldLabel).toHaveBeenCalledWith('Shift Status');
  });

  it('ignores the status field label on an aged-care board even when the server sends one', async () => {
    server.use(
      http.get(AGED_CARE_URL, () => HttpResponse.json({ ...AGED_CARE_PAYLOAD, statusFieldLabel: 'Shift Status' }))
    );

    const props = makeServiceRecordProps();
    renderHook(() => useInvoiceGeneratorServiceRecords(props as any));

    await waitFor(() => expect(props.setServiceRecords).toHaveBeenCalled());

    expect(props.setNdisStatusFieldLabel).not.toHaveBeenCalled();
  });

  it('issues no request at all while the workspace id is empty', async () => {
    let hits = 0;
    server.use(
      http.get(`${BACKEND}/*`, () => {
        hits += 1;
        return HttpResponse.json(AGED_CARE_PAYLOAD);
      })
    );

    const props = makeServiceRecordProps({ id: '' });
    renderHook(() => useInvoiceGeneratorServiceRecords(props as any));

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hits).toBe(0);
    expect(props.setLoading).not.toHaveBeenCalled();
    expect(props.setError).not.toHaveBeenCalled();
  });

  it('issues no request while the board id is empty', async () => {
    let hits = 0;
    server.use(
      http.get(`${BACKEND}/*`, () => {
        hits += 1;
        return HttpResponse.json(AGED_CARE_PAYLOAD);
      })
    );

    const props = makeServiceRecordProps({ boardId: '' });
    renderHook(() => useInvoiceGeneratorServiceRecords(props as any));

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hits).toBe(0);
    expect(props.setLoading).not.toHaveBeenCalled();
  });

  it('surfaces the server message from a failed response', async () => {
    server.use(
      http.get(AGED_CARE_URL, () => HttpResponse.json({ message: 'WorkspaceId and boardId are required' }, { status: 400 }))
    );

    const props = makeServiceRecordProps();
    renderHook(() => useInvoiceGeneratorServiceRecords(props as any));

    await waitFor(() => expect(props.setError).toHaveBeenCalledTimes(2));

    expect(props.setError.mock.calls).toEqual([[null], ['WorkspaceId and boardId are required']]);
    expect(props.setServiceRecords).not.toHaveBeenCalled();
    expect(props.setSummary).not.toHaveBeenCalled();
    expect(props.setLoading.mock.calls).toEqual([[true], [false]]);
  });

  it('falls back to the axios error message when the server sends no message field', async () => {
    server.use(http.get(AGED_CARE_URL, () => new HttpResponse(null, { status: 500 })));

    const props = makeServiceRecordProps();
    renderHook(() => useInvoiceGeneratorServiceRecords(props as any));

    await waitFor(() => expect(props.setError).toHaveBeenCalledTimes(2));

    expect(props.setError.mock.calls[1]).toEqual(['Request failed with status code 500']);
  });

  it('rejects a non-object response body', async () => {
    server.use(
      http.get(AGED_CARE_URL, () => new HttpResponse('not json at all', { headers: { 'Content-Type': 'text/plain' } }))
    );

    const props = makeServiceRecordProps();
    renderHook(() => useInvoiceGeneratorServiceRecords(props as any));

    await waitFor(() => expect(props.setError).toHaveBeenCalledTimes(2));

    expect(props.setError.mock.calls[1]).toEqual(['Invalid data format received from server']);
    expect(props.setServiceRecords).not.toHaveBeenCalled();
  });

  it('rejects a response whose items field is not an array', async () => {
    server.use(http.get(AGED_CARE_URL, () => HttpResponse.json({ items: 'nope', total: 1 })));

    const props = makeServiceRecordProps();
    renderHook(() => useInvoiceGeneratorServiceRecords(props as any));

    await waitFor(() => expect(props.setError).toHaveBeenCalledTimes(2));

    expect(props.setError.mock.calls[1]).toEqual(['Invalid items format received from server']);
    expect(props.setSummary).not.toHaveBeenCalled();
  });

  it('refetches when refreshKey changes', async () => {
    let hits = 0;
    server.use(
      http.get(AGED_CARE_URL, () => {
        hits += 1;
        return HttpResponse.json(AGED_CARE_PAYLOAD);
      })
    );

    const props = makeServiceRecordProps();
    const { rerender } = renderHook((current: any) => useInvoiceGeneratorServiceRecords(current), {
      initialProps: props as any,
    });

    await waitFor(() => expect(hits).toBe(1));

    rerender({ ...props, refreshKey: 1 } as any);

    await waitFor(() => expect(hits).toBe(2));
    expect(props.setLastSyncedAt).toHaveBeenCalledTimes(2);
  });

  it('does not refetch when an unrelated prop changes', async () => {
    let hits = 0;
    server.use(
      http.get(AGED_CARE_URL, () => {
        hits += 1;
        return HttpResponse.json(AGED_CARE_PAYLOAD);
      })
    );

    const props = makeServiceRecordProps();
    const { rerender } = renderHook((current: any) => useInvoiceGeneratorServiceRecords(current), {
      initialProps: props as any,
    });

    await waitFor(() => expect(hits).toBe(1));

    rerender({ ...props, refreshKey: 0 } as any);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hits).toBe(1);
  });

  it('aborts the in-flight request on unmount, leaving loading switched on and no error reported', async () => {
    server.use(
      http.get(AGED_CARE_URL, async () => {
        await delay(60);
        return HttpResponse.json(AGED_CARE_PAYLOAD);
      })
    );

    const props = makeServiceRecordProps();
    const { unmount } = renderHook(() => useInvoiceGeneratorServiceRecords(props as any));

    await waitFor(() => expect(props.setLoading).toHaveBeenCalledWith(true));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(props.setLoading.mock.calls).toEqual([[true]]);
    expect(props.setError.mock.calls).toEqual([[null]]);
    expect(props.setServiceRecords).not.toHaveBeenCalled();
  });
});

describe('useInvoiceGeneratorPaymentOptions', () => {
  const DEFAULT_OPTIONS = ['Paid', 'Unpaid', 'Partially Paid'];
  const OPTIONS_URL = `${NDIS_URL}/payment-status-options`;

  it('trims the server options and drops the blank ones', async () => {
    let requestedUrl = '';
    server.use(
      http.get(OPTIONS_URL, ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json({ options: ['  Paid ', '', 'Unpaid', '   ', null] });
      })
    );

    const setNdisPaymentStatusOptions = vi.fn();
    renderHook(() =>
      useInvoiceGeneratorPaymentOptions({
        id: WORKSPACE_ID,
        boardId: BOARD_ID,
        isNdisBoard: true,
        defaultOptions: DEFAULT_OPTIONS,
        setNdisPaymentStatusOptions,
      })
    );

    await waitFor(() => expect(setNdisPaymentStatusOptions).toHaveBeenCalled());

    expect(new URL(requestedUrl).pathname).toBe(
      '/api/items/1420/9911/invoice-generator-ndis/payment-status-options'
    );
    expect(setNdisPaymentStatusOptions).toHaveBeenCalledWith(['Paid', 'Unpaid']);
  });

  it('falls back to the defaults when the server returns no usable options', async () => {
    server.use(http.get(OPTIONS_URL, () => HttpResponse.json({ options: ['', '  '] })));

    const setNdisPaymentStatusOptions = vi.fn();
    renderHook(() =>
      useInvoiceGeneratorPaymentOptions({
        id: WORKSPACE_ID,
        boardId: BOARD_ID,
        isNdisBoard: true,
        defaultOptions: DEFAULT_OPTIONS,
        setNdisPaymentStatusOptions,
      })
    );

    await waitFor(() => expect(setNdisPaymentStatusOptions).toHaveBeenCalledWith(DEFAULT_OPTIONS));
  });

  it('falls back to the defaults when the request fails', async () => {
    server.use(http.get(OPTIONS_URL, () => HttpResponse.json({ message: 'Server error' }, { status: 500 })));

    const setNdisPaymentStatusOptions = vi.fn();
    renderHook(() =>
      useInvoiceGeneratorPaymentOptions({
        id: WORKSPACE_ID,
        boardId: BOARD_ID,
        isNdisBoard: true,
        defaultOptions: DEFAULT_OPTIONS,
        setNdisPaymentStatusOptions,
      })
    );

    await waitFor(() => expect(setNdisPaymentStatusOptions).toHaveBeenCalledWith(DEFAULT_OPTIONS));
  });

  it('makes no request and sets nothing on a non-NDIS board', async () => {
    let hits = 0;
    server.use(
      http.get(`${BACKEND}/*`, () => {
        hits += 1;
        return HttpResponse.json({ options: ['Paid'] });
      })
    );

    const setNdisPaymentStatusOptions = vi.fn();
    renderHook(() =>
      useInvoiceGeneratorPaymentOptions({
        id: WORKSPACE_ID,
        boardId: BOARD_ID,
        isNdisBoard: false,
        defaultOptions: DEFAULT_OPTIONS,
        setNdisPaymentStatusOptions,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hits).toBe(0);
    expect(setNdisPaymentStatusOptions).not.toHaveBeenCalled();
  });

  it('makes no request while the board id is empty', async () => {
    let hits = 0;
    server.use(
      http.get(`${BACKEND}/*`, () => {
        hits += 1;
        return HttpResponse.json({ options: ['Paid'] });
      })
    );

    const setNdisPaymentStatusOptions = vi.fn();
    renderHook(() =>
      useInvoiceGeneratorPaymentOptions({
        id: WORKSPACE_ID,
        boardId: '',
        isNdisBoard: true,
        defaultOptions: DEFAULT_OPTIONS,
        setNdisPaymentStatusOptions,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hits).toBe(0);
    expect(setNdisPaymentStatusOptions).not.toHaveBeenCalled();
  });
});

describe('useInvoiceGeneratorParticipants', () => {
  it('fetches the aged-care participants and drops blank names', async () => {
    let requestedUrl = '';
    server.use(
      http.get(`${AGED_CARE_URL}/participants`, ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json({ participants: ['Jane Doe', '', '   ', 'John Smith'] });
      })
    );

    const setUniqueParticipants = vi.fn();
    renderHook(() =>
      useInvoiceGeneratorParticipants({
        id: WORKSPACE_ID,
        boardId: BOARD_ID,
        isNdisBoard: false,
        setUniqueParticipants,
      })
    );

    await waitFor(() => expect(setUniqueParticipants).toHaveBeenCalled());

    expect(new URL(requestedUrl).pathname).toBe('/api/items/1420/9911/invoice-generator/participants');
    expect(setUniqueParticipants).toHaveBeenCalledWith(['Jane Doe', 'John Smith']);
  });

  it('fetches the NDIS participants endpoint on an NDIS board', async () => {
    let requestedUrl = '';
    server.use(
      http.get(`${NDIS_URL}/participants`, ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json({ participants: ['Jane Doe'] });
      })
    );

    const setUniqueParticipants = vi.fn();
    renderHook(() =>
      useInvoiceGeneratorParticipants({
        id: WORKSPACE_ID,
        boardId: BOARD_ID,
        isNdisBoard: true,
        setUniqueParticipants,
      })
    );

    await waitFor(() => expect(setUniqueParticipants).toHaveBeenCalledWith(['Jane Doe']));

    expect(new URL(requestedUrl).pathname).toBe(
      '/api/items/1420/9911/invoice-generator-ndis/participants'
    );
  });

  it('leaves the participant list untouched when the response has no participants field', async () => {
    server.use(http.get(`${AGED_CARE_URL}/participants`, () => HttpResponse.json({ total: 0 })));

    const setUniqueParticipants = vi.fn();
    renderHook(() =>
      useInvoiceGeneratorParticipants({
        id: WORKSPACE_ID,
        boardId: BOARD_ID,
        isNdisBoard: false,
        setUniqueParticipants,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(setUniqueParticipants).not.toHaveBeenCalled();
  });

  it('swallows a failed request and logs it instead of setting participants', async () => {
    server.use(
      http.get(`${AGED_CARE_URL}/participants`, () => HttpResponse.json({ message: 'Server error' }, { status: 500 }))
    );

    const setUniqueParticipants = vi.fn();
    renderHook(() =>
      useInvoiceGeneratorParticipants({
        id: WORKSPACE_ID,
        boardId: BOARD_ID,
        isNdisBoard: false,
        setUniqueParticipants,
      })
    );

    await waitFor(() => expect(console.error).toHaveBeenCalledWith('Error fetching participants:', expect.anything()));

    expect(setUniqueParticipants).not.toHaveBeenCalled();
  });

  it('makes no request while the workspace id is empty', async () => {
    let hits = 0;
    server.use(
      http.get(`${BACKEND}/*`, () => {
        hits += 1;
        return HttpResponse.json({ participants: ['Jane Doe'] });
      })
    );

    const setUniqueParticipants = vi.fn();
    renderHook(() =>
      useInvoiceGeneratorParticipants({
        id: '',
        boardId: BOARD_ID,
        isNdisBoard: false,
        setUniqueParticipants,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hits).toBe(0);
    expect(setUniqueParticipants).not.toHaveBeenCalled();
  });
});
