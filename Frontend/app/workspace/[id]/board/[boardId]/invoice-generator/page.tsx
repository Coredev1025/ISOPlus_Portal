"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, FileText, Search, Calendar, Filter, CheckCircle, Clock, DollarSign, BarChart3, FileDown, FileSpreadsheet, Receipt, Download, X, Package } from "lucide-react";
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

interface ItemValue {
  object: string;
  data: any;
  attribute: {
    id: string;
    name: string;
    type: string;
  };
  deleted: boolean;
}

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
}

interface InvoiceSummary {
  totalRecords: number;
  invoiced: number;
  pending: number;
  totalValue: number;
}

interface DatabaseItem {
  _id: { $oid: string };
  itemId: string;
  data: {
    id: string;
    object: string;
    values: ItemValue[];
    folder_id: string;
  };
  status: string;
  syncStatus: string;
  workspaceId: string;
  boardId: string;
  createdAt: { $date: string };
  updatedAt: { $date: string };
  folderId: string;
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
    totalValue: 0
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
        const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/participantInvoiceTax`;
        const params = new URLSearchParams();
        params.append('folderName', 'Master Plan,Shift Planning and Reporting');
        params.append('limit', '1000'); // Get all to extract unique participants

        const response = await axios.get(apiUrl, {
          params: Object.fromEntries(params),
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
        const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/participantInvoiceTax`;
        const params = new URLSearchParams();

        params.append('participant', selectedParticipant);
        params.append('status', 'pending'); // Only pending records
        params.append('folderName', 'Master Plan,Shift Planning and Reporting');
        params.append('limit', '1000');

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
        // Build API URL
        const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/participantInvoiceTax`;

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

        params.append('folderName', 'Master Plan,Shift Planning and Reporting');

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
          totalAmount = 0
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
          totalValue: totalAmount
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

  // Calculate filtered summary
  const filteredSummary = {
    totalRecords: summary.totalRecords,
    totalAmount: filteredRecords.reduce((sum, record) => sum + record.totalAmount, 0),
    totalGovSubsidy: filteredRecords.reduce((sum, record) => sum + record.govSubsidy, 0),
    totalParticipantContribution: filteredRecords.reduce((sum, record) => sum + record.participantContribution, 0)
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

      // Fetch ALL filtered items (no pagination) for export
      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}/participantInvoiceTax`;
      const params = new URLSearchParams();

      // Apply same filters as the current view
      if (statusFilter !== 'all') {
        params.append('status', statusFilter);
      }
      if (participantFilter && participantFilter !== 'all') {
        params.append('participant', participantFilter);
      }
      if (scheduledDateRange?.from) {
        params.append('startDate', scheduledDateRange.from.toISOString());
      }
      if (scheduledDateRange?.to) {
        params.append('endDate', scheduledDateRange.to.toISOString());
      }

      params.append('folderName', 'Master Plan,Shift Planning and Reporting');

      // Request all items (no pagination limit)
      params.append('page', '1');
      params.append('limit', '999999'); // Large number to get all items

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

      // Format according to SaH Payment Statement structure
      const csvRows: string[] = [];

      // Payment Header Row
      const paymentDate = new Date();
      const paymentDateStr = paymentDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const paymentDateISO = paymentDate.toISOString().split('T')[0];
      const participantName = (participantFilter && participantFilter !== 'all') ? participantFilter : (allItems[0]?.participant || 'All Participants');

      csvRows.push(
        `Payment,' 100000000952 ',4060116249,89703,4040000001,${participantName},12345678912,${paymentDateStr},${paymentDateISO}T00:00:00Z,,,,,,,,,,,,,,,,,,,`
      );

      // Calculate totals
      const totalAmount = allItems.reduce((sum, item) => sum + item.totalAmount, 0);
      const totalGovSubsidy = allItems.reduce((sum, item) => sum + item.govSubsidy, 0);
      const totalParticipantContribution = allItems.reduce((sum, item) => sum + item.participantContribution, 0);
      const adjustments = 0; // Can be calculated if needed

      // Summary Row
      csvRows.push(
        `Summary,0,0,0,${adjustments.toFixed(2)},${totalAmount.toFixed(2)},${(totalAmount + adjustments).toFixed(2)},0,,,,,,,,,,,,,,,,,,,,`
      );

      // Group items by category for SummaryCategoryItems
      const categoryTotals: { [key: string]: { code: string; name: string; total: number } } = {};

      allItems.forEach(item => {
        // Determine category based on service/item type
        // This is a simplified categorization - adjust based on your actual data structure
        let categoryCode = 'ON'; // Default to Home support ongoing
        let categoryName = 'Home support ongoing';

        // You may need to adjust this logic based on your actual data
        if (item.notes?.toLowerCase().includes('care management')) {
          categoryCode = 'CM';
          categoryName = 'Care management';
        } else if (item.notes?.toLowerCase().includes('restorative')) {
          categoryCode = 'RC';
          categoryName = 'Restorative care pathway';
        } else if (item.notes?.toLowerCase().includes('end of life')) {
          categoryCode = 'EL';
          categoryName = 'End of life pathway';
        }

        if (!categoryTotals[categoryCode]) {
          categoryTotals[categoryCode] = { code: categoryCode, name: categoryName, total: 0 };
        }
        categoryTotals[categoryCode].total += item.totalAmount;
      });

      // Add SummaryCategoryItems rows
      const categoryOrder = ['AT', 'AS', 'CM', 'CU', 'EL', 'HC', 'HM', 'ON', 'RC'];
      const categoryNames: { [key: string]: string } = {
        'AT': 'Assistive technology',
        'AS': 'Assistive technology specified needs',
        'CM': 'Care management',
        'CU': 'Commonwealth unspent funds',
        'EL': 'End of life pathway',
        'HC': 'Home care account',
        'HM': 'Home modifications',
        'ON': 'Home support ongoing',
        'RC': 'Restorative care pathway'
      };

      categoryOrder.forEach(code => {
        const total = categoryTotals[code]?.total || 0;
        csvRows.push(
          `SummaryCategoryItems,${code},${categoryNames[code]},${total.toFixed(2)},,,,,,,,,,,,,,,,,,,,,,,,`
        );
      });

      // Add PaymentItems and PaymentItemBudget rows
      allItems.forEach((item, index) => {
        const itemId = `1000${String(index + 1).padStart(6, '0')}`;
        const invoiceRef = '000001';
        const phoneNumber = '0413269922'; // Placeholder
        const firstName = item.participant.split(' ')[0] || '';
        const lastName = item.participant.split(' ').slice(1).join(' ') || '';
        const serviceDate = item.scheduledStart ? new Date(item.scheduledStart).toISOString().split('T')[0].replace(/-/g, '') : '20250721';

        const serviceGroup = 'SERG-0001';
        const serviceGroupName = 'Home Support';
        const serviceType = 'SERT-0001';
        const serviceTypeName = 'Domestic assistance';
        const serviceName = 'SERV-0001';
        const serviceNameDesc = item.notes || 'General house cleaning';
        const itemCode = '';
        const itemName = '';

        const unitMap: { [key: string]: string } = {
          'Hours': 'hours',
          'Meal': 'meal',
          'Item': 'item',
          'Trip': 'trip',
          'Voucher': 'voucher',
          'Bill': 'bill'
        };
        const unit = unitMap[item.unit] || 'hours';

        const quantity = item.quantity;
        const unitPrice = item.unitPrice;
        const totalAmt = item.totalAmount;
        const adjustment = 0;
        const unspent = 0;
        const adjustment2 = -(totalAmt * 0.16); // Example adjustment
        const additionalPayment = 0;
        const netPayment = totalAmt + adjustment2;

        // PaymentItems row
        csvRows.push(
          `PaymentItems,${itemId},${invoiceRef},,,${phoneNumber},${firstName},${lastName},${serviceDate},${serviceGroup},${serviceGroupName},${serviceType},${serviceTypeName},${serviceName},${serviceNameDesc},${itemCode},${itemName},,,${quantity},${unitPrice},${unit},${totalAmt.toFixed(2)},${adjustment},${unspent},${adjustment2.toFixed(2)},${additionalPayment},${netPayment.toFixed(2)}`
        );

        // Determine category for budget allocation
        let categoryCode = 'ON';
        if (item.notes?.toLowerCase().includes('care management')) {
          categoryCode = 'CM';
        } else if (item.notes?.toLowerCase().includes('restorative')) {
          categoryCode = 'RC';
        } else if (item.notes?.toLowerCase().includes('end of life')) {
          categoryCode = 'EL';
        }

        // PaymentItemBudget row
        csvRows.push(
          `PaymentItemBudget,${categoryCode},${categoryNames[categoryCode] || 'Home support ongoing'},-${totalAmt.toFixed(2)},,,,,,,,,,,,,,,,,,,,,,,,`
        );
      });

      // Add Notes row if any
      csvRows.push(
        'Notes,GN,SaH payment statement export,,,,,,,,,,,,,,,,,,,,,,,,,,'
      );

      // Create CSV content
      const csvContent = csvRows.join('\n');

      // Download CSV
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      const fileName = `SaH_Payment_Statement_${participantName.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
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

  const handleExportPDF = () => {
    console.log('Export to PDF');
    showInfoToast('PDF export will be added after invoice flow.');
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
                  variant="outline"
                  onClick={handleExportPDF}
                  className="gap-2"
                >
                  <FileDown className="h-4 w-4" />
                  Export to PDF
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
                        {record.status === 'invoiced' ? `INV-${new Date().getFullYear()}-${String(record.id).padStart(3, '0')}` : '-'}
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
                              <p className="font-medium">{record.notes || 'Service'}</p>
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
