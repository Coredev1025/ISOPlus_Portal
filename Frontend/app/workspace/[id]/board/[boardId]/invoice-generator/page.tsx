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

interface ServiceRecord {
  id: string;
  status: "invoiced" | "pending";
  participant: string;
  scheduledStart: string | null;
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
}

interface InvoiceSummary {
  totalRecords: number;
  invoiced: number;
  pending: number;
  totalValue: number;
  totalGovSubsidy: number;
  totalParticipantContribution: number;
}
import { DateRange } from "react-day-picker";

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
  const [scheduledDateRange, setScheduledDateRange] = useState<DateRange | undefined>();
  // We'll use scheduled date range only
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  const [error, setError] = useState<string | null>(null);

  // Modal state for invoice generation
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [selectedParticipant, setSelectedParticipant] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [eligibleRecords, setEligibleRecords] = useState<ServiceRecord[]>([]);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [loadingEligible, setLoadingEligible] = useState(false);
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

  // Fetch eligible records when participant and month are selected
  useEffect(() => {
    const fetchEligibleRecords = async () => {
      if (!selectedParticipant || !selectedMonth || !showInvoiceModal) {
        setEligibleRecords([]);
        return;
      }

      setLoadingEligible(true);
      try {
        const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/invoice-generator`;
        const params = new URLSearchParams();

        params.append('participant', selectedParticipant);
        params.append('status', 'pending'); // Only pending records

        // Parse selected month (format: "June 2025" or "2025-06")
        const [monthYear] = selectedMonth.split(' ');
        const monthDate = new Date(selectedMonth);
        if (!isNaN(monthDate.getTime())) {
          const startDate = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
          const endDate = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0, 23, 59, 59);
          params.append('startDate', startDate.toISOString());
          params.append('endDate', endDate.toISOString());
        }

        const response = await axios.get(apiUrl, {
          params: Object.fromEntries(params),
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });

        if (response.data?.items) {
          setEligibleRecords(response.data.items);
          // Auto-select all eligible records by default
          setSelectedItems(new Set(response.data.items.map((r: ServiceRecord) => r.id)));
        }
      } catch (err) {
        console.error('Error fetching eligible records:', err);
        setEligibleRecords([]);
      } finally {
        setLoadingEligible(false);
      }
    };

    fetchEligibleRecords();
  }, [selectedParticipant, selectedMonth, showInvoiceModal, id, boardId]);

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

        // Date range filter for scheduled dates
        if (scheduledDateRange?.from) {
          const from = new Date(scheduledDateRange.from);
          from.setHours(0, 0, 0, 0); // start of day local
          params.append('startDate', from.toISOString());
        }
        if (scheduledDateRange?.to || scheduledDateRange?.from) {
          // If only one date picked, use same day end-of-day
          const toSource = scheduledDateRange?.to || scheduledDateRange?.from;
          const to = new Date(toSource as Date);
          to.setHours(23, 59, 59, 999); // end of day local
          params.append('endDate', to.toISOString());
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
    scheduledDateRange,
    currentPage,
    ITEMS_PER_PAGE
  ]);

  // Whenever filters change, reset to first page for consistent results
  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, participantFilter, scheduledDateRange]);

  // Filter service records - now only for local filtering
  const filteredRecords = serviceRecords;

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

  // Export handlers
  const handleExportCSV = async () => {
    try {
      setLoading(true);

      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/invoiceparticipanttax`;
      const params = new URLSearchParams();

      if (statusFilter !== 'all') {
        params.append('status', statusFilter);
      }
      if (participantFilter && participantFilter !== 'all') {
        params.append('participant', participantFilter);
      }
      if (scheduledDateRange?.from) {
        const from = new Date(scheduledDateRange.from);
        from.setHours(0, 0, 0, 0);
        params.append('startDate', from.toISOString());
      }
      if (scheduledDateRange?.to) {
        const to = new Date(scheduledDateRange.to);
        to.setHours(23, 59, 59, 999);
        params.append('endDate', to.toISOString());
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

      const headers = [
        'Participant',
        'Status',
        'Scheduled Start',
        'Worker',
        'Unit',
        'Quantity',
        'Unit Price',
        'Total Amount',
        'Gov Subsidy',
        'Participant Contribution',
        'Service',
        'Service Category',
        'Invoice Number',
        'Notes'
      ];

      const escapeForCsv = (value: unknown) => {
        if (value === null || value === undefined) {
          return '""';
        }
        const stringValue = String(value).replace(/"/g, '""');
        return `"${stringValue}"`;
      };

      const formatDateForCsv = (dateString: string | null) => {
        if (!dateString) {
          return '';
        }
        const date = new Date(dateString);
        if (Number.isNaN(date.getTime())) {
          return '';
        }
        return date.toISOString();
      };

      const csvRows: string[] = [headers.join(',')];

      allItems.forEach((item) => {
        csvRows.push(
          [
            escapeForCsv(item.participant),
            escapeForCsv(item.status),
            escapeForCsv(formatDateForCsv(item.scheduledStart)),
            escapeForCsv(item.worker),
            escapeForCsv(item.unit),
            escapeForCsv(item.quantity),
            escapeForCsv(item.unitPrice),
            escapeForCsv(item.totalAmount),
            escapeForCsv(item.govSubsidy),
            escapeForCsv(item.participantContribution),
            escapeForCsv(item.service),
            escapeForCsv(item.serviceCategory),
            escapeForCsv(item.invoiceNumber || ''),
            escapeForCsv(item.notes ? item.notes.replace(/<[^>]*>/g, '') : '')
          ].join(',')
        );
      });

      const csvContent = csvRows.join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      const participantName = participantFilter && participantFilter !== 'all'
        ? participantFilter.replace(/\s+/g, '_')
        : 'all-participants';
      const fileName = `invoice-records_${participantName}_${new Date().toISOString().split('T')[0]}.csv`;
      link.setAttribute('href', url);
      link.setAttribute('download', fileName);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

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
    // Initialize with current filter if available and not "all"
    if (participantFilter && participantFilter !== 'all') {
      setSelectedParticipant(participantFilter);
    } else {
      setSelectedParticipant('');
    }
    // Default to current month
    const currentDate = new Date();
    const monthYear = currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    setSelectedMonth(monthYear);
    setSelectedItems(new Set()); // Reset selected items
    setShowInvoiceModal(true);
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

  // Generate invoice from modal
  const handleGenerateParticipantTaxInvoice = async () => {
    try {
      if (!selectedItems.size) {
        showErrorToast('Please select at least one item to include in the invoice.');
        return;
      }

      if (!selectedParticipant) {
        showErrorToast('Please select a participant.');
        return;
      }

      if (!selectedMonth) {
        showErrorToast('Please select a month.');
        return;
      }

      // Filter to only selected items
      const selectedRecords = eligibleRecords.filter(record => selectedItems.has(record.id));

      if (!selectedRecords.length) {
        showErrorToast('No items selected for invoice generation.');
        return;
      }

      setLoading(true);

      // Endpoint generates ONE PDF for all selected items
      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/pdf/${id}/${boardId}/invoiceparticipanttax`;

      const today = new Date();
      const due = new Date(today);
      due.setDate(due.getDate() + 14);

      const payload = {
        items: selectedRecords, 
        participantName: selectedParticipant,
        invoiceDate: today.toISOString(),
        dueDate: due.toISOString()
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
          window.open(fileUrl, '_blank');
        }

        setShowInvoiceModal(false);
        showSuccessToast('Participant Tax Invoice generated', {
          description: `Invoice ${invoiceNumber} for ${selectedParticipant} (${itemCount} item${itemCount === 1 ? '' : 's'}) created.`
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
              <div className="flex-1 min-w-[200px]">
                <Select value={participantFilter} onValueChange={setParticipantFilter}>
                  <SelectTrigger className="w-full">
                    <Search className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Select participant..." />
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

              <div className="flex gap-4">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="flex-1">
                    <Filter className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Filter by status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Records</SelectItem>
                    <SelectItem value="invoiced">Invoiced</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                  </SelectContent>
                </Select>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="flex-1 justify-start text-left font-normal">
                      <Calendar className="mr-2 h-4 w-4" />
                      {scheduledDateRange?.from ? (
                        scheduledDateRange.to ? (
                          <>
                            {format(scheduledDateRange.from, "dd/MM/yyyy")} - {format(scheduledDateRange.to, "dd/MM/yyyy")}
                          </>
                        ) : (
                          format(scheduledDateRange.from, "dd/MM/yyyy")
                        )
                      ) : (
                        "Scheduled Date Range"
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <CalendarComponent
                      mode="range"
                      selected={scheduledDateRange}
                      onSelect={setScheduledDateRange}
                      numberOfMonths={2}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
                {scheduledDateRange?.from && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setScheduledDateRange(undefined)}
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}


              </div>
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
                    <p className="text-2xl font-bold text-purple-600">{formatCurrency(filteredSummary.totalParticipantContribution)}</p>
                  </div>
                  <DollarSign className="h-8 w-8 text-purple-600" />
                </div>
              </Card>
            </div>

            {/* Service Records Table */}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Participant</TableHead>
                  <TableHead>Scheduled Start</TableHead>
                  <TableHead>Worker</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>Unit Price</TableHead>
                  <TableHead>Total Amount</TableHead>
                  <TableHead>Gov Subsidy</TableHead>
                  <TableHead>Participant Contribution</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead>Invoice #</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={12} className="h-64 text-center">
                      <div className="flex flex-col items-center justify-center">
                        <Spinner />
                        <p className="mt-4 text-muted-foreground">Loading service records...</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : error ? (
                  <TableRow>
                    <TableCell colSpan={12} className="h-64 text-center">
                      <div className="flex flex-col items-center justify-center">
                        <X className="h-8 w-8 text-destructive mb-2" />
                        <p className="text-destructive">Error: {error}</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : filteredRecords.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={12} className="h-64 text-center">
                      <div className="flex flex-col items-center justify-center">
                        <FileText className="h-8 w-8 text-muted-foreground mb-2" />
                        <p className="text-muted-foreground">No service records found matching your criteria.</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  currentItems.map((record) => (
                    <TableRow key={record.id} className={record.status === 'invoiced' ? 'bg-green-50 text-gray-600' : 'hover:bg-blue-50 transition-colors'}>
                      <TableCell>
                        <div className="flex items-center">
                          {record.status === 'invoiced' ? (
                            <div className="flex items-center">
                              <FileText className="w-4 h-4 text-green-600 mr-2" />
                              <Badge className="bg-green-100 text-green-800">Invoiced</Badge>
                            </div>
                          ) : (
                            <div className="flex items-center">
                              {record.unit === 'Hours' ? (
                                <Clock className="w-4 h-4 text-blue-600 mr-2" />
                              ) : (
                                <Package className="w-4 h-4 text-purple-600 mr-2" />
                              )}
                              <Badge className="bg-blue-100 text-blue-800">Pending</Badge>
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">{record.participant}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(record.scheduledStart)}</TableCell>
                      <TableCell>{record.worker}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={record.unit === 'Hours' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'}
                        >
                          {record.unit}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">{record.quantity}</TableCell>
                      <TableCell>{formatCurrency(record.unitPrice)}</TableCell>
                      <TableCell className="font-semibold">{formatCurrency(record.totalAmount)}</TableCell>
                      <TableCell>{formatCurrency(record.govSubsidy)}</TableCell>
                      <TableCell>{formatCurrency(record.participantContribution)}</TableCell>
                      <TableCell className="max-w-xs truncate" title={record.notes}>
                        <span className="text-gray-500" dangerouslySetInnerHTML={record.notes ? { __html: record.notes } : { __html: '' }}>
                        </span>
                      </TableCell>
                      <TableCell className="font-mono">
                        {record.invoiceNumber && record.invoiceNumber.trim() !== '' ? record.invoiceNumber : '-'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>

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
                Select a participant and month to generate a participant tax invoice
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-row gap-6 py-4 items-end">
              {/* Participant Selection */}
              <div className="flex-1 min-w-[250px]">
                <Label htmlFor="participant" className="flex items-center gap-2 mb-1">
                  <span className="text-lg">👤</span> Select Participant
                </Label>
                <Select value={selectedParticipant} onValueChange={setSelectedParticipant}>
                  <SelectTrigger id="participant" className="w-full">
                    <SelectValue placeholder="Select participant..." />
                  </SelectTrigger>
                  <SelectContent>
                    {uniqueParticipants.map((participant) => (
                      <SelectItem key={participant} value={participant}>
                        {participant}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* Month Selection */}
              <div className="flex-1 min-w-[250px]">
                <Label htmlFor="month" className="flex items-center gap-2 mb-1">
                  <Calendar className="h-4 w-4" /> Select Month
                </Label>
                <Input
                  id="month"
                  type="month"
                  value={selectedMonth ? format(new Date(selectedMonth), 'yyyy-MM') : ''}
                  onChange={(e) => {
                    const date = new Date(e.target.value + '-01');
                    const monthYear = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
                    setSelectedMonth(monthYear);
                  }}
                  className="w-full"
                />
              </div>
            </div>

            {/* Eligible Records Section */}
            {selectedParticipant && selectedMonth && (
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
                          className="flex items-start gap-3 py-2 border-b last:border-0 hover:bg-muted/50 rounded px-2 cursor-pointer"
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
                              <p className="font-medium">{record?.serviceCategory || record?.service || record?.notes || 'Service'}</p>
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
                    <p>No eligible pending records found for this participant and month.</p>
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
                onClick={handleGenerateParticipantTaxInvoice}
                disabled={!selectedItems.size || loading || loadingEligible}
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
                    Generate Invoice
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
