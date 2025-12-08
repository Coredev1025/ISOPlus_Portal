"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, FileText, Search, Calendar, Filter, CheckCircle, DollarSign, BarChart3, FileSpreadsheet, Receipt, X, RefreshCcw, Percent, ArrowLeftCircle, ArrowRightCircle, Download, Clock, ArrowUpDown, ArrowUp, ArrowDown, HelpCircle } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useState, useEffect, useCallback, useRef, ReactNode } from "react";
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
import { showSuccessToast, showErrorToast, showInfoToast } from "@/lib/toast-utils";
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

const TRANSACTION_STATUS_FILTERS = [
  { value: "all", label: "All Transaction Status", isoValue: "" },
  { value: "delivered", label: "Delivered - To be claimed and invoiced.", description: "To be claimed and invoiced.", isoValue: "Delivered - To be claimed and invoiced." },
  { value: "cancelled", label: "Cancelled - To be claimed and invoiced if applicable.", description: "To be claimed and invoiced if applicable.", isoValue: "Cancelled - To be claimed and invoiced if applicable." },
  { value: "adjustment-refund", label: "Adjustment (Refund) - To be claimed and invoiced.", description: "To be claimed and invoiced.", isoValue: "Adjustment (Refund) - To be claimed and invoiced." },
  { value: "adjustment-charge", label: "Adjustment (Charge) - To be claimed and invoiced.", description: "To be claimed and invoiced.", isoValue: "Adjustment (Charge) - To be claimed and invoiced." }
];

const PAYMENT_STATUS_FILTERS = [
  { value: "all", label: "All Payment Status" },
  { value: "Gov Claim Submitted", label: "Gov Claim Submitted" },
  { value: "Gov Claim Paid", label: "Gov Claim Paid" },
  { value: "Participant Invoiced", label: "Participant Invoiced" },
  { value: "Participant Paid", label: "Participant Paid" }
];

const FUNDING_SOURCE_CODE_MAP: Record<string, string> = {
  "Home Support(HS) Quarterly": "ON",
  "Home Support Care Management": "CM",
  "Restorative Care Pathway": "RC",
  "Assistive Technology - Short-term": "AT",
  "End-of-Life Pathway": "EL",
  "Assistive Technology": "AT",
  "Assistive Technology - Ongoing": "AS",
  "Home Modification": "HM",
  "Primary Supplements": "PS",
  "Unspent Home Care Package (HCP) Funds": "HCP"
};

interface ServiceRecord {
  id: string;
  status: "invoiced" | "pending";
  participant: string;
  scheduledStart: string | null;
  scheduledServiceDate?: string | null;
  serviceDeliveryDate?: string | null;
  unit: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  govSubsidy: number;
  participantContribution: number;
  notes: string;
  service: string;
  invoiceNumber?: string;
  transactionStatus?: string;
  paymentStatus?: string;
  fundingSource?: string;
  fileUrl?: string;
  itemFirstPayment?: boolean | string;
  // CSV export fields
  careRecipientIdentifier?: string;
  serviceIdentifier?: string;
  deliveredBy?: string;
  itemOrWraparound?: string;
  itemDescriptionCode?: string;
  itemDescription?: string;
  wraparoundDescription?: string;
  wraparoundDescriptionCode?: string;
  prescribedItem?: boolean | string;
  itemPurchasedMethod?: string;
  associatedProvider?: string;
  associatedProviderInvoiceNo?: string;
  loanedByOrganisationName?: string;
  loanedByInvoiceNumber?: string;
  healthProfessionalTypeCode?: string;
  healthProfessionalTypeOther?: string;
  deliveredByThirdParty?: string;
}

interface InvoiceSummary {
  totalRecords: number;
  invoiced: number;
  pending: number;
  totalValue: number;
  totalGovSubsidy: number;
  totalParticipantContribution: number;
}

type TableColumn = {
  key: string;
  label: string;
  className?: string;
  render: (record: ServiceRecord) => ReactNode;
};

export default function InvoiceGenerator() {
  const router = useRouter();
  const pathname = usePathname();
  const id = pathname.split('/')[2];
  const boardId = pathname.split('/')[4];

  const [serviceRecords, setServiceRecords] = useState<ServiceRecord[]>([]);
  const [summary, setSummary] = useState<InvoiceSummary>({
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

  // Modal state for invoice generation
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [eligibleRecords, setEligibleRecords] = useState<ServiceRecord[]>([]);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [loadingEligible, setLoadingEligible] = useState(false);
  const [invoiceDate, setInvoiceDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [dueDate, setDueDate] = useState<string>(() => {
    const date = new Date();
    date.setDate(date.getDate() + 14);
    return date.toISOString().split('T')[0];
  });
  const [uniqueParticipants, setUniqueParticipants] = useState<string[]>([]);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [generatingPDF, setGeneratingPDF] = useState(false);
  const [generatingXero, setGeneratingXero] = useState(false);

  const handleManualRefresh = useCallback(async (silent = false) => {
    if (!id || !boardId) {
      if (!silent) {
        showErrorToast('Workspace or board missing', { description: 'Please navigate back and select a workspace again.' });
      }
      return;
    }

    try {
      // Check sync status first
      const statusUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/sync/board/status/${boardId}`;
      const statusResponse = await axios.get(statusUrl, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      const syncStatus = statusResponse.data;
      const jobState = syncStatus?.jobStatus?.state;
      const syncStatusValue = syncStatus?.syncStatus;
      const finishedOn = syncStatus?.jobStatus?.finishedOn;

      // Check if a manual sync was just completed
      // A completed job with finishedOn timestamp indicates the sync just finished
      const isSyncCompleted = jobState === 'completed' && finishedOn;
      // Valid sync statuses (not failed or stopped)
      const isValidSyncStatus = syncStatusValue &&
        !['failed', 'sync_stopped', 'sync_cancelled', 'board_invalid'].includes(syncStatusValue);

      if (isSyncCompleted && isValidSyncStatus) {
        if (!silent) {
          showSuccessToast('Manual sync completed', {
            description: 'The sync job has finished successfully. Reloading service records with latest data...'
          });
        }
        // Reload data after a short delay to ensure backend has updated
        setTimeout(() => {
          setRefreshKey(prev => prev + 1);
        }, 500);
      } else if (jobState === 'active' || jobState === 'waiting') {
        if (!silent) {
          showInfoToast('Sync in progress', {
            description: 'A sync job is currently running. Data will be refreshed, but may not include the latest changes yet.'
          });
        }
        // Still refresh data, but let user know sync is in progress
        setRefreshKey(prev => prev + 1);
      } else if (jobState === 'failed') {
        if (!silent) {
          showErrorToast('Sync job failed', {
            description: 'The last sync job encountered an error. Data refreshed, but you may want to trigger a new sync.'
          });
        }
        // Still refresh data
        setRefreshKey(prev => prev + 1);
      } else {
        // No active sync job or sync is in normal state
        if (!silent) {
          showInfoToast('Refreshing data', {
            description: 'Loading the latest cached service records...'
          });
        }
        setRefreshKey(prev => prev + 1);
      }
    } catch (err: any) {
      // If status check fails, still refresh data but show warning
      console.error('Error checking sync status:', err);
      if (!silent) {
        showInfoToast('Refreshing data', {
          description: 'Unable to check sync status. Loading cached service records...'
        });
      }
      setRefreshKey(prev => prev + 1);
    }
  }, [id, boardId]);

  // Fetch unique participants for the modal dropdown using dedicated endpoint
  useEffect(() => {
    const fetchParticipants = async () => {
      try {
        const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/invoice-generator/participants`;

        const response = await axios.get(apiUrl, {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
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
  }, [id, boardId]);

  // Fetch eligible records when modal opens - use current filters
  useEffect(() => {
    const fetchEligibleRecords = async () => {
      if (!showInvoiceModal) {
        setEligibleRecords([]);
        return;
      }

      // Cancel previous request if it exists
      if (eligibleRecordsAbortControllerRef.current) {
        eligibleRecordsAbortControllerRef.current.abort();
      }

      // Create new AbortController for this request
      const abortController = new AbortController();
      eligibleRecordsAbortControllerRef.current = abortController;

      setLoadingEligible(true);
      try {
        const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/invoice-generator`;
        const params = new URLSearchParams();

        // Use current filters from main page - fetch ALL records (including invoiced)
        params.append('status', 'all'); // Get all records, not just pending

        if (participantFilter && participantFilter !== 'all') {
          params.append('participant', participantFilter);
        }

        if (scheduledServiceDateRange?.from) {
          const from = new Date(scheduledServiceDateRange.from);
          from.setHours(0, 0, 0, 0);
          params.append('startDate', from.toISOString());
        }
        if (scheduledServiceDateRange?.to || scheduledServiceDateRange?.from) {
          const toSource = scheduledServiceDateRange?.to || scheduledServiceDateRange?.from;
          const to = new Date(toSource as Date);
          to.setHours(23, 59, 59, 999);
          params.append('endDate', to.toISOString());
        }

        if (serviceDeliveryDateRange?.from) {
          const from = new Date(serviceDeliveryDateRange.from);
          from.setHours(0, 0, 0, 0);
          params.append('serviceDeliveryStart', from.toISOString());
        }
        if (serviceDeliveryDateRange?.to || serviceDeliveryDateRange?.from) {
          const toSource = serviceDeliveryDateRange?.to || serviceDeliveryDateRange?.from;
          const to = new Date(toSource as Date);
          to.setHours(23, 59, 59, 999);
          params.append('serviceDeliveryEnd', to.toISOString());
        }

        const transactionStatusParam = getTransactionStatusSearchValue(transactionStatusFilter);
        if (transactionStatusParam) {
          params.append('transactionStatus', transactionStatusParam);
        }

        if (paymentStatusFilter !== 'all') {
          params.append('paymentStatus', paymentStatusFilter);
        }

        params.append('sortBy', sortBy);
        params.append('sortOrder', sortOrder);

        // Use reasonable limit for eligible records (max 1000 to prevent memory issues)
        // If more records exist, user can use filters to narrow down
        params.append('page', '1');
        params.append('limit', '1000');

        const response = await axios.get(apiUrl, {
          params: Object.fromEntries(params),
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          signal: abortController.signal
        });

        if (response.data?.items) {
          const items = response.data.items;
          const total = response.data.total || 0;

          setEligibleRecords(items);
          // Auto-select all eligible records by default (including invoiced ones)
          setSelectedItems(new Set(items.map((r: ServiceRecord) => r.id)));

          // Only show toasts if not generating invoice (to avoid duplicate/empty toasts)
          if (!isGeneratingInvoiceRef.current) {
            if (items.length > 0) {
              if (total > items.length) {
                showInfoToast(`Loaded ${items.length} of ${total} eligible records`, {
                  description: 'Showing first 1000 records. Use filters to narrow down if needed.'
                });
              } else {
                showInfoToast(`Loaded ${items.length} eligible record${items.length === 1 ? '' : 's'}`, {
                  description: 'All records (including invoiced) are shown. You can select which ones to include in the invoice.'
                });
              }
            }
          }
        } else {
          // Only show toast if not generating invoice
          if (!isGeneratingInvoiceRef.current) {
            showInfoToast('No eligible records found', {
              description: 'No records match your current filters.'
            });
          }
        }
      } catch (err: any) {
        // Don't handle errors for cancelled requests
        if (err.name === 'AbortError' || err.code === 'ERR_CANCELED') {
          return;
        }
        console.error('Error fetching eligible records:', err);
        // Only show error toast if not generating invoice
        if (!isGeneratingInvoiceRef.current) {
          showErrorToast('Failed to fetch eligible records', { description: err instanceof Error ? err.message : 'Unknown error' });
        }
        setEligibleRecords([]);
      } finally {
        // Only update loading state if this request wasn't cancelled
        if (!abortController.signal.aborted) {
          setLoadingEligible(false);
        }
      }
    };

    fetchEligibleRecords();

    // Cleanup: abort request when component unmounts or dependencies change
    return () => {
      if (eligibleRecordsAbortControllerRef.current) {
        eligibleRecordsAbortControllerRef.current.abort();
      }
    };
  }, [showInvoiceModal, id, boardId, participantFilter, scheduledServiceDateRange, serviceDeliveryDateRange, transactionStatusFilter, paymentStatusFilter, sortBy, sortOrder, refreshKey]);

  useEffect(() => {
    const fetchData = async () => {
      // Cancel previous request if it exists
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Create new AbortController for this request
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      setLoading(true);
      setError(null);
      try {
        const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/invoice-generator`;

        // Build query parameters
        const params = new URLSearchParams();

        // Status filter
        if (statusFilter !== 'all') {
          params.append('status', statusFilter);
        }

        // Participant name filter
        if (participantFilter && participantFilter !== 'all') {
          params.append('participant', participantFilter);
        }

        const transactionStatusParam = getTransactionStatusSearchValue(transactionStatusFilter);
        if (transactionStatusParam) {
          params.append('transactionStatus', transactionStatusParam);
        }

        if (paymentStatusFilter !== 'all') {
          params.append('paymentStatus', paymentStatusFilter);
        }

        // Date range filter for scheduled service dates
        if (scheduledServiceDateRange?.from) {
          const from = new Date(scheduledServiceDateRange.from);
          from.setHours(0, 0, 0, 0); // start of day local
          params.append('startDate', from.toISOString());
        }
        if (scheduledServiceDateRange?.to || scheduledServiceDateRange?.from) {
          // If only one date picked, use same day end-of-day
          const toSource = scheduledServiceDateRange?.to || scheduledServiceDateRange?.from;
          const to = new Date(toSource as Date);
          to.setHours(23, 59, 59, 999); // end of day local
          params.append('endDate', to.toISOString());
        }

        if (serviceDeliveryDateRange?.from) {
          const from = new Date(serviceDeliveryDateRange.from);
          from.setHours(0, 0, 0, 0);
          params.append('serviceDeliveryStart', from.toISOString());
        }
        if (serviceDeliveryDateRange?.to || serviceDeliveryDateRange?.from) {
          const toSource = serviceDeliveryDateRange?.to || serviceDeliveryDateRange?.from;
          const to = new Date(toSource as Date);
          to.setHours(23, 59, 59, 999);
          params.append('serviceDeliveryEnd', to.toISOString());
        }

        params.append('sortBy', sortBy);
        params.append('sortOrder', sortOrder);

        // Pagination
        params.append('page', currentPage.toString());
        params.append('limit', ITEMS_PER_PAGE.toString());

        // Fetch items from the backend
        const response = await axios.get(apiUrl, {
          params: Object.fromEntries(params),
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          signal: abortController.signal
        });

        // Validate response format
        if (!response.data || typeof response.data !== 'object') {
          throw new Error('Invalid data format received from server');
        }

        // Extract data and metadata from response
        const {
          items = [],
          total = 0,
          invoiced = 0,
          pending = 0,
          totalAmount = 0,
          totalGovSubsidy = 0,
          totalParticipantContribution = 0
        } = response.data;

        if (!Array.isArray(items)) {
          throw new Error('Invalid items format received from server');
        }

        // No need to transform since backend now sends formatted data
        const transformedRecords: ServiceRecord[] = items;

        setServiceRecords(transformedRecords);

        // Use summary data from API response
        setSummary({
          totalRecords: total,
          invoiced: invoiced,
          pending: pending,
          totalValue: totalAmount,
          totalGovSubsidy: totalGovSubsidy,
          totalParticipantContribution: totalParticipantContribution
        });
        setLastSyncedAt(new Date());
      } catch (err: any) {
        // Don't handle errors for cancelled requests
        if (err.name === 'AbortError' || err.code === 'ERR_CANCELED') {
          return;
        }
        const errorMessage = err.response?.data?.message || err.message || 'An error occurred while fetching data';
        setError(errorMessage);
        console.error("Error fetching invoice data:", err);
      } finally {
        // Only update loading state if this request wasn't cancelled
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    };

    if (id && boardId) {
      fetchData();
    }

    // Cleanup: abort request when component unmounts or dependencies change
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [
    id,
    boardId,
    statusFilter,
    participantFilter,
    scheduledServiceDateRange,
    serviceDeliveryDateRange,
    transactionStatusFilter,
    paymentStatusFilter,
    sortBy,
    sortOrder,
    currentPage,
    ITEMS_PER_PAGE,
    refreshKey
  ]);

  // Whenever filters change, reset to first page for consistent results
  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, participantFilter, scheduledServiceDateRange, serviceDeliveryDateRange, transactionStatusFilter, paymentStatusFilter, sortBy, sortOrder]);

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
    return date.toLocaleDateString('en-AU', {
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

  const formatDisplayDate = (dateString: string | null | undefined) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleDateString('en-AU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  };

  const stripHtml = (value?: string) => {
    if (!value) return '';
    return value.replace(/<[^>]*>/g, '').trim();
  };

  const getDeliveredByThirdParty = (deliveredBy?: string) => {
    if (!deliveredBy) return '';
    const value = deliveredBy.toLowerCase();
    if (value.includes('associated providers')) {
      return 'True';
    }
    if (value.includes('company workforce')) {
      return 'False';
    }
    return '';
  };

  const getItemOrWraparound = (record: ServiceRecord) => {
    if (record.unit && record.unit.toLowerCase() === 'item') {
      return 'Item';
    }
    if (record.service && record.service.toLowerCase().includes('wraparound')) {
      return 'Wraparound';
    }
    // Fallback to itemOrWraparound if directly provided
    if (record.itemOrWraparound) {
      return record.itemOrWraparound;
    }
    return '';
  };

  const getFundingSourceCode = (fundingSource?: string) => {
    if (!fundingSource) {
      return '';
    }

    const fundingSourceLower = fundingSource.toLowerCase();

    // Check for exact matches first (case-insensitive)
    for (const [key, code] of Object.entries(FUNDING_SOURCE_CODE_MAP)) {
      if (fundingSourceLower.includes(key.toLowerCase())) {
        return code;
      }
    }

    // Special handling for Primary Supplements and HCP
    if (fundingSourceLower.includes('primary supplement')) {
      return 'PS';
    }
    if (fundingSourceLower.includes('unspent home care package') ||
      fundingSourceLower.includes('hcp fund') ||
      fundingSourceLower.includes('home care package')) {
      return 'HCP';
    }

    // Fallback: return first 4 characters uppercase if no match found
    return fundingSource.substring(0, 4).toUpperCase();
  };

  const getTransactionStatusSearchValue = (filterValue: string) => {
    return TRANSACTION_STATUS_FILTERS.find(option => option.value === filterValue)?.isoValue || '';
  };

  const getPurchasedMethodType = (value?: string) => {
    if (!value) return '';
    const methodLower = value.toLowerCase();
    if (methodLower.includes('loan')) return 'LOANED';
    if (methodLower.includes('purchase')) return 'PURCHASED';
    return '';
  };

  const getItemFirstPaymentDisplay = (value?: string | boolean) => {
    if (typeof value === 'boolean') {
      return value ? 'Y' : 'N';
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['y', 'yes', 'true'].includes(normalized)) {
        return 'Y';
      }
      if (['n', 'no', 'false'].includes(normalized)) {
        return 'N';
      }
      return value.toUpperCase();
    }
    return 'N';
  };

  const formatDateForCsv = (dateString: string | null | undefined) => {
    if (!dateString) {
      return '';
    }
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toISOString().split('T')[0];
  };

  const formatNumberForCsv = (value: number | string | undefined | null) => {
    if (value === null || value === undefined || value === '') {
      return '';
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(numeric)) {
      return '';
    }
    return numeric.toFixed(2);
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

  const tableColumns: TableColumn[] = [
    {
      key: 'paymentStatus',
      label: 'Payment Status',
      className: 'min-w-[180px]',
      render: (record) => record.paymentStatus || '-'
    },
    {
      key: 'participant',
      label: 'Participant',
      className: 'min-w-[200px]',
      render: (record) => record.participant || '-'
    },
    {
      key: 'service',
      label: 'Service',
      className: 'min-w-[220px]',
      render: (record) => record.service || '-'
    },
    {
      key: 'scheduledServiceDate',
      label: 'Scheduled Service Date',
      className: 'min-w-[220px]',
      render: (record) => formatDisplayDate(record.scheduledServiceDate || record.scheduledStart)
    },
    {
      key: 'serviceDeliveryDate',
      label: 'Service Delivery Date',
      className: 'min-w-[220px]',
      render: (record) => formatDisplayDate(record.serviceDeliveryDate)
    },
    {
      key: 'transactionStatus',
      label: 'Transaction Status',
      className: 'min-w-[220px]',
      render: (record) => record.transactionStatus || '-'
    },
    {
      key: 'unit',
      label: 'Unit',
      className: 'min-w-[140px]',
      render: (record) => record.unit || '-'
    },
    {
      key: 'quantity',
      label: 'Quantity',
      className: 'min-w-[120px]',
      render: (record) => (typeof record.quantity === 'number' ? record.quantity : record.quantity ?? '-')
    },
    {
      key: 'unitPrice',
      label: 'Unit Price ($)',
      className: 'min-w-[150px]',
      render: (record) => formatCurrency(record.unitPrice)
    },
    {
      key: 'totalAmount',
      label: 'Total Amount',
      className: 'min-w-[150px]',
      render: (record) => formatCurrency(record.totalAmount)
    },
    {
      key: 'govSubsidy',
      label: 'Gov Subsidy',
      className: 'min-w-[150px]',
      render: (record) => formatCurrency(record.govSubsidy)
    },
    {
      key: 'participantContribution',
      label: 'Participant Contribution',
      className: 'min-w-[190px]',
      render: (record) => formatCurrency(record.participantContribution)
    },
    {
      key: 'fundingSource',
      label: 'Funding Source',
      className: 'min-w-[200px]',
      render: (record) => record.fundingSource || '-'
    },
    {
      key: 'notes',
      label: 'Notes',
      className: 'min-w-[220px]',
      render: (record) => {
        const cleanNotes = stripHtml(record.notes);
        return cleanNotes ? (
          <span title={cleanNotes} className="block max-h-12 overflow-hidden text-sm text-muted-foreground">
            {cleanNotes}
          </span>
        ) : '-';
      }
    }
  ];

  // Export handlers
  const handleExportCSV = async () => {
    try {
      setExportingCSV(true);

      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/invoice-generator`;
      const params = new URLSearchParams();

      if (statusFilter !== 'all') {
        params.append('status', statusFilter);
      }
      if (participantFilter && participantFilter !== 'all') {
        params.append('participant', participantFilter);
      }
      if (scheduledServiceDateRange?.from) {
        const from = new Date(scheduledServiceDateRange.from);
        from.setHours(0, 0, 0, 0);
        params.append('startDate', from.toISOString());
      }
      if (scheduledServiceDateRange?.to) {
        const to = new Date(scheduledServiceDateRange.to);
        to.setHours(23, 59, 59, 999);
        params.append('endDate', to.toISOString());
      }

      if (serviceDeliveryDateRange?.from) {
        const from = new Date(serviceDeliveryDateRange.from);
        from.setHours(0, 0, 0, 0);
        params.append('serviceDeliveryStart', from.toISOString());
      }
      if (serviceDeliveryDateRange?.to) {
        const to = new Date(serviceDeliveryDateRange.to);
        to.setHours(23, 59, 59, 999);
        params.append('serviceDeliveryEnd', to.toISOString());
      }

      const transactionStatusParam = getTransactionStatusSearchValue(transactionStatusFilter);
      if (transactionStatusParam) {
        params.append('transactionStatus', transactionStatusParam);
      }

      if (paymentStatusFilter !== 'all') {
        params.append('paymentStatus', paymentStatusFilter);
      }

      params.append('sortBy', sortBy);
      params.append('sortOrder', sortOrder);

      params.append('folderName', 'Master Plan,Shift Planning and Reporting');

      // For CSV export, fetch in batches to avoid memory issues
      // Start with first batch to check total count
      params.append('page', '1');
      params.append('limit', '1000'); // Reasonable batch size

      const response = await axios.get(apiUrl, {
        params: Object.fromEntries(params),
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      const allItems: ServiceRecord[] = response.data?.items || [];

      if (allItems.length === 0) {
        showErrorToast('No records to export.');
        setExportingCSV(false);
        return;
      }

      const escapeForCsv = (value: unknown) => {
        if (value === null || value === undefined || value === '') {
          return '';
        }
        const stringValue = String(value).replace(/"/g, '""');
        return `"${stringValue}"`;
      };

      const csvHeaders = [
        'Item External Reference Identifier',
        'Care Recipient Identifier',
        'Service Identifier',
        'Delivery Date',
        'Unit Type',
        'Quantity',
        'Price Per Unit',
        'Funding Source',
        'Delivered By Third Party',
        'Item or Wraparound',
        'Item Description Code',
        'Item Description',
        'Wraparound Description Code',
        'Wraparound Description',
        'Prescribed Item',
        'Purchased Method Type',
        'Loaned by Organisation Name',
        'Loaned By Invoice Number',
        'Health Professional Type Code',
        'Health Professional Type Other',
        'Item First Payment'
      ];

      // Add CSV headers
      const csvRows: string[] = [csvHeaders.join(',')];

      // Get or initialize CSV export count from localStorage
      const STORAGE_KEY = 'csv_export_count';
      const currentExportCount = parseInt(localStorage.getItem(STORAGE_KEY) || '0', 10);
      const newExportCount = currentExportCount + 1;
      localStorage.setItem(STORAGE_KEY, newExportCount.toString().padStart(3, '0'));

      allItems.forEach((item) => {
        const invoiceNumber = item.invoiceNumber || '';
        const careRecipientIdentifier = item.careRecipientIdentifier || '';
        let serviceIdentifier = item.serviceIdentifier || '';
        if (serviceIdentifier.includes('/')) {
          serviceIdentifier = serviceIdentifier.split('/')[0].trim();
        }

        // Delivered By Third Party: Check if it's 'True' or 'False', default to empty if not set
        let deliveredByThirdParty = '';
        if (item.deliveredByThirdParty === 'True') {
          deliveredByThirdParty = 'True';
        } else if (item.deliveredByThirdParty === 'False') {
          deliveredByThirdParty = 'False';
        }

        const itemOrWraparound = item.itemOrWraparound || '';

        // Item Description Code and Item Description only for 'Item' type
        const itemDescriptionCode = (itemOrWraparound === 'Item' && item.itemDescriptionCode) ? item.itemDescriptionCode : '';
        const itemDescription = (itemOrWraparound === 'Item' && item.itemDescription) ? item.itemDescription : '';

        // Wraparound Description Code and Wraparound Description only for 'Wraparound' type
        const wraparoundDescriptionCode = (itemOrWraparound === 'Wraparound' && item.wraparoundDescriptionCode) ? item.wraparoundDescriptionCode : '';
        const wraparoundDescription = (itemOrWraparound === 'Wraparound' && item.wraparoundDescription) ? item.wraparoundDescription : '';

        const prescribedItem = item.prescribedItem || 'N';

        // Purchased Method Type should be empty if itemPurchasedMethod is undefined/null/empty
        const purchasedMethodType = item.itemPurchasedMethod || '';
        // Use loanedByOrganisationName and loanedByInvoiceNumber from backend (already set based on LOANED status)
        const loanedByOrganisationName = purchasedMethodType === 'LOANED' ? (item.loanedByOrganisationName || '') : '';
        const loanedByInvoiceNumber = purchasedMethodType === 'LOANED' ? (item.loanedByInvoiceNumber || '') : '';

        // Health Professional Type Code and Other - include for all items (backend sets these when available)
        const healthProfessionalTypeCode = item.healthProfessionalTypeCode || '';
        const healthProfessionalTypeOther = item.healthProfessionalTypeOther || '';

        const serviceDeliveryDateCsv = formatDateForCsv(item.serviceDeliveryDate);
        // Get funding source code - convert from name to code
        const fundingSourceCode = getFundingSourceCode(item.fundingSource);
        const itemFirstPayment = item.itemFirstPayment || 'False';

        csvRows.push(
          [
            escapeForCsv(invoiceNumber),
            escapeForCsv(careRecipientIdentifier),
            escapeForCsv(serviceIdentifier),
            escapeForCsv(serviceDeliveryDateCsv),
            escapeForCsv(item.unit || ''),
            escapeForCsv(item.quantity ?? ''),
            escapeForCsv(formatNumberForCsv(item.unitPrice)),
            escapeForCsv(fundingSourceCode || ''),
            escapeForCsv(deliveredByThirdParty),
            escapeForCsv(itemOrWraparound),
            escapeForCsv(itemDescriptionCode),
            escapeForCsv(itemDescription),
            escapeForCsv(wraparoundDescriptionCode),
            escapeForCsv(wraparoundDescription),
            escapeForCsv(prescribedItem),
            escapeForCsv(purchasedMethodType),
            escapeForCsv(loanedByOrganisationName),
            escapeForCsv(loanedByInvoiceNumber),
            escapeForCsv(healthProfessionalTypeCode),
            escapeForCsv(healthProfessionalTypeOther),
            escapeForCsv(itemFirstPayment)
          ].join(',')
        );
      });

      const csvContent = csvRows.join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      const fileName = `Ext-Invoice-Item-${newExportCount.toString().padStart(3, '0')}.csv`;

      link.href = url;
      link.download = fileName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();

      // Clean up
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, 100);

      setExportingCSV(false);
      showSuccessToast(`Successfully exported ${allItems.length} records to CSV.`);
    } catch (err: any) {
      console.error('Error exporting CSV:', err);
      showErrorToast('Failed to export CSV', { description: err.message });
      setExportingCSV(false);
    }
  };

  const handleManualSync = async () => {
    if (!id || !boardId) {
      showErrorToast('Workspace or board missing', { description: 'Please navigate back and select a workspace again.' });
      return;
    }

    try {
      setIsManualSyncing(true);
      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/sync/board/manual`;
      const response = await axios.post(apiUrl, { workspaceId: id, boardId }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      if (response.data?.success) {
        const description = response.data?.message || 'Manual sync triggered successfully.';
        showSuccessToast('Manual sync queued', {
          description: `${description} The sync job has been added to the queue and will start processing shortly. Refreshing data...`
        });

        // Automatically refresh data after a short delay to allow sync job to be queued
        // Use silent mode to avoid duplicate toast (we already showed "Manual sync queued" toast)
        setTimeout(() => {
          handleManualRefresh(true);
        }, 2000);
      } else {
        showErrorToast('Sync not started', {
          description: response.data?.message || 'Sync could not be started. It may already be in progress.'
        });
      }
    } catch (err: any) {
      console.error('Error triggering manual sync:', err);
      const errorMessage = err.response?.data?.message || err.message || 'Unknown error';
      showErrorToast('Failed to trigger manual sync', {
        description: errorMessage
      });
    } finally {
      setIsManualSyncing(false);
    }
  };

  // Open modal for participant tax invoice
  const handleOpenInvoiceModal = () => {
    setSelectedItems(new Set()); // Reset selected items
    // Set default dates
    setInvoiceDate(new Date().toISOString().split('T')[0]);
    const due = new Date();
    due.setDate(due.getDate() + 14);
    setDueDate(due.toISOString().split('T')[0]);
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
      if (!selectedItems.size) {
        showErrorToast('Please select at least one item to include in the invoice.');
        return;
      }

      if (!invoiceDate) {
        showErrorToast('Please enter an invoice date.');
        return;
      }

      if (!dueDate) {
        showErrorToast('Please enter a due date.');
        return;
      }

      // Filter to only selected items
      const selectedRecords = eligibleRecords.filter(record => selectedItems.has(record.id));

      if (!selectedRecords.length) {
        showErrorToast('No items selected for invoice generation.');
        return;
      }

      // Get participant name from first record
      const participantName = selectedRecords[0]?.participant || '';

      setGeneratingPDF(true);
      isGeneratingInvoiceRef.current = true;

      // Endpoint generates ONE PDF for all selected items
      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/pdf/${id}/${boardId}/invoiceparticipanttax`;

      // Extract item IDs from selected records - backend expects itemIds array
      const itemIds = selectedRecords.map(record => record.id);

      const payload = {
        itemIds: itemIds,
        items: selectedRecords, // Keep items for backward compatibility
        participantName: participantName,
        invoiceDate: new Date(invoiceDate).toISOString(),
        dueDate: new Date(dueDate).toISOString()
      };

      const resp = await axios.post(apiUrl, payload, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
      });

      if (resp.status === 200 && resp.data) {
        const { invoiceNumber, fileUrl, itemCount } = resp.data;

        // Update item statuses in database
        try {
          const updateUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/update-status`;
          await axios.post(updateUrl, {
            itemIds: Array.from(selectedItems),
            invoiceNumber: invoiceNumber,
            status: 'invoiced',
            fileUrl
          }, {
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
          });
        } catch (updateErr: any) {
          console.error('Error updating item statuses:', updateErr);
          // Don't fail the whole operation if status update fails
          showInfoToast('Invoice generated but status update failed', {
            description: 'The invoice was created but item statuses could not be updated. Please refresh the page.'
          });
        }

        if (fileUrl) {
          // Download the PDF file instead of opening in new tab
          try {
            const pdfResponse = await fetch(fileUrl);
            const pdfBlob = await pdfResponse.blob();
            const pdfUrl = URL.createObjectURL(pdfBlob);
            const link = document.createElement('a');
            link.href = pdfUrl;
            link.download = `Invoice_${invoiceNumber}_${participantName.replace(/\s+/g, '_')}.pdf`;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();

            // Clean up
            setTimeout(() => {
              document.body.removeChild(link);
              URL.revokeObjectURL(pdfUrl);
            }, 100);
          } catch (downloadErr: any) {
            console.error('Error downloading PDF:', downloadErr);
            // Fallback to opening in new tab if download fails
            window.open(fileUrl, '_blank');
            showInfoToast('PDF opened in new tab', {
              description: 'Download failed, opened PDF in new tab instead.'
            });
          }
        }

        setShowInvoiceModal(false);
        showSuccessToast('Participant Tax Invoice generated', {
          description: `Invoice ${invoiceNumber} for ${participantName} (${itemCount} item${itemCount === 1 ? '' : 's'}) created.`
        });
        // Refresh data to show updated invoice numbers (silent mode to avoid showing another toast)
        setTimeout(() => {
          handleManualRefresh(true);
          // Reset the flag after a delay to allow refresh to complete
          setTimeout(() => {
            isGeneratingInvoiceRef.current = false;
          }, 2000);
        }, 1000);
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
    try {
      if (!selectedItems.size) {
        showErrorToast('Please select at least one item to include in the invoice.');
        return;
      }

      if (!invoiceDate) {
        showErrorToast('Please enter an invoice date.');
        return;
      }

      if (!dueDate) {
        showErrorToast('Please enter a due date.');
        return;
      }

      // Filter to only selected items
      const selectedRecords = eligibleRecords.filter(record => selectedItems.has(record.id));

      if (!selectedRecords.length) {
        showErrorToast('No items selected for invoice generation.');
        return;
      }

      // Get participant name from first record
      const participantName = selectedRecords[0]?.participant || '';

      setGeneratingXero(true);
      isGeneratingInvoiceRef.current = true;

      // Endpoint generates ONE Xero invoice for all selected items
      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/xero/${id}/${boardId}/invoiceparticipanttax`;

      const payload = {
        items: selectedRecords,
        participantName: participantName,
        invoiceDate: new Date(invoiceDate).toISOString(),
        dueDate: new Date(dueDate).toISOString()
      };

      const resp = await axios.post(apiUrl, payload, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
      });

      if (resp.status === 200 && resp.data) {
        const { invoiceNumber, invoiceUrl, itemCount } = resp.data;

        // Update item statuses in database (mark as invoiced)
        try {
          const updateUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/update-status`;
          await axios.post(updateUrl, {
            itemIds: Array.from(selectedItems),
            invoiceNumber: invoiceNumber,
            status: 'invoiced'
          }, {
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
          });
        } catch (updateErr: any) {
          console.error('Error updating item statuses:', updateErr);
          // Don't fail the whole operation if status update fails
          showInfoToast('Xero invoice created but status update failed', {
            description: 'The invoice was created in Xero but item statuses could not be updated. Please refresh the page.'
          });
        }

        if (invoiceUrl) {
          window.open(invoiceUrl, '_blank');
        }

        setShowInvoiceModal(false);
        showSuccessToast('Xero Participant Tax Invoice generated', {
          description: `Invoice ${invoiceNumber} for ${participantName} (${itemCount} item${itemCount === 1 ? '' : 's'}) created in Xero.`
        });
        // Refresh data to show updated invoice numbers (silent mode to avoid showing another toast)
        setTimeout(() => {
          handleManualRefresh(true);
          // Reset the flag after a delay to allow refresh to complete
          setTimeout(() => {
            isGeneratingInvoiceRef.current = false;
          }, 2000);
        }, 1000);
      } else {
        isGeneratingInvoiceRef.current = false;
        showErrorToast('Unexpected response while generating Xero invoice');
      }
    } catch (err: any) {
      console.error('Error generating Xero invoice', err);
      isGeneratingInvoiceRef.current = false;
      const errorMessage = err.response?.data?.message || err.message || 'Unknown error occurred';
      showErrorToast('Failed to generate Xero invoice', { description: errorMessage });
    } finally {
      setGeneratingXero(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto py-8">
        <Button
          variant="ghost"
          className="mb-6"
          onClick={() => router.push(`/workspace/${id}/board/${boardId}`)}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Board
        </Button>

        <div className="space-y-6">
          <Card className="p-6">
            {/* Header with Export Buttons */}
            <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
              <div className="space-y-2">
                <h1 className="text-2xl font-bold">Invoice Generator</h1>
                <p className="text-muted-foreground">
                  Manage delivered service records, submit claims and generate participant tax invoices.
                </p>
                <p className="text-xs text-muted-foreground">
                  Use Refresh to reload the latest cached ISO+ data. Trigger Sync when you&apos;ve updated ISO+ and need those changes pulled in.
                </p>
              </div>
              <div className="flex flex-col items-end gap-3">
                <div className="flex flex-wrap justify-end gap-2 pl-2">
                  <div className="flex flex-col items-start gap-2">
                    <div className="flex gap-2">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              className="gap-2"
                              onClick={() => handleManualRefresh(false)}
                              disabled={loading}
                            >
                              <RefreshCcw className="h-4 w-4" />
                              Refresh Data
                              <HelpCircle className="h-4 w-4" aria-label="Learn more about Refresh Data" onClick={(e) => { e.stopPropagation(); setShowHelpDialog(true); }} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            It pulls the most recent data that is already stored (cached) on your device or browser.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="secondary"
                              className="gap-2"
                              onClick={handleManualSync}
                              disabled={isManualSyncing}
                            >
                              {isManualSyncing ? (
                                <>
                                  <Spinner className="h-4 w-4" />
                                  Syncing...
                                </>
                              ) : (
                                <>
                                  Sync Data
                                </>
                              )}
                              <HelpCircle className="h-4 w-4" aria-label="Learn more about Sync Data" onClick={(e) => { e.stopPropagation(); setShowHelpDialog(true); }} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            It downloads brand-new data from the server, including any edits and new records.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <div className="flex items-start gap-2 text-sm text-muted-foreground">
                      <Clock className="h-4 w-4" />
                      {lastSyncedAt ? (
                        <span>Last refreshed {formatDistanceToNow(lastSyncedAt, { addSuffix: true })}</span>
                      ) : (
                        <span>Not refreshed yet</span>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    onClick={handleExportCSV}
                    className="gap-2"
                    disabled={exportingCSV}
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    Export to CSV
                  </Button>
                  <Button
                    className="gap-2"
                    onClick={handleOpenInvoiceModal}
                  >
                    <Receipt className="h-4 w-4" />
                    Participant Tax Invoice
                  </Button>
                </div>
              </div>
            </div>

            {/* Search and Filters */}
            <div className="flex flex-nowrap gap-4 mb-6 overflow-x-auto p-2">
              <div className="min-w-[120px] max-w-[200px] flex-shrink-0">
                <Select value={participantFilter} onValueChange={setParticipantFilter}>
                  <SelectTrigger className="w-full">
                    <div className="flex items-center gap-2 min-w-0 w-full">
                      <Search className="h-4 w-4 flex-shrink-0" />
                      <SelectValue placeholder="Participant" className="truncate" />
                    </div>
                  </SelectTrigger>
                  <SelectContent className="max-h-[300px] overflow-y-auto">
                    <SelectItem value="all">All Participants</SelectItem>
                    {uniqueParticipants.map((participant) => (
                      <SelectItem key={participant} value={participant}>
                        {participant}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="min-w-[220px] max-w-[300px] justify-start text-left font-normal flex-shrink-0">
                    <div className="flex items-center gap-2 min-w-0 w-full">
                      <Calendar className="h-4 w-4 flex-shrink-0" />
                      <span className="truncate">
                        {scheduledServiceDateRange?.from ? (
                          scheduledServiceDateRange.to ? (
                            <>
                              {format(scheduledServiceDateRange.from, "dd/MM/yyyy")} - {format(scheduledServiceDateRange.to, "dd/MM/yyyy")}
                            </>
                          ) : (
                            format(scheduledServiceDateRange.from, "dd/MM/yyyy")
                          )
                        ) : (
                          "Scheduled Service Date"
                        )}
                      </span>
                    </div>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <CalendarComponent
                    mode="range"
                    selected={scheduledServiceDateRange}
                    onSelect={setScheduledServiceDateRange}
                    numberOfMonths={2}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              {scheduledServiceDateRange?.from && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setScheduledServiceDateRange(undefined)}
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}

              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="min-w-[220px] max-w-[300px] justify-start text-left font-normal flex-shrink-0">
                    <div className="flex items-center gap-2 min-w-0 w-full">
                      <Calendar className="h-4 w-4 flex-shrink-0" />
                      <span className="truncate">
                        {serviceDeliveryDateRange?.from ? (
                          serviceDeliveryDateRange.to ? (
                            <>
                              {format(serviceDeliveryDateRange.from, "dd/MM/yyyy")} - {format(serviceDeliveryDateRange.to, "dd/MM/yyyy")}
                            </>
                          ) : (
                            format(serviceDeliveryDateRange.from, "dd/MM/yyyy")
                          )
                        ) : (
                          "Service Delivery Date"
                        )}
                      </span>
                    </div>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <CalendarComponent
                    mode="range"
                    selected={serviceDeliveryDateRange}
                    onSelect={setServiceDeliveryDateRange}
                    numberOfMonths={2}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              {serviceDeliveryDateRange?.from && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setServiceDeliveryDateRange(undefined)}
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}

              <Select value={transactionStatusFilter} onValueChange={setTransactionStatusFilter}>
                <SelectTrigger className="w-[220px] flex-shrink-0">
                  <div className="flex items-center gap-2 min-w-0 w-full">
                    <Filter className="h-4 w-4 flex-shrink-0" />
                    <SelectValue placeholder="Transaction Status" className="truncate" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {TRANSACTION_STATUS_FILTERS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={paymentStatusFilter} onValueChange={setPaymentStatusFilter}>
                <SelectTrigger className="min-w-[120px] max-w-[200px] flex-shrink-0">
                  <div className="flex items-center gap-2 min-w-0 w-full">
                    <Filter className="h-4 w-4 flex-shrink-0" />
                    <SelectValue placeholder="Payment Status" className="truncate" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_STATUS_FILTERS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

            </div>

            {/* Summary Cards - Under Filter Section */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
              <Card className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Total Records</p>
                    <p className="text-2xl font-bold">{filteredSummary.totalRecords}</p>
                  </div>
                  <BarChart3 className="h-8 w-8 text-blue-600" />
                </div>
              </Card>

              <Card className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Total Amount</p>
                    <p className="text-2xl font-bold">{formatCurrency(filteredSummary.totalAmount)}</p>
                  </div>
                  <DollarSign className="h-8 w-8 text-blue-600" />
                </div>
              </Card>

              <Card className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Total Government Subsidy</p>
                    <p className="text-2xl font-bold text-green-600">{formatCurrency(filteredSummary.totalGovSubsidy)}</p>
                  </div>
                  <CheckCircle className="h-8 w-8 text-green-600" />
                </div>
              </Card>

              <Card className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Total Participant Contribution</p>
                    <p className="text-2xl font-bold text-purple-600">
                      {formatCurrency(filteredSummary.totalParticipantContribution)}
                    </p>
                  </div>
                  <Percent className="h-8 w-8 text-purple-600" />
                </div>
              </Card>
            </div>

            {/* Service Records Title */}
            <div className="mb-4">
              <h2 className="text-xl font-semibold">Service Records</h2>
            </div>

            {/* Service Records Table */}
            <div className="relative">
              {canScrollLeft && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="absolute left-2 top-1/2 z-10 flex -translate-y-1/2 shadow-md bg-background/95"
                  onClick={() => handleHorizontalScroll('left')}
                  aria-label="Scroll table left"
                >
                  <ArrowLeftCircle className="h-5 w-5" />
                </Button>
              )}
              {canScrollRight && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 shadow-md bg-background/95"
                  onClick={() => handleHorizontalScroll('right')}
                  aria-label="Scroll table right"
                >
                  <ArrowRightCircle className="h-5 w-5" />
                </Button>
              )}
              <div ref={tableContainerRef} className="overflow-x-auto rounded-lg border">
                <Table className="min-w-[2400px]">
                  <TableHeader>
                    <TableRow>
                      {tableColumns.map((column) => {
                        const isSortable = column.key === 'scheduledServiceDate' || column.key === 'serviceDeliveryDate';
                        const isActiveSort = sortBy === column.key;

                        return (
                          <TableHead
                            key={column.key}
                            className={`${column.className ?? ''} whitespace-nowrap ${isSortable ? 'cursor-pointer hover:bg-muted/50' : ''} ${isActiveSort ? 'text-primary font-semibold' : ''}`}
                            onClick={isSortable ? () => {
                              if (isActiveSort) {
                                // Toggle sort order if clicking the same column
                                setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
                              } else {
                                // Set new sort column and default to ascending
                                setSortBy(column.key as "scheduledServiceDate" | "serviceDeliveryDate");
                                setSortOrder('asc');
                              }
                            } : undefined}
                          >
                            <div className="flex items-center gap-2">
                              <span className={isActiveSort ? 'text-primary' : ''}>{column.label}</span>
                              {isSortable && (
                                <span className="inline-flex items-center justify-center w-4 h-4 flex-shrink-0">
                                  {isActiveSort ? (
                                    sortOrder === 'asc' ? (
                                      <ArrowUp className="h-4 w-4 text-primary" />
                                    ) : (
                                      <ArrowDown className="h-4 w-4 text-primary" />
                                    )
                                  ) : (
                                    <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
                                  )}
                                </span>
                              )}
                            </div>
                          </TableHead>
                        );
                      })}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      <TableRow>
                        <TableCell colSpan={tableColumns.length} className="h-64 text-center">
                          <div className="flex flex-col items-center justify-center">
                            <Spinner />
                            <p className="mt-4 text-muted-foreground">Loading service records...</p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : error ? (
                      <TableRow>
                        <TableCell colSpan={tableColumns.length} className="h-64 text-center">
                          <div className="flex flex-col items-center justify-center">
                            <X className="h-8 w-8 text-destructive mb-2" />
                            <p className="text-destructive">Error: {error}</p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : currentItems.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={tableColumns.length} className="h-64 text-center">
                          <div className="flex flex-col items-center justify-center">
                            <FileText className="h-8 w-8 text-muted-foreground mb-2" />
                            <p className="text-muted-foreground">No service records found matching your criteria.</p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : (
                      currentItems.map((record) => (
                        <TableRow
                          key={record.id}
                          className={record?.invoiceNumber && (record?.invoiceNumber !== '' || record?.invoiceNumber !== undefined) ? 'bg-green-50 text-gray-600' : 'hover:bg-blue-50 transition-colors'}
                        >
                          {tableColumns.map((column) => (
                            <TableCell key={`${record.id}-${column.key}`} className={column.className}>
                              {column.render(record)}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>

            {/* Pagination */}
            <div className="mt-4 flex justify-center">
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                      className={currentPage === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                    />
                  </PaginationItem>

                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter(page =>
                      page === 1 ||
                      page === totalPages ||
                      (page >= currentPage - 1 && page <= currentPage + 1)
                    )
                    .map((page, i, arr) => (
                      <div key={`pagination-${page}`} style={{ display: "flex" }}>
                        {i > 0 && arr[i - 1] !== page - 1 && (
                          <PaginationItem>
                            <PaginationEllipsis />
                          </PaginationItem>
                        )}
                        <PaginationItem>
                          <PaginationLink
                            onClick={() => setCurrentPage(page)}
                            isActive={currentPage === page}
                          >
                            {page}
                          </PaginationLink>
                        </PaginationItem>
                      </div>
                    ))}

                  <PaginationItem>
                    <PaginationNext
                      onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                      className={currentPage === totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          </Card>
        </div>

        {/* Help Dialog - Refresh vs Sync */}
        <Dialog open={showHelpDialog} onOpenChange={setShowHelpDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <HelpCircle className="h-5 w-5" />
                Refresh Data vs Sync Data
              </DialogTitle>
              <DialogDescription>
                Understanding the difference between these two actions
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <div className="flex items-start gap-3">
                  <RefreshCcw className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <h3 className="font-semibold text-sm">Refresh Data</h3>
                    <p className="text-sm text-muted-foreground">
                      It pulls the most recent data that is already stored (cached) on your device or browser.
                    </p>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-start gap-3">
                  <Download className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                  <div>
                    <h3 className="font-semibold text-sm">Sync Data</h3>
                    <p className="text-sm text-muted-foreground">
                      It downloads brand-new data from the server, including any edits and new records.
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => setShowHelpDialog(false)}>Got it</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Invoice Generation Modal */}
        <Dialog open={showInvoiceModal} onOpenChange={(open) => {
          setShowInvoiceModal(open);
          if (!open) {
            // Reset selections when modal closes
            setSelectedItems(new Set());
            setEligibleRecords([]);
          }
        }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Receipt className="h-5 w-5" />
                Generate Invoice
              </DialogTitle>
              <DialogDescription>
                Select items and enter invoice details to generate a participant tax invoice
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-row gap-6 py-4 items-end">
              {/* Invoice Date */}
              <div className="flex-1 min-w-[200px]">
                <Label htmlFor="invoiceDate" className="flex items-center gap-2 mb-1">
                  <Calendar className="h-4 w-4" /> Invoice Date
                </Label>
                <Input
                  id="invoiceDate"
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  className="w-full"
                />
              </div>
              {/* Due Date */}
              <div className="flex-1 min-w-[200px]">
                <Label htmlFor="dueDate" className="flex items-center gap-2 mb-1">
                  <Calendar className="h-4 w-4" /> Due Date
                </Label>
                <Input
                  id="dueDate"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full"
                />
              </div>
            </div>

            {/* Eligible Records Section */}
            {showInvoiceModal && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h3 className="text-lg font-semibold">Eligible Records</h3>
                    {eligibleRecords.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleSelectAll}
                        className="h-8 text-xs"
                      >
                        {selectedItems.size === eligibleRecords.length ? 'Deselect All' : 'Select All'}
                      </Button>
                    )}
                  </div>
                  <Badge variant="secondary" className="text-lg px-3 py-1">
                    <DollarSign className="h-4 w-4 mr-1" />
                    Total: ${eligibleRecords
                      .filter(r => selectedItems.has(r.id))
                      .reduce((sum, record) => sum + (record.totalAmount || 0), 0).toFixed(2)}
                    {' '}
                    ({selectedItems.size} selected)
                  </Badge>
                </div>

                {loadingEligible ? (
                  <div className="flex items-center justify-center py-8">
                    <Spinner />
                    <span className="ml-2">Loading eligible records...</span>
                  </div>
                ) : eligibleRecords.length > 0 ? (
                  <div className="border rounded-lg p-4 max-h-60 overflow-y-auto bg-muted/30">
                    <div className="space-y-2">
                      {eligibleRecords.map((record) => (
                        <div
                          key={record.id}
                          className={`flex items-start gap-3 py-2 border-b last:border-0 hover:bg-muted/50 rounded px-2 cursor-pointer ${record.status === 'invoiced' ? 'bg-green-50/50 border-l-4 border-l-green-500' : ''
                            }`}
                          onClick={() => handleToggleItem(record.id)}
                        >
                          <Checkbox
                            checked={selectedItems.has(record.id)}
                            onCheckedChange={() => handleToggleItem(record.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="mt-1"
                          />
                          <div className="flex-1 flex justify-between items-center">
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <p className="font-medium">{record?.service || record?.notes || 'Service'}</p>
                                {record.status === 'invoiced' && (
                                  <Badge variant="outline" className="bg-green-100 text-green-800 border-green-300 text-xs">
                                    <CheckCircle className="h-3 w-3 mr-1" />
                                    Invoiced
                                  </Badge>
                                )}
                                {record.invoiceNumber && (
                                  <Badge variant="outline" className="text-xs">
                                    #{record.invoiceNumber}
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {record.scheduledServiceDate ? formatDate(record.scheduledServiceDate) : 'N/A'} • {record.quantity} {record.unit}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="font-semibold">${(record.totalAmount || 0).toFixed(2)}</p>
                              <p className="text-xs text-muted-foreground">Total</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <FileText className="h-12 w-12 mx-auto mb-2 opacity-50" />
                    <p>No eligible records found matching your filters.</p>
                  </div>
                )}
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowInvoiceModal(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleGeneratePDFInvoice}
                disabled={!selectedItems.size || generatingPDF || generatingXero}
                className="gap-2"
              >
                {generatingPDF ? (
                  <>
                    <Spinner />
                    Generating...
                  </>
                ) : (
                  <>
                    <Receipt className="h-4 w-4" />
                    Generate PDF Invoice
                  </>
                )}
              </Button>
              <Button
                onClick={handleGenerateXeroInvoice}
                disabled={!selectedItems.size || generatingPDF || generatingXero}
                variant="secondary"
                className="gap-2"
              >
                {generatingXero ? (
                  <>
                    <Spinner />
                    Generating...
                  </>
                ) : (
                  <>
                    <FileText className="h-4 w-4" />
                    Generate Xero Invoice
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
