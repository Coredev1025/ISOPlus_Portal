import type { DateRange } from 'react-day-picker';
import { getTransactionStatusSearchValue } from '@/lib/invoice-generator-helpers';
import { dateToStartOfDayISO, dateToEndOfDayISO } from '@/lib/timezone';

import type { InvoiceGeneratorServiceRecord } from '@/lib/invoice-generator-types';

export function buildEligibleRecordsSearchParams(options: {
  isNdisBoard: boolean;
  participantFilter: string;
  scheduledServiceDateRange?: DateRange;
  serviceDeliveryDateRange?: DateRange;
  transactionStatusFilter: string;
  paymentStatusFilter: string;
  jobStatusFilter: string;
  sortBy: string;
  sortOrder: string;
  businessTimezone: string;
}) {
  const params = new URLSearchParams();
  params.append('status', 'all');

  if (options.participantFilter && options.participantFilter !== 'all') {
    params.append('participant', options.participantFilter);
  }
  if (options.scheduledServiceDateRange?.from) {
    params.append('startDate', dateToStartOfDayISO(new Date(options.scheduledServiceDateRange.from), options.businessTimezone));
  }
  if (options.scheduledServiceDateRange?.to || options.scheduledServiceDateRange?.from) {
    const toSource = options.scheduledServiceDateRange?.to || options.scheduledServiceDateRange?.from;
    params.append('endDate', dateToEndOfDayISO(new Date(toSource as Date), options.businessTimezone));
  }
  if (options.serviceDeliveryDateRange?.from) {
    params.append('serviceDeliveryStart', dateToStartOfDayISO(new Date(options.serviceDeliveryDateRange.from), options.businessTimezone));
  }
  if (options.serviceDeliveryDateRange?.to || options.serviceDeliveryDateRange?.from) {
    const toSource = options.serviceDeliveryDateRange?.to || options.serviceDeliveryDateRange?.from;
    params.append('serviceDeliveryEnd', dateToEndOfDayISO(new Date(toSource as Date), options.businessTimezone));
  }

  const transactionStatusParam = getTransactionStatusSearchValue(options.transactionStatusFilter);
  if (transactionStatusParam) params.append('transactionStatus', transactionStatusParam);
  if (options.paymentStatusFilter !== 'all') params.append('paymentStatus', options.paymentStatusFilter);
  if (options.isNdisBoard && options.jobStatusFilter !== 'all') params.append('jobStatus', options.jobStatusFilter);

  params.append('sortBy', options.sortBy);
  params.append('sortOrder', options.sortOrder);
  params.append('page', '1');
  params.append('limit', '1000');

  return params;
}

export function showEligibleRecordsLoadedToasts(
  items: InvoiceGeneratorServiceRecord[],
  total: number,
  showInfoToast: (message: string, options?: { description?: string }) => void,
) {
  if (items.length === 0) {
    return;
  }
  if (total > items.length) {
    showInfoToast(`Loaded ${items.length} of ${total} eligible records`, {
      description: 'Showing first 1000 records. Use filters to narrow down if needed.',
    });
    return;
  }
  showInfoToast(`Loaded ${items.length} eligible record${items.length === 1 ? '' : 's'}`, {
    description: 'All records (including invoiced) are shown. You can select which ones to include in the invoice.',
  });
}

export async function fetchEligibleInvoiceRecords(options: {
  axios: { get: (url: string, config: object) => Promise<{ data?: any }> };
  isNdisBoard: boolean;
  id: string;
  boardId: string;
  participantFilter: string;
  scheduledServiceDateRange?: DateRange;
  serviceDeliveryDateRange?: DateRange;
  transactionStatusFilter: string;
  paymentStatusFilter: string;
  jobStatusFilter: string;
  sortBy: string;
  sortOrder: string;
  businessTimezone: string;
  signal: AbortSignal;
}) {
  const apiUrl = options.isNdisBoard
    ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${options.id}/${options.boardId}/invoice-generator-ndis`
    : `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${options.id}/${options.boardId}/invoice-generator`;

  const params = buildEligibleRecordsSearchParams(options);
  const response = await options.axios.get(apiUrl, {
    params: Object.fromEntries(params),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal: options.signal,
  });

  return response.data;
}

function applyEligibleRecordsResponse(
  data: { items?: InvoiceGeneratorServiceRecord[]; total?: number; statusFieldLabel?: string },
  options: {
    isNdisBoard: boolean;
    isGeneratingInvoiceRef: { current: boolean };
    setEligibleRecords: (records: InvoiceGeneratorServiceRecord[]) => void;
    setSelectedItems: (items: Set<string>) => void;
    setNdisStatusFieldLabel: (label: string) => void;
    showInfoToast: (message: string, options?: { description?: string }) => void;
  },
) {
  if (!data?.items) {
    if (!options.isGeneratingInvoiceRef.current) {
      options.showInfoToast('No eligible records found', { description: 'No records match your current filters.' });
    }
    return;
  }

  const items = data.items;
  const total = data.total || 0;
  if (options.isNdisBoard && data.statusFieldLabel) {
    options.setNdisStatusFieldLabel(data.statusFieldLabel);
  }

  options.setEligibleRecords(items);
  options.setSelectedItems(new Set(items.map((r) => r.id)));

  if (!options.isGeneratingInvoiceRef.current) {
    showEligibleRecordsLoadedToasts(items, total, options.showInfoToast);
  }
}

function handleEligibleRecordsFetchError(
  err: unknown,
  options: {
    isGeneratingInvoiceRef: { current: boolean };
    setEligibleRecords: (records: InvoiceGeneratorServiceRecord[]) => void;
    showErrorToast: (message: string, options?: { description?: string }) => void;
  },
) {
  const error = err as { name?: string; code?: string };
  if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') return;
  console.error('Error fetching eligible records:', err);
  if (!options.isGeneratingInvoiceRef.current) {
    options.showErrorToast('Failed to fetch eligible records', {
      description: err instanceof Error ? err.message : 'Unknown error',
    });
  }
  options.setEligibleRecords([]);
}

export async function runEligibleRecordsLoad({
  showInvoiceModal,
  isGeneratingInvoiceRef,
  eligibleRecordsAbortControllerRef,
  setLoadingEligible,
  setEligibleRecords,
  setSelectedItems,
  setNdisStatusFieldLabel,
  fetchOptions,
  showInfoToast,
  showErrorToast,
}: {
  showInvoiceModal: boolean;
  isGeneratingInvoiceRef: { current: boolean };
  eligibleRecordsAbortControllerRef: { current: AbortController | null };
  setLoadingEligible: (value: boolean) => void;
  setEligibleRecords: (records: InvoiceGeneratorServiceRecord[]) => void;
  setSelectedItems: (items: Set<string>) => void;
  setNdisStatusFieldLabel: (label: string) => void;
  fetchOptions: Omit<Parameters<typeof fetchEligibleInvoiceRecords>[0], 'signal'>;
  showInfoToast: (message: string, options?: { description?: string }) => void;
  showErrorToast: (message: string, options?: { description?: string }) => void;
}) {
  if (!showInvoiceModal) {
    setEligibleRecords([]);
    return;
  }

  if (eligibleRecordsAbortControllerRef.current) {
    eligibleRecordsAbortControllerRef.current.abort();
  }

  const abortController = new AbortController();
  eligibleRecordsAbortControllerRef.current = abortController;
  setLoadingEligible(true);

  try {
    const data = await fetchEligibleInvoiceRecords({
      ...fetchOptions,
      signal: abortController.signal,
    });

    applyEligibleRecordsResponse(data, {
      isNdisBoard: fetchOptions.isNdisBoard,
      isGeneratingInvoiceRef,
      setEligibleRecords,
      setSelectedItems,
      setNdisStatusFieldLabel,
      showInfoToast,
    });
  } catch (err: unknown) {
    handleEligibleRecordsFetchError(err, { isGeneratingInvoiceRef, setEligibleRecords, showErrorToast });
  } finally {
    if (!abortController.signal.aborted) {
      setLoadingEligible(false);
    }
  }
}
