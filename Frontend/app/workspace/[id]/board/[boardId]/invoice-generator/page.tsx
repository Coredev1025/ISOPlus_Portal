"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, FileText, Search, Calendar, Filter, CheckCircle, Clock, DollarSign, BarChart3, FileDown, FileSpreadsheet, Receipt, Download, X } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ServiceRecord, InvoiceSummary } from "../types";
import axios from "@/app/utils/axiosConfig";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { format } from "date-fns";
import { DateRange } from "react-day-picker";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import Spinner from "@/components/ui/spin";

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
  const [deliveryDateRange, setDeliveryDateRange] = useState<DateRange | undefined>();
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  // Sample data for demonstration - replace with actual API calls
  const sampleData: ServiceRecord[] = [
    {
      id: "1",
      status: "invoiced",
      participant: "John Smith",
      scheduledStart: "2024-01-15T09:00:00",
      deliveryDate: "2024-01-15T17:00:00",
      worker: "Alice Johnson",
      unit: "Hours",
      quantity: 8,
      unitPrice: 45.00,
      totalAmount: 360.00,
      govSubsidy: 288.00,
      participantContribution: 72.00,
      notes: "Personal care assistance"
    },
    {
      id: "2",
      status: "pending",
      participant: "Sarah Williams",
      scheduledStart: "2024-01-20T10:00:00",
      deliveryDate: "2024-01-20T11:30:00",
      worker: "Bob Chen",
      unit: "Item",
      quantity: 1,
      unitPrice: 150.00,
      totalAmount: 150.00,
      govSubsidy: 120.00,
      participantContribution: 30.00,
      notes: "Mobility equipment"
    },
    {
      id: "3",
      status: "pending",
      participant: "Michael Brown",
      scheduledStart: "2024-01-25T14:00:00",
      deliveryDate: "2024-01-25T20:00:00",
      worker: "Carol Davis",
      unit: "Hours",
      quantity: 6,
      unitPrice: 42.00,
      totalAmount: 252.00,
      govSubsidy: 201.60,
      participantContribution: 50.40,
      notes: "Community access support"
    },
    {
      id: "4",
      status: "pending",
      participant: "Emma Wilson",
      scheduledStart: "2024-01-30T08:00:00",
      deliveryDate: "2024-01-30T09:00:00",
      worker: "David Lee",
      unit: "Item",
      quantity: 2,
      unitPrice: 75.00,
      totalAmount: 150.00,
      govSubsidy: 105.00,
      participantContribution: 45.00,
      notes: "Therapeutic supplies"
    },
    {
      id: "5",
      status: "pending",
      participant: "James Taylor",
      scheduledStart: "2024-02-05T11:00:00",
      deliveryDate: "2024-02-05T15:00:00",
      worker: "Eva Garcia",
      unit: "Hours",
      quantity: 4,
      unitPrice: 48.00,
      totalAmount: 192.00,
      govSubsidy: 153.60,
      participantContribution: 38.40,
      notes: "Domestic assistance"
    },
    {
      id: "6",
      status: "invoiced",
      participant: "Lisa Anderson",
      scheduledStart: "2024-02-10T16:00:00",
      deliveryDate: "2024-02-10T17:00:00",
      worker: "Frank Miller",
      unit: "Item",
      quantity: 1,
      unitPrice: 200.00,
      totalAmount: 200.00,
      govSubsidy: 160.00,
      participantContribution: 40.00,
      notes: "Assistive technology"
    }
  ];

  useEffect(() => {
    // Simulate API call
    const fetchData = async () => {
      setLoading(true);
      try {
        // Replace with actual API call
        // const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/invoices?workspaceId=${id}&boardId=${boardId}`);
        // setServiceRecords(response.data.records);
        
        // Using sample data for now
        setServiceRecords(sampleData);
        
        // Calculate summary - this will be recalculated based on filtered records
        const totalRecords = sampleData.length;
        const invoiced = sampleData.filter(record => record.status === 'invoiced').length;
        const pending = sampleData.filter(record => record.status === 'pending').length;
        const totalValue = sampleData.reduce((sum, record) => sum + record.totalAmount, 0);
        
        setSummary({
          totalRecords,
          invoiced,
          pending,
          totalValue
        });
      } catch (error) {
        console.error("Error fetching invoice data:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [id, boardId]);

  // Filter service records
  const filteredRecords = serviceRecords.filter(record => {
    // Participant filter
    const matchesParticipant = !participantFilter || 
      record.participant.toLowerCase().includes(participantFilter.toLowerCase());
    
    // Status filter
    const matchesStatus = statusFilter === "all" || record.status === statusFilter;
    
    // Scheduled service date range filter
    const recordScheduledDate = new Date(record.scheduledStart);
    const matchesScheduledStart = !scheduledDateRange?.from || recordScheduledDate >= scheduledDateRange.from;
    const matchesScheduledEnd = !scheduledDateRange?.to || recordScheduledDate <= scheduledDateRange.to;
    
    // Service delivery date range filter
    const recordDeliveryDate = record.deliveryDate ? new Date(record.deliveryDate) : null;
    const matchesDeliveryStart = !deliveryDateRange?.from || (recordDeliveryDate && recordDeliveryDate >= deliveryDateRange.from);
    const matchesDeliveryEnd = !deliveryDateRange?.to || (recordDeliveryDate && recordDeliveryDate <= deliveryDateRange.to);
    
    return matchesParticipant && matchesStatus && 
           matchesScheduledStart && matchesScheduledEnd &&
           matchesDeliveryStart && matchesDeliveryEnd;
  });

  // Calculate filtered summary
  const filteredSummary = {
    totalRecords: filteredRecords.length,
    totalAmount: filteredRecords.reduce((sum, record) => sum + record.totalAmount, 0),
    totalGovSubsidy: filteredRecords.reduce((sum, record) => sum + record.govSubsidy, 0),
    totalParticipantContribution: filteredRecords.reduce((sum, record) => sum + record.participantContribution, 0)
  };

  // Pagination
  const totalPages = Math.ceil(filteredRecords.length / ITEMS_PER_PAGE);
  const currentItems = filteredRecords.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  const formatDate = (dateString: string) => {
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
    const headers = ['Status', 'Participant', 'Scheduled Start', 'Service Delivery', 'Worker', 'Unit', 'Quantity', 'Unit Price', 'Total Amount', 'Gov Subsidy', 'Participant Contribution', 'Notes'];
    const csvData = filteredRecords.map(record => [
      record.status,
      record.participant,
      formatDate(record.scheduledStart),
      record.deliveryDate ? formatDate(record.deliveryDate) : '',
      record.worker,
      record.unit,
      record.quantity,
      record.unitPrice,
      record.totalAmount,
      record.govSubsidy,
      record.participantContribution,
      record.notes
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

                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="flex-1 justify-start text-left font-normal">
                      <Calendar className="mr-2 h-4 w-4" />
                      {deliveryDateRange?.from ? (
                        deliveryDateRange.to ? (
                          <>
                            {format(deliveryDateRange.from, "dd/MM/yyyy")} - {format(deliveryDateRange.to, "dd/MM/yyyy")}
                          </>
                        ) : (
                          format(deliveryDateRange.from, "dd/MM/yyyy")
                        )
                      ) : (
                        "Delivery Date Range"
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <CalendarComponent
                      mode="range"
                      selected={deliveryDateRange}
                      onSelect={setDeliveryDateRange}
                      numberOfMonths={2}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
                {deliveryDateRange?.from && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeliveryDateRange(undefined)}
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
                  <TableHead>STATUS</TableHead>
                  <TableHead>PARTICIPANT</TableHead>
                  <TableHead>SCHEDULED SERVICE DATE</TableHead>
                  <TableHead>SERVICE DELIVERY DATE</TableHead>
                  <TableHead>WORKER</TableHead>
                  <TableHead>UNIT</TableHead>
                  <TableHead>QUANTITY</TableHead>
                  <TableHead>UNIT PRICE</TableHead>
                  <TableHead>TOTAL AMOUNT</TableHead>
                  <TableHead>GOV SUBSIDY</TableHead>
                  <TableHead>PARTICIPANT CONTRIBUTION</TableHead>
                  <TableHead>NOTES</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {currentItems.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell>
                      {record.status === 'invoiced' ? (
                        <Badge className="bg-green-100 text-green-800 border-green-200">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          Invoiced
                        </Badge>
                      ) : (
                        <Badge className="bg-blue-100 text-blue-800 border-blue-200">
                          <Clock className="h-3 w-3 mr-1" />
                          Pending
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-medium">{record.participant}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(record.scheduledStart)}</TableCell>
                    <TableCell className="whitespace-nowrap">{record.deliveryDate ? formatDate(record.deliveryDate) : '-'}</TableCell>
                    <TableCell>{record.worker}</TableCell>
                    <TableCell>
                      <Badge 
                        variant="outline" 
                        className={record.unit === 'Hours' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'}
                      >
                        {record.unit}
                      </Badge>
                    </TableCell>
                    <TableCell>{record.quantity}</TableCell>
                    <TableCell>{formatCurrency(record.unitPrice)}</TableCell>
                    <TableCell className="font-bold">{formatCurrency(record.totalAmount)}</TableCell>
                    <TableCell>{formatCurrency(record.govSubsidy)}</TableCell>
                    <TableCell>{formatCurrency(record.participantContribution)}</TableCell>
                    <TableCell className="max-w-xs truncate">
                      <span className="text-muted-foreground">
                        {record.notes}
                      </span>
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
