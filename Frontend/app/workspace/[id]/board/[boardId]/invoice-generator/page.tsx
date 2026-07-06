"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, FileText, Search, Calendar, Filter, CheckCircle, DollarSign, BarChart3, FileSpreadsheet, Receipt, X, Percent, ArrowLeftCircle, ArrowRightCircle, Download, Clock, ArrowUpDown, ArrowUp, ArrowDown, HelpCircle } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useAppContext } from "@/app/context";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Input } from "@/components/ui/input";
import Spinner from "@/components/ui/spin";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import axios from "@/app/utils/axiosConfig";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { format, formatDistanceToNow } from "date-fns";
import { showSuccessToast, showErrorToast, showInfoToast, showWarningToast, getApiErrorMessage } from "@/lib/toast-utils";
import {
  getBoardNameFromSession,
  getSyncRefreshMode,
  isValidRouteIdParam,
} from "@/lib/sync-manual-helpers";
import { canAccessWorkspace } from "@/lib/access";
import { dateToStartOfDayISO, dateToEndOfDayISO, formatDateOnlyYYYYMMDD, formatDateDDMMYYYY } from "@/lib/timezone";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { DateRange } from "react-day-picker";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  TRANSACTION_STATUS_FILTERS,
  getTransactionStatusSearchValue,
  validateInvoiceGenerationInputs,
  buildInvoiceItemIds,
  getInvoiceGeneratorBoardFlags,
} from "@/lib/invoice-generator-helpers";
import { exportInvoiceGeneratorCsv } from "@/lib/invoice-generator-export-helpers";
import { buildInvoiceGeneratorTableColumns } from "@/lib/invoice-generator-table-columns";
import { useInvoiceGeneratorEligibleRecords } from "@/lib/use-invoice-generator-eligible-records";
import { InvoiceGeneratorPageView } from "@/lib/invoice-generator-page-view";
import {
  finalizePdfInvoiceGeneration,
} from "@/lib/invoice-generator-pdf-helpers";
import { generateXeroInvoiceFromModal } from "@/lib/invoice-generator-xero-helpers";
import { useInvoiceGeneratorSetup } from "@/lib/use-invoice-generator-setup";
import { pollInvoiceGeneratorSyncStatus } from "@/lib/invoice-generator-sync-helpers";
import {
  useInvoiceGeneratorParticipants,
  useInvoiceGeneratorServiceRecords,
  useInvoiceGeneratorPaymentOptions,
} from "@/lib/use-invoice-generator-data";

const PAYMENT_STATUS_FILTERS = [
  { value: "all", label: "All Payment Status" },
  { value: "Gov Claim Submitted", label: "Gov Claim Submitted" },
  { value: "Gov Claim Paid", label: "Gov Claim Paid" },
  { value: "Participant Invoiced", label: "Participant Invoiced" },
  { value: "Participant Paid", label: "Participant Paid" }
];

const NDIS_PAYMENT_STATUS_OPTIONS = [
  "Awaiting Payment",
  "Paid",
  "Partially Paid",
  "Overdue",
  "Void",
  "Disputed",
  "Refunded"
];

const SYDNEY_TIME_ZONE = "Australia/Sydney";

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatDateOnlyInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find(p => p.type === "year")?.value;
  const month = parts.find(p => p.type === "month")?.value;
  const day = parts.find(p => p.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("Failed to format date-only value.");
  }

  return `${year}-${month}-${day}`;
}

function addDaysDateOnlyUTC(yyyyMmDd: string, days: number) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (!match) {
    throw new Error(`Invalid date-only value: ${yyyyMmDd}`);
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);

  const dt = new Date(Date.UTC(year, monthIndex, day));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function getDefaultInvoiceDates(timeZone: string = SYDNEY_TIME_ZONE) {
  const invoiceDate = formatDateOnlyInTimeZone(new Date(), timeZone);
  const dueDate = addDaysDateOnlyUTC(invoiceDate, 14);
  return { invoiceDate, dueDate };
}

import type {
  InvoiceGeneratorServiceRecord,
  InvoiceGeneratorSummary,
} from '@/lib/invoice-generator-types';

export default function InvoiceGenerator() {
  const router = useRouter();
  const pathname = usePathname();
  const id = pathname.split('/')[2];
  const boardId = pathname.split('/')[4];
  const { workspaces, user, setCurrentWorkspaceId, syncStatuses, setSyncStatuses } = useAppContext();
  const workspace = workspaces.find(w => w.id.toString() === id);
  
  const [boardLabel, setBoardLabel] = useState<string>('');

  const [serviceRecords, setServiceRecords] = useState<InvoiceGeneratorServiceRecord[]>([]);
  const [summary, setSummary] = useState<InvoiceGeneratorSummary>({
    totalRecords: 0,
    invoiced: 0,
    pending: 0,
    totalValue: 0,
    totalGovSubsidy: 0,
    totalParticipantContribution: 0
  });
  const [participantFilter, setParticipantFilter] = useState("all");
  const [scheduledServiceDateRange, setScheduledServiceDateRange] = useState<DateRange | undefined>();
  const [serviceDeliveryDateRange, setServiceDeliveryDateRange] = useState<DateRange | undefined>();
  const [transactionStatusFilter, setTransactionStatusFilter] = useState("all");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState("all");
  const [jobStatusFilter, setJobStatusFilter] = useState("all");
  const [ndisStatusFieldLabel, setNdisStatusFieldLabel] = useState<string>('Job Status');
  const [ndisPaymentStatusOptions, setNdisPaymentStatusOptions] = useState<string[]>(NDIS_PAYMENT_STATUS_OPTIONS);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"scheduledServiceDate" | "serviceDeliveryDate">("scheduledServiceDate");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [loading, setLoading] = useState(true);
  const [exportingCSV, setExportingCSV] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const tableContainerRef = useRef<HTMLDivElement | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isManualSyncing, setIsManualSyncing] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const isGeneratingInvoiceRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const eligibleRecordsAbortControllerRef = useRef<AbortController | null>(null);
  const syncCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const previousSyncStatusRef = useRef<{ boardId: string; status: string; startTime?: number; seenInContext?: boolean } | null>(null);

  // Modal state for invoice generation
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [eligibleRecords, setEligibleRecords] = useState<InvoiceGeneratorServiceRecord[]>([]);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [loadingEligible, setLoadingEligible] = useState(false);
  const defaultInvoiceDatesRef = useRef<{ invoiceDate: string; dueDate: string } | null>(null);
  if (!defaultInvoiceDatesRef.current) {
    defaultInvoiceDatesRef.current = getDefaultInvoiceDates();
  }
  const [invoiceDate, setInvoiceDate] = useState<string>(defaultInvoiceDatesRef.current!.invoiceDate);
  const [dueDate, setDueDate] = useState<string>(defaultInvoiceDatesRef.current!.dueDate);
  const [uniqueParticipants, setUniqueParticipants] = useState<string[]>([]);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [generatingPDF, setGeneratingPDF] = useState(false);
  const [generatingXero, setGeneratingXero] = useState(false);
  const [businessTimezone, setBusinessTimezone] = useState<string>("Australia/Sydney");

  const clearAllFilters = useCallback(() => {
    setParticipantFilter("all");
    setScheduledServiceDateRange(undefined);
    setServiceDeliveryDateRange(undefined);
    setTransactionStatusFilter("all");
    setPaymentStatusFilter("all");
    setJobStatusFilter("all");
    setStatusFilter("all");
  }, []);

  const handleBusinessTimezoneLoaded = useCallback((tz: string) => {
    setBusinessTimezone(tz);
    const dates = getDefaultInvoiceDates(tz);
    setInvoiceDate(dates.invoiceDate);
    setDueDate(dates.dueDate);
  }, []);

  useInvoiceGeneratorSetup({
    id,
    boardId,
    boardLabel,
    user,
    workspace,
    setCurrentWorkspaceId,
    onBusinessTimezoneLoaded: handleBusinessTimezoneLoaded,
    setBoardLabel,
  });

  const {
    isLowCatBoard,
    isCareManagementBoard,
    isNdisBoard,
    isNdisCertificationOrVerificationBoard,
  } = getInvoiceGeneratorBoardFlags(boardLabel);

  useInvoiceGeneratorParticipants({ id, boardId, isNdisBoard, setUniqueParticipants });
  useInvoiceGeneratorPaymentOptions({
    id,
    boardId,
    isNdisBoard,
    defaultOptions: NDIS_PAYMENT_STATUS_OPTIONS,
    setNdisPaymentStatusOptions,
  });
  useInvoiceGeneratorServiceRecords({
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
    itemsPerPage: ITEMS_PER_PAGE,
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
  });

  const handleManualRefresh = useCallback(async (silent = false, clearFilters = false) => {
    if (!id || !boardId) {
      if (!silent) {
        showErrorToast('Workspace or board missing', { description: 'Please navigate back and select a workspace again.' });
      }
      return;
    }

    // Clear all filters if requested (e.g., after manual sync)
    if (clearFilters) {
      clearAllFilters();
    }

    // Check sync status from context (no API call needed)
    const currentSync = syncStatuses.find(sync => sync.boardId === boardId);
    const bumpRefresh = () => setRefreshKey(prev => prev + 1);
    const refreshByMode = {
      completed: () => setTimeout(bumpRefresh, 500),
      active: bumpRefresh,
      failed: bumpRefresh,
      default: bumpRefresh,
    };
    const notifyByMode = {
      completed: () => showSuccessToast('Manual sync completed', {
        description: 'The sync job has finished successfully. Reloading service records with latest data...',
      }),
      active: () => showInfoToast('Refreshing data', {
        description: 'Loading the latest cached service records. Sync is in progress - latest changes may appear after sync completes.',
      }),
      failed: () => showErrorToast('Sync job failed', {
        description: 'The last sync job encountered an error. Data refreshed, but you may want to trigger a new sync.',
      }),
      default: () => showInfoToast('Refreshing data', {
        description: 'Loading the latest cached service records...',
      }),
    };

    const mode = getSyncRefreshMode(currentSync);
    if (!silent) notifyByMode[mode]();
    refreshByMode[mode]();
  }, [id, boardId, clearAllFilters, syncStatuses]);

  const stopSyncChecking = useCallback(() => {
    if (syncCheckIntervalRef.current) {
      clearInterval(syncCheckIntervalRef.current);
      syncCheckIntervalRef.current = null;
    }
    previousSyncStatusRef.current = null;
  }, []);

  const checkSyncStatus = useCallback(async () => {
    if (!id || !boardId) return;
    try {
      await pollInvoiceGeneratorSyncStatus({
        workspaceId: id,
        boardId,
        previousSync: previousSyncStatusRef.current,
        axios,
        setSyncStatuses,
        previousSyncStatusRef,
        stopSyncChecking,
        handleManualRefresh,
        showErrorToast,
        showSuccessToast,
      });
    } catch (err) {
      console.error('Error checking sync status:', err);
    }
  }, [id, boardId, handleManualRefresh, stopSyncChecking, setSyncStatuses]);

  useEffect(() => {
    return () => {
      stopSyncChecking();
    };
  }, [stopSyncChecking]);

  // Update "last refreshed" time display every 1 minute
  // This forces a re-render to update the relative time text (e.g., "2 minutes ago" -> "3 minutes ago")
  useEffect(() => {
    const refreshTimeInterval = setInterval(() => {
      // Force a re-render to update formatDistanceToNow display
      // We use a dummy state update to trigger re-render without changing actual data
      setLastSyncedAt(prev => prev ? new Date(prev.getTime()) : null);
    }, 60000); // Update every 1 minute

    return () => {
      clearInterval(refreshTimeInterval);
    };
  }, []);

  useInvoiceGeneratorEligibleRecords({
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
  });

  // Whenever filters change, reset to first page for consistent results
  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, participantFilter, scheduledServiceDateRange, serviceDeliveryDateRange, transactionStatusFilter, paymentStatusFilter, jobStatusFilter, sortBy, sortOrder]);

  const handleHorizontalScroll = useCallback((direction: 'left' | 'right') => {
    if (!tableContainerRef.current) {
      return;
    }
    const offset = direction === 'left' ? -480 : 480;
    tableContainerRef.current.scrollBy({
      left: offset,
      behavior: 'smooth'
    });
  }, []);

  useEffect(() => {
    const container = tableContainerRef.current;
    if (!container) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }

    const updateScrollIndicators = () => {
      setCanScrollLeft(container.scrollLeft > 0);
      setCanScrollRight(container.scrollLeft + container.clientWidth < container.scrollWidth - 1);
    };

    updateScrollIndicators();
    container.addEventListener('scroll', updateScrollIndicators);
    window.addEventListener('resize', updateScrollIndicators);

    return () => {
      container.removeEventListener('scroll', updateScrollIndicators);
      window.removeEventListener('resize', updateScrollIndicators);
    };
  }, [serviceRecords]);

  const formatDate = (dateString: string | null) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '-';
    return date.toLocaleDateString('en-AU', {
      timeZone: businessTimezone,
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: 'AUD'
    }).format(amount || 0);
  };

  const getInvoiceAmount = (record: InvoiceGeneratorServiceRecord) => {
    if (isNdisBoard) return record.totalAmount || 0;
    return isLowCatBoard ? (record.totalAmount || 0) : (record.participantContribution || 0);
  };

  const invoiceLabel = (isLowCatBoard || isNdisBoard) ? 'Tax Invoice' : 'Participant Tax Invoice';

  const formatDisplayDate = (dateString: string | null | undefined) => {
    if (!dateString) return '-';
    const formatted = formatDateDDMMYYYY(dateString, businessTimezone);
    return formatted || '-';
  };

  const stripHtml = (value?: string) => {
    if (!value) return '';
    return value.replace(/<[^>]*>/g, '').trim();
  };

  const handleDownloadPDF = async (fileUrl: string, invoiceNumber?: string) => {
    try {
      if (!fileUrl) {
        if (invoiceNumber) {
          // Fallback to the old method if fileUrl is not available
          await handleDownloadInvoice(invoiceNumber);
        } else {
          showErrorToast('PDF link not available', {
            description: 'The invoice PDF link is not available.'
          });
        }
        return;
      }

      // Download the PDF file directly from fileUrl
      try {
        const pdfResponse = await fetch(fileUrl);
        const pdfBlob = await pdfResponse.blob();
        const pdfObjectUrl = URL.createObjectURL(pdfBlob);
        const link = document.createElement('a');
        link.href = pdfObjectUrl;
        const baseInvoiceNumber = invoiceNumber ? invoiceNumber.replace(/\s*\(ISO\+™\)\s*$/, '').trim() : 'Invoice';
        link.download = `Invoice_${baseInvoiceNumber}.pdf`;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();

        // Clean up
        setTimeout(() => {
          document.body.removeChild(link);
          URL.revokeObjectURL(pdfObjectUrl);
        }, 100);

        showSuccessToast('Invoice downloaded', {
          description: invoiceNumber 
            ? `Invoice ${invoiceNumber} has been downloaded successfully.`
            : 'Invoice has been downloaded successfully.'
        });
      } catch (downloadErr: any) {
        console.error('Error downloading PDF:', downloadErr);
        // Fallback to opening in new tab if download fails
        window.open(fileUrl, '_blank');
        showInfoToast('PDF opened in new tab', {
          description: 'Download failed, opened PDF in new tab instead.'
        });
      }
    } catch (err: any) {
      console.error('Error downloading PDF:', err);
      const errorMessage = err.message || 'Unknown error occurred';
      showErrorToast('Failed to download invoice', { description: errorMessage });
    }
  };

  const handleDownloadInvoice = async (invoiceNumber: string) => {
    try {
      if (!id || !boardId) {
        showErrorToast('Workspace or board missing', { description: 'Please navigate back and select a workspace again.' });
        return;
      }

      // Extract the base invoice number (remove (ISO+™) suffix if present)
      const baseInvoiceNumber = invoiceNumber.replace(/\s*\(ISO\+™\)\s*$/, '');

      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/invoice/${baseInvoiceNumber}/pdf-link`;

      showInfoToast('Fetching invoice...', { description: 'Please wait while we retrieve the invoice PDF.' });

      const response = await axios.get(apiUrl, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      if (response.data?.pdfLink) {
        await handleDownloadPDF(response.data.pdfLink, invoiceNumber);
      } else {
        showErrorToast('PDF link not found', {
          description: 'The invoice PDF link is not available.'
        });
      }
    } catch (err: any) {
      console.error('Error fetching invoice PDF:', err);
      const errorMessage = err.response?.data?.message || err.message || 'Unknown error occurred';
      showErrorToast('Failed to download invoice', { description: errorMessage });
    }
  };

  // Use summary data from backend response (already filtered and aggregated)
  const filteredSummary = {
    totalRecords: summary.totalRecords,
    totalAmount: summary.totalValue,
    totalGovSubsidy: summary.totalGovSubsidy,
    totalParticipantContribution: summary.totalParticipantContribution
  };

  // Pagination
  const totalPages = Math.ceil(summary.totalRecords / ITEMS_PER_PAGE);
  const currentItems = serviceRecords; // Use the paginated data directly from the backend

  const tableColumns = useMemo(
    () => buildInvoiceGeneratorTableColumns({
      isNdisBoard,
      isLowCatBoard,
      ndisStatusFieldLabel,
      formatDisplayDate,
      formatCurrency,
      stripHtml,
      onDownloadPdf: handleDownloadPDF,
    }),
    [isNdisBoard, isLowCatBoard, ndisStatusFieldLabel, businessTimezone, handleDownloadPDF],
  );

  // Export handlers
  const handleExportCSV = async () => {
    try {
      setExportingCSV(true);
      await exportInvoiceGeneratorCsv({
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
        toasts: { showSuccessToast, showErrorToast, showWarningToast },
      });
    } catch (err: any) {
      console.error('Error exporting CSV:', err);
      showErrorToast('CSV export failed', {
        description: getApiErrorMessage(
          err,
          'Unable to export invoice CSV right now. Please try again.',
        ),
      });
    } finally {
      setExportingCSV(false);
    }
  };

  const handleManualSync = async () => {
    if (!isValidRouteIdParam(id) || !isValidRouteIdParam(boardId)) {
      console.error('Invalid parameters for manual sync:', {
        workspaceId: id,
        boardId,
        workspaceIdType: typeof id,
        boardIdType: typeof boardId
      });
      showErrorToast('Workspace or board missing', {
        description: 'Please navigate back and select a workspace and board again. The current URL may be invalid.'
      });
      return;
    }

    try {
      setIsManualSyncing(true);
      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/sync/board/manual`;
      const response = await axios.post(apiUrl, {
        workspaceId: id.trim(),
        boardId: boardId.trim()
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      if (response.data?.success) {
        showSuccessToast('Manual sync queued', {
          description: 'Your job is in the queue and will be processed shortly. Data will refresh automatically when complete. You can track progress in the sync indicator.'
        });

        if (syncCheckIntervalRef.current) {
          clearInterval(syncCheckIntervalRef.current);
          syncCheckIntervalRef.current = null;
        }

        const boardName = getBoardNameFromSession(boardId);

        // Initialize sync status in context immediately
        // This will be updated by sync-status-indicator as it polls the API every 10 seconds
        const initialSyncStatus = {
          boardId: boardId,
          boardName: boardName,
          status: 'started' as const,
          syncType: 'manual_triggered_sync',
          startTime: new Date().toISOString(),
          progress: {
            foldersProcessed: 0,
            totalFolders: 0,
            currentFolder: undefined,
            itemsProcessed: 0
          },
          isManualSync: true
        };

        // Add or update sync status in context
        setSyncStatuses(prev => {
          const existingIndex = prev.findIndex(s => s.boardId === boardId);
          if (existingIndex >= 0) {
            // Update existing - merge with new initial values but preserve any existing progress
            const updated = [...prev];
            updated[existingIndex] = {
              ...initialSyncStatus,
              ...updated[existingIndex],
              status: 'started' as const, // Reset to started when new sync begins
              startTime: new Date().toISOString()
            };
            return updated;
          } else {
            // Add new
            return [...prev, initialSyncStatus];
          }
        });

        previousSyncStatusRef.current = {
          boardId: boardId,
          status: 'started', // Will be updated when sync appears in context
          startTime: Date.now(), // Track when we started monitoring this sync
          seenInContext: false // Track if we've seen this sync in context at least once
        };

        // Start checking sync status every 10 seconds (10000ms) to coordinate with sync-status-indicator
        // Check after 10 seconds to allow sync to start and status to be available
        setTimeout(() => {
          checkSyncStatus();
        }, 10000); // Check after 10 seconds to allow sync to start

        // Then continue checking every 10 seconds
        syncCheckIntervalRef.current = setInterval(() => {
          checkSyncStatus();
        }, 10000); // 10 seconds - synchronized with sync-status-indicator
      } else if (response.data?.alreadyRunning) {
        // Show warning toast when sync is already running
        showWarningToast('Sync already running', {
          description: response.data?.message || 'A manual sync is already in progress. Please wait for it to complete.',
          duration: 5000
        });
      } else {
        showErrorToast('Sync not started', {
          description: response.data?.message || 'Sync could not be started. It may already be in progress.'
        });
      }
    } catch (err: any) {
      console.error('Error triggering manual sync:', err);
      const errorMessage = err.response?.data?.message || err.message || 'Unknown error';
      const statusCode = err.response?.status;

      // Check if the error response indicates sync is already running
      if (err.response?.data?.alreadyRunning) {
        showWarningToast('Sync already running', {
          description: err.response.data?.message || 'A manual sync is already in progress. Please wait for it to complete.',
          duration: 5000
        });
      } else if (statusCode === 404 || errorMessage.toLowerCase().includes('board not found')) {
        // Handle board not found error specifically
        showErrorToast('Board not found', {
          description: 'The board could not be found. Please navigate back and select a valid board, or check if the board ID is correct.',
          duration: 7000
        });
      } else if (statusCode === 400) {
        // Handle validation errors
        showErrorToast('Invalid request', {
          description: errorMessage || 'Please check that workspace and board IDs are valid.',
          duration: 7000
        });
      } else {
        showErrorToast('Failed to trigger manual sync', {
          description: errorMessage
        });
      }
    } finally {
      setIsManualSyncing(false);
    }
  };

  // Open modal for participant tax invoice
  const handleOpenInvoiceModal = () => {
    setSelectedItems(new Set()); // Reset selected items
    // Set default dates
    const { invoiceDate: defaultInvoiceDate, dueDate: defaultDueDate } = getDefaultInvoiceDates(businessTimezone);
    setInvoiceDate(defaultInvoiceDate);
    setDueDate(defaultDueDate);
    setShowInvoiceModal(true);
    // Don't show toast here - fetchEligibleRecords will show appropriate toasts
  };

  // Toggle item selection
  const handleToggleItem = (itemId: string) => {
    const newSelected = new Set(selectedItems);
    if (newSelected.has(itemId)) {
      newSelected.delete(itemId);
    } else {
      newSelected.add(itemId);
    }
    setSelectedItems(newSelected);
  };

  // Select/Deselect all items
  const handleSelectAll = () => {
    if (selectedItems.size === eligibleRecords.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(eligibleRecords.map(r => r.id)));
    }
  };

  // Generate PDF invoice from modal
  const handleGeneratePDFInvoice = async () => {
    try {
      const validationError = validateInvoiceGenerationInputs(selectedItems.size, invoiceDate, dueDate);
      if (validationError) {
        showErrorToast(validationError);
        return;
      }

      const selectedRecords = eligibleRecords.filter(record => selectedItems.has(record.id));
      if (!selectedRecords.length) {
        showErrorToast('No items selected for invoice generation.');
        return;
      }

      const participantName = selectedRecords[0]?.participant || '';

      setGeneratingPDF(true);
      isGeneratingInvoiceRef.current = true;

      const apiUrl = isNdisBoard
        ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/pdf/${id}/${boardId}/invoicendis-invoice-generator`
        : `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/pdf/${id}/${boardId}/invoiceparticipanttax`;

      const itemIds = buildInvoiceItemIds(selectedRecords, isNdisBoard);

      const payload = {
        itemIds: itemIds,
        items: selectedRecords, // Keep items for backward compatibility
        participantName: participantName,
        invoiceDate: invoiceDate,
        dueDate: dueDate,
        isLowCat: isLowCatBoard // Pass Low-Cat flag to backend
      };

      const resp = await axios.post(apiUrl, payload, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
      });

      if (resp.status === 200 && resp.data) {
        await finalizePdfInvoiceGeneration({
          respData: resp.data,
          isNdisBoard,
          id,
          boardId,
          selectedItems,
          participantName,
          invoiceLabel,
          fileUrl: resp.data.fileUrl,
          itemCount: resp.data.itemCount,
          axios,
          showErrorToast,
          showInfoToast,
          showSuccessToast,
          setShowInvoiceModal,
          handleManualRefresh,
          isGeneratingInvoiceRef,
        });
      } else {
        isGeneratingInvoiceRef.current = false;
        showErrorToast('Unexpected response while generating invoice');
      }
    } catch (err: any) {
      console.error('Error generating participant invoice', err);
      isGeneratingInvoiceRef.current = false;
      const errorMessage = err.response?.data?.message || err.message || 'Unknown error occurred';
      showErrorToast('Failed to generate invoice', { description: errorMessage });
    } finally {
      setGeneratingPDF(false);
    }
  };

  // Generate Xero invoice from modal
  const handleGenerateXeroInvoice = async () => {
    await generateXeroInvoiceFromModal({
      selectedItems,
      invoiceDate,
      dueDate,
      eligibleRecords,
      isNdisBoard,
      isLowCatBoard,
      id,
      boardId,
      invoiceLabel,
      axios,
      showErrorToast,
      showInfoToast,
      showSuccessToast,
      setShowInvoiceModal,
      handleManualRefresh,
      isGeneratingInvoiceRef,
      setGeneratingXero,
      validateInvoiceGenerationInputs,
      buildInvoiceItemIds,
    });
  };

  const viewProps = {
    router, id, boardId,
    isNdisBoard, isLowCatBoard, isNdisCertificationOrVerificationBoard,
    handleManualSync, isManualSyncing, syncStatuses, showHelpDialog, setShowHelpDialog,
    handleExportCSV, exportingCSV, handleOpenInvoiceModal, invoiceLabel,
    lastSyncedAt, participantFilter, setParticipantFilter, uniqueParticipants,
    scheduledServiceDateRange, setScheduledServiceDateRange,
    serviceDeliveryDateRange, setServiceDeliveryDateRange,
    transactionStatusFilter, setTransactionStatusFilter,
    paymentStatusFilter, setPaymentStatusFilter,
    ndisPaymentStatusOptions, jobStatusFilter, setJobStatusFilter,
    ndisStatusFieldLabel, statusFilter, setStatusFilter,
    sortBy, setSortBy, sortOrder, setSortOrder, clearAllFilters,
    loading, error, filteredSummary, formatCurrency, getInvoiceAmount, formatDate,
    tableContainerRef, canScrollLeft, canScrollRight, handleHorizontalScroll,
    tableColumns, currentItems, totalPages, currentPage, setCurrentPage,
    showInvoiceModal, setShowInvoiceModal, eligibleRecords, setEligibleRecords, selectedItems, setSelectedItems,
    loadingEligible, handleSelectAll, handleToggleItem, invoiceDate, setInvoiceDate,
    dueDate, setDueDate, generatingPDF, generatingXero, handleGeneratePDFInvoice,
    handleGenerateXeroInvoice, isCareManagementBoard, PAYMENT_STATUS_FILTERS,
  };

  return <InvoiceGeneratorPageView {...viewProps} />;
}
