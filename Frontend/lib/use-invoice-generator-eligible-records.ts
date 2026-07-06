import { useEffect, type Dispatch, type SetStateAction } from 'react';
import axios from '@/app/utils/axiosConfig';
import { showErrorToast, showInfoToast } from '@/lib/toast-utils';
import { runEligibleRecordsLoad } from '@/lib/invoice-generator-eligible-records-helpers';
import type { InvoiceGeneratorServiceRecord } from '@/lib/invoice-generator-types';
import type { MutableRefObject } from 'react';
import type { DateRange } from 'react-day-picker';

export function useInvoiceGeneratorEligibleRecords({
  showInvoiceModal,
  id,
  boardId,
  isNdisBoard,
  participantFilter,
  scheduledServiceDateRange,
  serviceDeliveryDateRange,
  transactionStatusFilter,
  paymentStatusFilter,
  jobStatusFilter,
  sortBy,
  sortOrder,
  refreshKey,
  businessTimezone,
  eligibleRecordsAbortControllerRef,
  isGeneratingInvoiceRef,
  setLoadingEligible,
  setEligibleRecords,
  setSelectedItems,
  setNdisStatusFieldLabel,
}: {
  showInvoiceModal: boolean;
  id: string;
  boardId: string;
  isNdisBoard: boolean;
  participantFilter: string;
  scheduledServiceDateRange?: DateRange;
  serviceDeliveryDateRange?: DateRange;
  transactionStatusFilter: string;
  paymentStatusFilter: string;
  jobStatusFilter: string;
  sortBy: string;
  sortOrder: string;
  refreshKey: number;
  businessTimezone: string;
  eligibleRecordsAbortControllerRef: MutableRefObject<AbortController | null>;
  isGeneratingInvoiceRef: MutableRefObject<boolean>;
  setLoadingEligible: (value: boolean) => void;
  setEligibleRecords: Dispatch<SetStateAction<InvoiceGeneratorServiceRecord[]>>;
  setSelectedItems: (items: Set<string>) => void;
  setNdisStatusFieldLabel: (label: string) => void;
}) {
  useEffect(() => {
    runEligibleRecordsLoad({
      showInvoiceModal,
      isGeneratingInvoiceRef,
      eligibleRecordsAbortControllerRef,
      setLoadingEligible,
      setEligibleRecords,
      setSelectedItems,
      setNdisStatusFieldLabel,
      fetchOptions: {
        axios,
        isNdisBoard,
        id,
        boardId,
        participantFilter,
        scheduledServiceDateRange,
        serviceDeliveryDateRange,
        transactionStatusFilter,
        paymentStatusFilter,
        jobStatusFilter,
        sortBy,
        sortOrder,
        businessTimezone,
      },
      showInfoToast,
      showErrorToast,
    });
    return () => {
      if (eligibleRecordsAbortControllerRef.current) {
        eligibleRecordsAbortControllerRef.current.abort();
      }
    };
  }, [
    showInvoiceModal,
    id,
    boardId,
    participantFilter,
    scheduledServiceDateRange,
    serviceDeliveryDateRange,
    transactionStatusFilter,
    paymentStatusFilter,
    jobStatusFilter,
    sortBy,
    sortOrder,
    refreshKey,
    isNdisBoard,
    businessTimezone,
    eligibleRecordsAbortControllerRef,
    isGeneratingInvoiceRef,
    setLoadingEligible,
    setEligibleRecords,
    setSelectedItems,
    setNdisStatusFieldLabel,
  ]);
}
