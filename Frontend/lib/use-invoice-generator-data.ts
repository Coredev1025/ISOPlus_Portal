import { useEffect, type Dispatch, type SetStateAction } from 'react';
import axios from '@/app/utils/axiosConfig';
import { buildInvoiceGeneratorSearchParams } from '@/lib/invoice-generator-helpers';
import type {
  InvoiceGeneratorServiceRecord,
  InvoiceGeneratorSummary,
} from '@/lib/invoice-generator-types';

export function useInvoiceGeneratorServiceRecords({
  id,
  boardId,
  isNdisBoard,
  statusFilter,
  participantFilter,
  transactionStatusFilter,
  paymentStatusFilter,
  jobStatusFilter,
  scheduledServiceDateRange,
  serviceDeliveryDateRange,
  sortBy,
  sortOrder,
  currentPage,
  itemsPerPage,
  businessTimezone,
  refreshKey,
  getTransactionStatusSearchValue,
  dateToStartOfDayISO,
  dateToEndOfDayISO,
  abortControllerRef,
  setLoading,
  setError,
  setServiceRecords,
  setSummary,
  setLastSyncedAt,
  setNdisStatusFieldLabel,
}: {
  id: string;
  boardId: string;
  isNdisBoard: boolean;
  statusFilter: string;
  participantFilter: string;
  transactionStatusFilter: string;
  paymentStatusFilter: string;
  jobStatusFilter: string;
  scheduledServiceDateRange: any;
  serviceDeliveryDateRange: any;
  sortBy: string;
  sortOrder: string;
  currentPage: number;
  itemsPerPage: number;
  businessTimezone: string;
  refreshKey: number;
  getTransactionStatusSearchValue: (filter: string) => string | null | undefined;
  dateToStartOfDayISO: (date: Date, timezone: string) => string;
  dateToEndOfDayISO: (date: Date, timezone: string) => string;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  setLoading: (value: boolean) => void;
  setError: (value: string | null) => void;
  setServiceRecords: Dispatch<SetStateAction<InvoiceGeneratorServiceRecord[]>>;
  setSummary: Dispatch<SetStateAction<InvoiceGeneratorSummary>>;
  setLastSyncedAt: (date: Date) => void;
  setNdisStatusFieldLabel: (label: string) => void;
}) {
  useEffect(() => {
    const fetchData = async () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      setLoading(true);
      setError(null);
      try {
        const apiUrl = isNdisBoard
          ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/invoice-generator-ndis`
          : `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/invoice-generator`;

        const params = buildInvoiceGeneratorSearchParams({
          statusFilter,
          participantFilter,
          transactionStatusFilter,
          paymentStatusFilter,
          jobStatusFilter,
          isNdisBoard,
          scheduledServiceDateRange,
          serviceDeliveryDateRange,
          sortBy,
          sortOrder,
          currentPage,
          itemsPerPage,
          businessTimezone,
          getTransactionStatusSearchValue,
          dateToStartOfDayISO,
          dateToEndOfDayISO,
        });

        const response = await axios.get(apiUrl, {
          params: Object.fromEntries(params),
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          signal: abortController.signal,
        });

        if (!response.data || typeof response.data !== 'object') {
          throw new Error('Invalid data format received from server');
        }

        const {
          items = [],
          total = 0,
          invoiced = 0,
          pending = 0,
          totalAmount = 0,
          totalGovSubsidy = 0,
          totalParticipantContribution = 0,
          statusFieldLabel,
        } = response.data;

        if (!Array.isArray(items)) {
          throw new Error('Invalid items format received from server');
        }

        if (isNdisBoard && statusFieldLabel) {
          setNdisStatusFieldLabel(statusFieldLabel);
        }

        setServiceRecords(items);
        setSummary({
          totalRecords: total,
          invoiced,
          pending,
          totalValue: totalAmount,
          totalGovSubsidy,
          totalParticipantContribution,
        });
        setLastSyncedAt(new Date());
      } catch (err: any) {
        if (err.name === 'AbortError' || err.code === 'ERR_CANCELED') return;
        const errorMessage = err.response?.data?.message || err.message || 'An error occurred while fetching data';
        setError(errorMessage);
        console.error('Error fetching invoice data:', err);
      } finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    };

    if (id && boardId) {
      fetchData();
    }

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [
    id,
    boardId,
    isNdisBoard,
    statusFilter,
    participantFilter,
    scheduledServiceDateRange,
    serviceDeliveryDateRange,
    transactionStatusFilter,
    paymentStatusFilter,
    jobStatusFilter,
    sortBy,
    sortOrder,
    currentPage,
    itemsPerPage,
    businessTimezone,
    refreshKey,
    abortControllerRef,
    setLoading,
    setError,
    setServiceRecords,
    setSummary,
    setLastSyncedAt,
    setNdisStatusFieldLabel,
    getTransactionStatusSearchValue,
    dateToStartOfDayISO,
    dateToEndOfDayISO,
  ]);
}

export function useInvoiceGeneratorPaymentOptions({
  id,
  boardId,
  isNdisBoard,
  defaultOptions,
  setNdisPaymentStatusOptions,
}: {
  id: string;
  boardId: string;
  isNdisBoard: boolean;
  defaultOptions: string[];
  setNdisPaymentStatusOptions: (options: string[]) => void;
}) {
  useEffect(() => {
    const fetchPaymentStatusOptions = async () => {
      try {
        if (!isNdisBoard) return;
        const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/invoice-generator-ndis/payment-status-options`;
        const response = await axios.get(apiUrl, {
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        });
        const options = Array.isArray(response.data?.options) ? response.data.options : [];
        const cleaned = options.map((o: unknown) => String(o || '').trim()).filter((s: string) => s);
        setNdisPaymentStatusOptions(cleaned.length > 0 ? cleaned : defaultOptions);
      } catch {
        setNdisPaymentStatusOptions(defaultOptions);
      }
    };

    if (id && boardId) {
      fetchPaymentStatusOptions();
    }
  }, [id, boardId, isNdisBoard, defaultOptions, setNdisPaymentStatusOptions]);
}

export function useInvoiceGeneratorParticipants({
  id,
  boardId,
  isNdisBoard,
  setUniqueParticipants,
}: {
  id: string;
  boardId: string;
  isNdisBoard: boolean;
  setUniqueParticipants: (participants: string[]) => void;
}) {
  useEffect(() => {
    const fetchParticipants = async () => {
      try {
        const apiUrl = isNdisBoard
          ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/invoice-generator-ndis/participants`
          : `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/invoice-generator/participants`;

        const response = await axios.get(apiUrl, {
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        });

        if (response.data?.participants) {
          const participants = response.data.participants.filter((p: string) => p && p.trim() !== '');
          setUniqueParticipants(participants as string[]);
        }
      } catch (err) {
        console.error('Error fetching participants:', err);
      }
    };

    if (id && boardId) {
      fetchParticipants();
    }
  }, [id, boardId, isNdisBoard, setUniqueParticipants]);
}
