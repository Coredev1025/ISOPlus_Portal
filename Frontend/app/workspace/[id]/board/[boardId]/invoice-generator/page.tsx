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
import axios from "@/app/utils/axiosConfig";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { format } from "date-fns";

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
  const [participantFilter, setParticipantFilter] = useState("");
  const [scheduledDateRange, setScheduledDateRange] = useState<DateRange | undefined>();
  // We'll use scheduled date range only
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        // Build API URL
        const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${id}/${boardId}`;
        
        // Build query parameters
        const params = new URLSearchParams();
        
        // Status filter
        if (statusFilter !== 'all') {
          params.append('status', statusFilter);
        }
        
        // Participant name filter
        if (participantFilter) {
          params.append('participant', participantFilter);
        }
        
        // Date range filter for scheduled dates
        if (scheduledDateRange?.from) {
          params.append('startDate', scheduledDateRange.from.toISOString());
        }
        if (scheduledDateRange?.to) {
          params.append('endDate', scheduledDateRange.to.toISOString());
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
  const handleExportCSV = () => {
    // Prepare CSV data
    const headers = ['Status', 'Participant', 'Scheduled Start', 'Worker', 'Unit', 'Quantity', 'Unit Price', 'Total Amount', 'Gov Subsidy', 'Participant Contribution', 'Notes', 'Invoice #'];
    const csvData = filteredRecords.map(record => [
      record.status,
      record.participant,
      formatDate(record.scheduledStart),
      record.worker,
      record.unit,
      record.quantity,
      record.unitPrice,
      record.totalAmount,
      record.govSubsidy,
      record.participantContribution,
      record.notes,
      record.status === 'invoiced' ? `INV-${new Date().getFullYear()}-${String(record.id).padStart(3, '0')}` : '-'
    ]);

    const csvContent = [
      headers.join(','),
      ...csvData.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `service-records-${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportPDF = () => {
    // TODO: Implement PDF export functionality
    console.log('Export to PDF');
    alert('PDF export functionality will be implemented');
  };

  const handleGenerateParticipantTaxInvoice = () => {
    // TODO: Implement participant tax invoice generation
    console.log('Generate Participant Tax Invoice');
    alert('Participant tax invoice generation will be implemented');
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
                  onClick={handleGenerateParticipantTaxInvoice}
                >
                  <Receipt className="h-4 w-4" />
                  Participant Tax Invoice
                </Button>
              </div>
            </div>

            {/* Search and Filters */}
            <div className="flex flex-wrap gap-4 mb-6">
              <div className="flex-1 min-w-[200px]">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                  <Input
                    placeholder="Search participant..."
                    value={participantFilter}
                    onChange={(e) => setParticipantFilter(e.target.value)}
                    className="pl-9"
                  />
                </div>
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
                {currentItems.map((record) => (
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
                      <span className="text-gray-500">
                        {record.notes}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono">
                      {record.status === 'invoiced' ? `INV-${new Date().getFullYear()}-${String(record.id).padStart(3, '0')}` : '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {loading ? (
              <div className="flex flex-col items-center justify-center py-16">
                Loading service records...
                <span className="ml-2"><Spinner /></span>
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-16">
                <X className="h-8 w-8 text-destructive mb-2" />
                <p className="text-destructive">Error: {error}</p>
              </div>
            ) : filteredRecords.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16">
                <FileText className="h-8 w-8 text-muted-foreground" />
                <p className="text-gray-500">No service records found matching your criteria.</p>
              </div>
            ) : null}

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
      </div>
    </div>
  );
}
