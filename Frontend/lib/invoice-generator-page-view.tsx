'use client';

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, FileText, Search, Calendar, Filter, CheckCircle, DollarSign, BarChart3, FileSpreadsheet, Receipt, X, Percent, ArrowLeftCircle, ArrowRightCircle, Download, Clock, ArrowUpDown, ArrowUp, ArrowDown, HelpCircle } from "lucide-react";
import { Header } from "@/components/ui/header";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { format, formatDistanceToNow } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TRANSACTION_STATUS_FILTERS } from "@/lib/invoice-generator-helpers";
import type { InvoiceGeneratorTableColumn } from "@/lib/invoice-generator-table-columns";
import type { InvoiceGeneratorServiceRecord } from "@/lib/invoice-generator-types";
import type { DateRange } from "react-day-picker";
import { InvoiceGeneratorFiltersRow } from "@/lib/invoice-generator-filters-row";
import { InvoiceGeneratorInvoiceDialog } from "@/lib/invoice-generator-invoice-dialog";
import type { SyncStatus } from "@/app/context";


export type InvoiceGeneratorPageViewProps = Record<string, any>;

export function InvoiceGeneratorPageView(props: InvoiceGeneratorPageViewProps) {
  const {
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
    showInvoiceModal, setShowInvoiceModal, eligibleRecords, selectedItems,
    loadingEligible, handleSelectAll, handleToggleItem, invoiceDate, setInvoiceDate,
    dueDate, setDueDate, generatingPDF, generatingXero, handleGeneratePDFInvoice,
    handleGenerateXeroInvoice, isCareManagementBoard, PAYMENT_STATUS_FILTERS,
    setSelectedItems, setEligibleRecords,
  } = props;

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
                <h1 className="text-2xl font-bold">
                  Invoice Generator
                </h1>
                <p className="text-muted-foreground">
                  {isNdisBoard
                    ? 'Manage NDIS service records and export NDIA claim CSV.'
                    : isLowCatBoard
                      ? 'Manage service records and generate tax invoices.'
                      : 'Manage service records, submit claims and generate participant tax invoices.'}
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
                              variant="secondary"
                              className="gap-2"
                              onClick={handleManualSync}
                              disabled={isManualSyncing || syncStatuses.some((sync: SyncStatus) => sync.boardId === boardId && (sync.status === 'started' || sync.status === 'in-progress'))}
                            >
                              {isManualSyncing ? (
                                <>
                                  <Spinner className="h-4 w-4" />
                                  Syncing...
                                </>
                              ) : (
                                <>
                                  Resync Data
                                </>
                              )}
                              <HelpCircle className="h-4 w-4" aria-label="Learn more about Resync Data" onClick={(e) => { e.stopPropagation(); setShowHelpDialog(true); }} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            It downloads brand-new data from the server, including any edits and new records.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
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
                        {invoiceLabel}
                      </Button>
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
                </div>
              </div>
            </div>

            {/* Search and Filters */}
            <InvoiceGeneratorFiltersRow
              isNdisBoard={isNdisBoard}
              participantFilter={participantFilter}
              setParticipantFilter={setParticipantFilter}
              uniqueParticipants={uniqueParticipants}
              scheduledServiceDateRange={scheduledServiceDateRange}
              setScheduledServiceDateRange={setScheduledServiceDateRange}
              serviceDeliveryDateRange={serviceDeliveryDateRange}
              setServiceDeliveryDateRange={setServiceDeliveryDateRange}
              transactionStatusFilter={transactionStatusFilter}
              setTransactionStatusFilter={setTransactionStatusFilter}
              jobStatusFilter={jobStatusFilter}
              setJobStatusFilter={setJobStatusFilter}
              ndisStatusFieldLabel={ndisStatusFieldLabel}
              paymentStatusFilter={paymentStatusFilter}
              setPaymentStatusFilter={setPaymentStatusFilter}
              ndisPaymentStatusOptions={ndisPaymentStatusOptions}
              paymentStatusFilters={PAYMENT_STATUS_FILTERS}
            />

            {/* Summary Cards - Under Filter Section */}
            <div className={`grid grid-cols-1 md:grid-cols-4 gap-6 mb-6`}>
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

              {!isLowCatBoard && !isNdisBoard && (
                <>
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
                </>
              )}
            </div>

            {/* Service Records Title */}
            <div className="mb-4">
              <h2 className="text-xl font-semibold dark:text-white">Service Records</h2>
            </div>

            {/* Service Records Table */}
            <div className="relative">
              {canScrollLeft && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="absolute left-2 top-1/2 z-10 flex -translate-y-1/2 shadow-md bg-background/95 dark:bg-black/90 dark:text-white dark:border-white/10"
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
                  className="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 shadow-md bg-background/95 dark:bg-black/90 dark:text-white dark:border-white/10"
                  onClick={() => handleHorizontalScroll('right')}
                  aria-label="Scroll table right"
                >
                  <ArrowRightCircle className="h-5 w-5" />
                </Button>
              )}
              <div
                ref={tableContainerRef}
                className="overflow-x-auto rounded-lg border bg-white text-foreground dark:bg-black dark:text-white dark:border-white/10"
              >
                <Table className="min-w-[2400px] dark:text-white">
                  <TableHeader>
                    <TableRow>
                      {tableColumns.map((column: InvoiceGeneratorTableColumn) => {
                        const isSortable = column.key === 'scheduledServiceDate' || column.key === 'serviceDeliveryDate';
                        const isActiveSort = sortBy === column.key;

                        return (
                          <TableHead
                            key={column.key}
                            className={`${column.className ?? ''} whitespace-nowrap dark:text-white ${isSortable ? 'cursor-pointer hover:bg-muted/50 dark:hover:bg-white/10' : ''} ${isActiveSort ? 'text-primary font-semibold dark:text-white' : ''}`}
                            onClick={isSortable ? () => {
                              if (isActiveSort) {
                                // Toggle sort order if clicking the same column
                                setSortOrder((prev: 'asc' | 'desc') => prev === 'asc' ? 'desc' : 'asc');
                              } else {
                                // Set new sort column and default to ascending
                                setSortBy(column.key as "scheduledServiceDate" | "serviceDeliveryDate");
                                setSortOrder('asc');
                              }
                            } : undefined}
                          >
                            <div className="flex items-center gap-2">
                              <span className={isActiveSort ? 'text-primary dark:text-white' : ''}>{column.label}</span>
                              {isSortable && (
                                <span className="inline-flex items-center justify-center w-4 h-4 flex-shrink-0">
                                  {isActiveSort ? (
                                    sortOrder === 'asc' ? (
                                      <ArrowUp className="h-4 w-4 text-primary dark:text-white" />
                                    ) : (
                                      <ArrowDown className="h-4 w-4 text-primary dark:text-white" />
                                    )
                                  ) : (
                                    <ArrowUpDown className="h-4 w-4 text-muted-foreground dark:text-white" />
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
                            <p className="mt-4 text-muted-foreground dark:text-white">Loading service records...</p>
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
                            <p className="text-muted-foreground dark:text-white">No service records found matching your criteria.</p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : (
                      currentItems.map((record: InvoiceGeneratorServiceRecord) => (
                        <TableRow
                          key={record.id}
                          className={record?.invoiceNumber && record?.invoiceNumber !== '' && record?.invoiceNumber !== undefined ? 'bg-green-50 text-gray-600 dark:bg-black dark:text-white' : 'hover:bg-blue-50 transition-colors dark:hover:bg-white/10 dark:text-white'}
                        >
                          {tableColumns.map((column: InvoiceGeneratorTableColumn) => (
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
            <div className="mt-4 flex justify-center dark:text-white">
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

        {/* Help Dialog - Resync Data */}
        <Dialog open={showHelpDialog} onOpenChange={setShowHelpDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <HelpCircle className="h-5 w-5" />
                Resync Data
              </DialogTitle>
              <DialogDescription>
                Understanding how resync works
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <div className="flex items-start gap-3">
                  <Download className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                  <div>
                    <h3 className="font-semibold text-sm">Resync Data</h3>
                    <p className="text-sm text-muted-foreground">
                      It downloads brand-new data from the server, including any edits and new records. The button will be disabled while a sync is in progress.
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
        <InvoiceGeneratorInvoiceDialog
          showInvoiceModal={showInvoiceModal}
          setShowInvoiceModal={setShowInvoiceModal}
          setSelectedItems={props.setSelectedItems}
          setEligibleRecords={props.setEligibleRecords}
          isLowCatBoard={isLowCatBoard}
          invoiceDate={invoiceDate}
          setInvoiceDate={setInvoiceDate}
          dueDate={dueDate}
          setDueDate={setDueDate}
          eligibleRecords={eligibleRecords}
          selectedItems={selectedItems}
          handleSelectAll={handleSelectAll}
          formatCurrency={formatCurrency}
          getInvoiceAmount={getInvoiceAmount}
          loadingEligible={loadingEligible}
          handleToggleItem={handleToggleItem}
          formatDate={formatDate}
          isNdisBoard={isNdisBoard}
          handleGeneratePDFInvoice={handleGeneratePDFInvoice}
          generatingPDF={generatingPDF}
          generatingXero={generatingXero}
          handleGenerateXeroInvoice={handleGenerateXeroInvoice}
        />
      </div>
    </div>

  );
}
