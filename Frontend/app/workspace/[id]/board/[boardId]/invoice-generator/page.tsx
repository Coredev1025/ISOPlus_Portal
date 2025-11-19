"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, FileText, Search, Calendar, Filter, CheckCircle, Clock, DollarSign, BarChart3, FileSpreadsheet, Receipt, X, Package } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useState, useEffect } from "react";
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
import { format } from "date-fns";
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

const TRANSACTION_STATUS_FILTERS = [
  { value: "all", label: "All Transaction Status" },
  { value: "Delivered", label: "Delivered - To be claimed and invoiced." },
  { value: "Cancelled", label: "Cancelled - To be claimed and invoiced if applicable." },
  { value: "Adjustment (Refund)", label: "Adjustment (Refund) - To be claimed and invoiced." },
  { value: "Adjustment (Charge)", label: "Adjustment (Charge) - To be claimed and invoiced." }
];

const PAYMENT_STATUS_FILTERS = [
  { value: "all", label: "All Payment Status" },
  { value: "Gov Claim Submited", label: "Gov Claim Submited" },
  { value: "Gov Claim Paid", label: "Gov Claim Paid" },
  { value: "Participant Invoiced", label: "Participant Invoiced" },
  { value: "Participant Paid", label: "Participant Paid" }
];

interface ServiceRecord {
  id: string;
  status: "invoiced" | "pending";
  participant: string;
  scheduledStart: string | null;
  scheduledServiceDate?: string | null;
  serviceDeliveryDate?: string | null;
  worker: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  govSubsidy: number;
  participantContribution: number;
  notes: string;
  service: string;
  serviceCategory: string;
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
  itemId?: string;
  item?: string;
  servicePlan?: string;
  wraparoundItemId?: string;
  wraparoundDescription?: string;
  prescribedItem?: boolean | string;
  itemPurchasedMethod?: string;
  associatedProvider?: string;
  associatedProviderInvoiceNo?: string;
  healthProfessionalTypeCode?: string;
  healthProfessionalTypeOther?: string;
}

interface InvoiceSummary {
  totalRecords: number;
  invoiced: number;
  pending: number;
  totalValue: number;
  totalGovSubsidy: number;
  totalParticipantContribution: number;
}

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
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  const [error, setError] = useState<string | null>(null);

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

  // Fetch unique participants for the modal dropdown
  useEffect(() => {
    const fetchParticipants = async () => {
      try {
        const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/invoice-generator`;

        const response = await axios.get(apiUrl, {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });

        if (response.data?.items) {
          const participantSet = new Set<string>(
            response.data.items
              .map((item: ServiceRecord) => item.participant)
              .filter((p: string) => p && p.trim() !== '') // Filter out empty/null values
          );
          const participants = Array.from(participantSet).sort();
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

        if (transactionStatusFilter !== 'all') {
          params.append('transactionStatus', transactionStatusFilter);
        }

        if (paymentStatusFilter !== 'all') {
          params.append('paymentStatus', paymentStatusFilter);
        }

        params.append('page', '1');
        params.append('limit', '999999');

        const response = await axios.get(apiUrl, {
          params: Object.fromEntries(params),
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });

        if (response.data?.items) {
          setEligibleRecords(response.data.items);
          // Auto-select all eligible records by default (including invoiced ones)
          setSelectedItems(new Set(response.data.items.map((r: ServiceRecord) => r.id)));
          
          if (response.data.items.length > 0) {
            showInfoToast(`Loaded ${response.data.items.length} eligible record${response.data.items.length === 1 ? '' : 's'}`, {
              description: 'All records (including invoiced) are shown. You can select which ones to include in the invoice.'
            });
          }
        } else {
          showInfoToast('No eligible records found', {
            description: 'No records match your current filters.'
          });
        }
      } catch (err) {
        console.error('Error fetching eligible records:', err);
        showErrorToast('Failed to fetch eligible records', { description: err instanceof Error ? err.message : 'Unknown error' });
        setEligibleRecords([]);
      } finally {
        setLoadingEligible(false);
      }
    };

    fetchEligibleRecords();
  }, [showInvoiceModal, id, boardId, participantFilter, scheduledServiceDateRange, serviceDeliveryDateRange, transactionStatusFilter, paymentStatusFilter]);

  useEffect(() => {
    const fetchData = async () => {
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

        if (transactionStatusFilter !== 'all') {
          params.append('transactionStatus', transactionStatusFilter);
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

        // Pagination
        params.append('page', currentPage.toString());
        params.append('limit', ITEMS_PER_PAGE.toString());

        // Fetch items from the backend
        const response = await axios.get(apiUrl, {
          params: Object.fromEntries(params),
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
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
      } catch (err: any) {
        const errorMessage = err.response?.data?.message || err.message || 'An error occurred while fetching data';
        setError(errorMessage);
        console.error("Error fetching invoice data:", err);
      } finally {
        setLoading(false);
      }
    };

    if (id && boardId) {
      fetchData();
    }
  }, [
    id,
    boardId,
    statusFilter,
    participantFilter,
    scheduledServiceDateRange,
    serviceDeliveryDateRange,
    transactionStatusFilter,
    paymentStatusFilter,
    currentPage,
    ITEMS_PER_PAGE
  ]);

  // Whenever filters change, reset to first page for consistent results
  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, participantFilter, scheduledServiceDateRange, serviceDeliveryDateRange, transactionStatusFilter, paymentStatusFilter]);

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
    }).format(amount);
  };

  const isWithinRange = (dateString: string | null | undefined, range: DateRange | undefined) => {
    if (!range?.from && !range?.to) {
      return true;
    }
    if (!dateString) {
      return false;
    }
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) {
      return false;
    }
    if (range.from) {
      const from = new Date(range.from);
      from.setHours(0, 0, 0, 0);
      if (date < from) {
        return false;
      }
    }
    const toSource = range.to || range.from;
    if (toSource) {
      const to = new Date(toSource);
      to.setHours(23, 59, 59, 999);
      if (date > to) {
        return false;
      }
    }
    return true;
  };

  // Filter service records - apply client-side filters for transaction status and payment status
  const filteredRecords = serviceRecords.filter(record => {
    if (!isWithinRange(record.scheduledStart, scheduledServiceDateRange)) {
      return false;
    }
    if (!isWithinRange(record.serviceDeliveryDate, serviceDeliveryDateRange)) {
      return false;
    }
    if (transactionStatusFilter !== 'all') {
      try {
        const pattern = new RegExp(transactionStatusFilter, 'i');
        const recordStatus = record.transactionStatus || '';
        if (!pattern.test(recordStatus)) {
          return false;
        }
      } catch (err) {
        return false;
      }
    }
    if (paymentStatusFilter !== 'all') {
      try {
        // For payment status, check if any of the comma-separated values match
        const pattern = new RegExp(paymentStatusFilter, 'i');
        const recordStatus = record.paymentStatus || '';
        // Split by comma and check each value
        const statusValues = recordStatus.split(',').map(s => s.trim());
        const matches = statusValues.some(status => pattern.test(status));
        if (!matches) {
          return false;
        }
      } catch (err) {
        return false;
      }
    }
    return true;
  });

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

  // Export handlers
  const handleExportCSV = async () => {
    try {
      setLoading(true);

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

      if (transactionStatusFilter !== 'all') {
        params.append('transactionStatus', transactionStatusFilter);
      }

      if (paymentStatusFilter !== 'all') {
        params.append('paymentStatus', paymentStatusFilter);
      }

      params.append('folderName', 'Master Plan,Shift Planning and Reporting');

      params.append('page', '1');
      params.append('limit', '999999');

      const response = await axios.get(apiUrl, {
        params: Object.fromEntries(params),
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      const allItems: ServiceRecord[] = response.data.items || [];

      if (allItems.length === 0) {
        showErrorToast('No records to export.');
        setLoading(false);
        return;
      }

      // CSV headers based on ISO+ specifications
      const headers = [
        'Invoice Number',
        'Care Recipient Identifier',
        'Service Identifier',
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
        'Health Professional Type Other'
      ];

      const escapeForCsv = (value: unknown) => {
        if (value === null || value === undefined || value === '') {
          return '';
        }
        const stringValue = String(value).replace(/"/g, '""');
        return `"${stringValue}"`;
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

      const csvRows: string[] = [];

      allItems.forEach((item) => {
        // 1. Invoice Number - from {Generated Invoice Number}
        const invoiceNumber = item.invoiceNumber || '';

        // 2. Care Recipient Identifier - from {My Aged Care ID Number} (From Intake)
        const careRecipientIdentifier = item.careRecipientIdentifier || '';

        // 3. Service Identifier - from {Service ID / Item ID} attribute of Aged Care Pricing folders
        // Do not add the "/" and any content after that
        let serviceIdentifier = item.serviceIdentifier || '';
        if (serviceIdentifier && serviceIdentifier.includes('/')) {
          serviceIdentifier = serviceIdentifier.split('/')[0].trim();
        }

        // 4. Delivered By Third Party
        // true if {Delivered by} attribute is Associated Providers
        // false if {Delivered by} attribute is Company Workforce
        let deliveredByThirdParty = '';
        if (item.deliveredBy) {
          const deliveredByLower = String(item.deliveredBy).toLowerCase();
          if (deliveredByLower.includes('associated provider') || deliveredByLower.includes('associated providers')) {
            deliveredByThirdParty = 'true';
          } else if (deliveredByLower.includes('company workforce') || deliveredByLower.includes('workforce')) {
            deliveredByThirdParty = 'false';
          }
        }

        // 5. Item or Wraparound
        // Item: if {Unit} is Item
        // Wraparound: if the {Service Plan} attribute contains Wraparound
        let itemOrWraparound = '';
        if (item.unit && item.unit.toLowerCase() === 'item') {
          itemOrWraparound = 'Item';
        } else if (item.servicePlan && String(item.servicePlan).toLowerCase().includes('wraparound')) {
          itemOrWraparound = 'Wraparound';
        }

        // 6. Item Description Code
        // If Item is selected, {Item ID} attribute
        // If Wraparound is selected, BLANK
        const itemDescriptionCode = (itemOrWraparound === 'Item' && item.itemId) ? item.itemId : '';

        // 7. Item Description
        // If Item is selected, {Item} attribute
        // If Wraparound is selected, BLANK
        const itemDescription = (itemOrWraparound === 'Item' && item.item) ? item.item : '';

        // 8. Wraparound Description Code
        // If Item is selected, BLANK
        // If Wraparound is selected, the {Wraparound Item ID} attribute
        const wraparoundDescriptionCode = (itemOrWraparound === 'Wraparound' && item.wraparoundItemId) ? item.wraparoundItemId : '';

        // 9. Wraparound Description
        // If Item is selected, BLANK
        // If Wraparound is selected, the {Wraparound Description} attribute
        const wraparoundDescription = (itemOrWraparound === 'Wraparound' && item.wraparoundDescription) ? item.wraparoundDescription : '';

        // 10. Prescribed Item
        // Y: if ticked
        // N: Otherwise
        const prescribedItemValue = item.prescribedItem;
        let prescribedItem = 'N';
        if (prescribedItemValue === true) {
          prescribedItem = 'Y';
        } else if (typeof prescribedItemValue === 'string') {
          const valueLower = prescribedItemValue.toLowerCase();
          if (valueLower === 'true' || prescribedItemValue === 'Y') {
            prescribedItem = 'Y';
          }
        }

        // 11. Purchased Method Type
        // If Purchased, PURCHASED
        // If Loaned, LOANED
        let purchasedMethodType = '';
        if (item.itemPurchasedMethod) {
          const methodLower = String(item.itemPurchasedMethod).toLowerCase();
          if (methodLower.includes('purchased')) {
            purchasedMethodType = 'PURCHASED';
          } else if (methodLower.includes('loaned')) {
            purchasedMethodType = 'LOANED';
          }
        }

        // 12. Loaned by Organisation Name
        // If LOANED is selected, {Associated Provider (If Applicable)}
        // Otherwise, BLANK
        const loanedByOrganisationName = (purchasedMethodType === 'LOANED' && item.associatedProvider) ? item.associatedProvider : '';

        // 13. Loaned By Invoice Number
        // If LOANED is selected, {Associated Provider Invoice No. (if applicable)}
        // Otherwise, BLANK
        const loanedByInvoiceNumber = (purchasedMethodType === 'LOANED' && item.associatedProviderInvoiceNo) ? item.associatedProviderInvoiceNo : '';

        // 14. Health Professional Type Code
        // From the Health Professional Pricing folder of the selected Health Professional Service
        const healthProfessionalTypeCode = item.healthProfessionalTypeCode || '';

        // 15. Health Professional Type Other
        // A free text if the selected Health Professional Service includes Other
        const healthProfessionalTypeOther = item.healthProfessionalTypeOther || '';

        csvRows.push(
          [
            escapeForCsv(invoiceNumber), // Invoice Number
            escapeForCsv(careRecipientIdentifier), // Care Recipient Identifier
            escapeForCsv(serviceIdentifier), // Service Identifier
            escapeForCsv(deliveredByThirdParty), // Delivered By Third Party
            escapeForCsv(itemOrWraparound), // Item or Wraparound
            escapeForCsv(itemDescriptionCode), // Item Description Code
            escapeForCsv(itemDescription), // Item Description
            escapeForCsv(wraparoundDescriptionCode), // Wraparound Description Code
            escapeForCsv(wraparoundDescription), // Wraparound Description
            escapeForCsv(prescribedItem), // Prescribed Item
            escapeForCsv(purchasedMethodType), // Purchased Method Type
            escapeForCsv(loanedByOrganisationName), // Loaned by Organisation Name
            escapeForCsv(loanedByInvoiceNumber), // Loaned By Invoice Number
            escapeForCsv(healthProfessionalTypeCode), // Health Professional Type Code
            escapeForCsv(healthProfessionalTypeOther) // Health Professional Type Other
          ].join(',')
        );
      });

      const csvContent = csvRows.join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      
      // Generate CSV filename following the format: External Reference Identifier
      // Format: BulkInvoice_YYYYMMDD_HHMMSS_<participant_identifier>.csv
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0].replace(/-/g, ''); // YYYYMMDD
      const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, ''); // HHMMSS
      const participantIdentifier = participantFilter && participantFilter !== 'all'
        ? participantFilter.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '')
        : 'AllParticipants';
      
      // CSV filename serves as External Reference Identifier
      const fileName = `BulkInvoice_${dateStr}_${timeStr}_${participantIdentifier}.csv`;
      
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

      setLoading(false);
      showSuccessToast(`Successfully exported ${allItems.length} records to CSV.`);
    } catch (err: any) {
      console.error('Error exporting CSV:', err);
      showErrorToast('Failed to export CSV', { description: err.message });
      setLoading(false);
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
    showInfoToast('Loading eligible records...', {
      description: 'Fetching all records (including invoiced) that match your filters.'
    });
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

      setLoading(true);

      // Endpoint generates ONE PDF for all selected items
      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/pdf/${id}/${boardId}/invoiceparticipanttax`;

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
        // Refresh data to show updated invoice numbers
        window.location.reload();
      } else {
        showErrorToast('Unexpected response while generating invoice');
      }
    } catch (err: any) {
      console.error('Error generating participant invoice', err);
      showErrorToast('Failed to generate invoice', { description: err.response?.data?.message || err.message || 'Unknown error occurred' });
    } finally {
      setLoading(false);
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

      setLoading(true);

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
        // Refresh data to show updated invoice numbers
        window.location.reload();
      } else {
        showErrorToast('Unexpected response while generating Xero invoice');
      }
    } catch (err: any) {
      console.error('Error generating Xero invoice', err);
      showErrorToast('Failed to generate Xero invoice', { description: err.response?.data?.message || err.message || 'Unknown error occurred' });
    } finally {
      setLoading(false);
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
            <div className="flex items-center justify-between mb-6">
              <div>
                <h1 className="text-2xl font-bold">Invoice Generator</h1>
                <p className="text-muted-foreground">
                  Manage delivered service records, submit claims and generate participant tax invoices.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={handleExportCSV}
                  className="gap-2"
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

            {/* Search and Filters */}
            <div className="flex flex-wrap gap-4 mb-6">
              <div className="min-w-[180px] max-w-[200px]">
                <Select value={participantFilter} onValueChange={setParticipantFilter}>
                  <SelectTrigger className="w-full">
                    <Search className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Participant" />
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
                  <Button variant="outline" className="min-w-[180px] max-w-[200px] justify-start text-left font-normal">
                    <Calendar className="mr-2 h-4 w-4" />
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
                  <Button variant="outline" className="min-w-[180px] max-w-[200px] justify-start text-left font-normal">
                    <Calendar className="mr-2 h-4 w-4" />
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
                <SelectTrigger className="min-w-[180px] max-w-[200px]">
                  <Filter className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Transaction Status" />
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
                <SelectTrigger className="min-w-[180px] max-w-[200px]">
                  <Filter className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Payment Status" />
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
                      {filteredSummary.totalAmount > 0 
                        ? ((filteredSummary.totalParticipantContribution / filteredSummary.totalAmount) * 100).toFixed(2)
                        : '0.00'}%
                    </p>
                  </div>
                  <DollarSign className="h-8 w-8 text-purple-600" />
                </div>
              </Card>
            </div>

            {/* Service Records Title */}
            <div className="mb-4">
              <h2 className="text-xl font-semibold">Service Records</h2>
            </div>

            {/* Service Records Table */}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Payment Status</TableHead>
                    <TableHead>Participant</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Scheduled Service Date</TableHead>
                    <TableHead>Total Amount ($)</TableHead>
                    <TableHead>Gov Subsidy ($)</TableHead>
                    <TableHead>Participant Contribution ($)</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead>Item First Payment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={9} className="h-64 text-center">
                      <div className="flex flex-col items-center justify-center">
                        <Spinner />
                        <p className="mt-4 text-muted-foreground">Loading service records...</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : error ? (
                  <TableRow>
                    <TableCell colSpan={9} className="h-64 text-center">
                      <div className="flex flex-col items-center justify-center">
                        <X className="h-8 w-8 text-destructive mb-2" />
                        <p className="text-destructive">Error: {error}</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : filteredRecords.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="h-64 text-center">
                      <div className="flex flex-col items-center justify-center">
                        <FileText className="h-8 w-8 text-muted-foreground mb-2" />
                        <p className="text-muted-foreground">No service records found matching your criteria.</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  currentItems.map((record) => (
                    <TableRow key={record.id} className={record.status === 'invoiced' ? 'bg-green-50 text-gray-600' : 'hover:bg-blue-50 transition-colors'}>
                      <TableCell>{record.paymentStatus || '-'}</TableCell>
                      <TableCell className="font-medium">{record.participant}</TableCell>
                      <TableCell>{record.service || '-'}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {record.scheduledServiceDate || (record.scheduledStart ? formatDate(record.scheduledStart).split(' ')[0] : '-')}
                      </TableCell>
                      <TableCell className="font-semibold">{formatCurrency(record.totalAmount)}</TableCell>
                      <TableCell>{formatCurrency(record.govSubsidy)}</TableCell>
                      <TableCell>{formatCurrency(record.participantContribution)}</TableCell>
                      <TableCell className="max-w-xs truncate" title={record.notes}>
                        <span className="text-gray-500" dangerouslySetInnerHTML={record.notes ? { __html: record.notes } : { __html: '' }}>
                        </span>
                      </TableCell>
                      <TableCell>
                        {record.itemFirstPayment === true || record.itemFirstPayment === 'true' || record.itemFirstPayment === 'Y' ? 'Y' : 'N'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
                </TableBody>
              </Table>
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
                          className={`flex items-start gap-3 py-2 border-b last:border-0 hover:bg-muted/50 rounded px-2 cursor-pointer ${
                            record.status === 'invoiced' ? 'bg-green-50/50 border-l-4 border-l-green-500' : ''
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
                                <p className="font-medium">{record?.serviceCategory || record?.service || record?.notes || 'Service'}</p>
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
                                {record.scheduledStart ? formatDate(record.scheduledStart) : 'N/A'} • {record.quantity} {record.unit}
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
                disabled={!selectedItems.size}
                className="gap-2"
              >
                {loading ? (
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
                disabled={!selectedItems.size}
                variant="secondary"
                className="gap-2"
              >
                {loading ? (
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
