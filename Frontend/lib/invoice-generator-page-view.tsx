'use client';

import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { Card } from "@/components/ui/card";
import { FileText, CheckCircle, DollarSign, BarChart3, FileSpreadsheet, Receipt, X, Percent, ArrowLeftCircle, ArrowRightCircle, Download, Clock, ArrowUpDown, ArrowUp, ArrowDown, HelpCircle } from "lucide-react";
import { PageHeader, StatCard } from "@/components/ui/page-shell";
import { Header } from "@/components/ui/header";
import { ResyncDataButton } from "@/components/ui/resync-data-button";
import { BoardSyncScheduleSummary } from "@/lib/board-sync-schedule-summary";
import Spinner from "@/components/ui/spin";
import { formatDistanceToNow } from "date-fns";
import { PaginationControls } from "@/lib/pagination-controls";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { InvoiceGeneratorTableColumn } from "@/lib/invoice-generator-table-columns";
import type { InvoiceGeneratorServiceRecord } from "@/lib/invoice-generator-types";
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
      <div className="container mx-auto animate-fade-in-up py-8">
        <BackButton onClick={() => router.push(`/workspace/${id}/board/${boardId}`)}>
          Back to Board
        </BackButton>

        <div className="page-enter-stagger space-y-6">
          <Card className="card-hover p-6 shadow-lg">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h1 className="text-3xl font-semibold tracking-tight">Invoice Generator</h1>
                </div>

                <div
                  data-slot="invoice-sync-actions"
                  className="flex flex-col items-start gap-2 xl:flex-row xl:flex-wrap"
                >
                  <div className="max-w-[420px] flex-shrink-0">
                    <BoardSyncScheduleSummary boardId={boardId} />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ResyncDataButton
                      onSync={handleManualSync}
                      onHelp={() => setShowHelpDialog(true)}
                      isSyncing={isManualSyncing}
                      disabled={syncStatuses.some((sync: SyncStatus) => sync.boardId === boardId && (sync.status === 'started' || sync.status === 'in-progress'))}
                    />
                    <Button
                      variant="outline"
                      onClick={handleExportCSV}
                      className="gap-2"
                      disabled={exportingCSV}
                    >
                      <FileSpreadsheet className="h-4 w-4" />
                      <span>Export to CSV</span>
                    </Button>
                    <Button className="gap-2" onClick={handleOpenInvoiceModal}>
                      <Receipt className="h-4 w-4" />
                      <span>{invoiceLabel}</span>
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {isNdisBoard
                    ? 'Manage NDIS service records and export NDIA claim CSV.'
                    : isLowCatBoard
                      ? 'Manage service records and generate tax invoices.'
                      : 'Manage service records, submit claims and generate participant tax invoices.'}
                </p>

                <div className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap">
                  <Clock className="h-4 w-4 shrink-0" />
                  {lastSyncedAt ? (
                    <span>Last refreshed {formatDistanceToNow(lastSyncedAt, { addSuffix: true })}</span>
                  ) : (
                    <span>Not refreshed yet</span>
                  )}
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

            {/* Summary Cards */}
            <div className="mb-6 mt-6 grid grid-cols-1 gap-4 md:grid-cols-4 md:gap-6">
              <StatCard
                label="Total Records"
                value={filteredSummary.totalRecords}
                icon={<BarChart3 className="h-5 w-5 text-primary" />}
              />
              <StatCard
                label="Total Amount"
                value={formatCurrency(filteredSummary.totalAmount)}
                icon={<DollarSign className="h-5 w-5 text-primary" />}
              />
              {!isLowCatBoard && !isNdisBoard && (
                <>
                  <StatCard
                    label="Total Government Subsidy"
                    value={formatCurrency(filteredSummary.totalGovSubsidy)}
                    valueClassName="text-green-600"
                    icon={<CheckCircle className="h-5 w-5 text-green-600" />}
                  />
                  <StatCard
                    label="Total Participant Contribution"
                    value={formatCurrency(filteredSummary.totalParticipantContribution)}
                    valueClassName="text-purple-600"
                    icon={<Percent className="h-5 w-5 text-purple-600" />}
                  />
                </>
              )}
            </div>

            {/* Service Records Title */}
            <div className="mb-4">
              <h2 className="text-xl font-semibold text-foreground">Service Records</h2>
            </div>

            {/* Service Records Table */}
            <div className="relative">
              {canScrollLeft && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="absolute left-2 top-1/2 z-10 flex -translate-y-1/2 bg-background/95 shadow-md transition-colors hover:-translate-y-1/2 active:scale-100 dark:border-white/10 dark:bg-black/90 dark:text-white"
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
                  className="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 bg-background/95 shadow-md transition-colors hover:-translate-y-1/2 active:scale-100 dark:border-white/10 dark:bg-black/90 dark:text-white"
                  onClick={() => handleHorizontalScroll('right')}
                  aria-label="Scroll table right"
                >
                  <ArrowRightCircle className="h-5 w-5" />
                </Button>
              )}
              <div
                ref={tableContainerRef}
                className="overflow-x-auto rounded-lg border border-border/60 bg-card shadow-sm"
              >
                <Table bare className="min-w-[2400px]">
                  <TableHeader>
                    <TableRow>
                      {tableColumns.map((column: InvoiceGeneratorTableColumn) => {
                        const isSortable = column.key === 'scheduledServiceDate' || column.key === 'serviceDeliveryDate';
                        const isActiveSort = sortBy === column.key;

                        return (
                          <TableHead
                            key={column.key}
                            className={`${column.className ?? ''} whitespace-nowrap ${isSortable ? 'cursor-pointer select-none hover:bg-muted/50' : ''} ${isActiveSort ? 'text-primary font-semibold' : ''}`}
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
                              <span className={isActiveSort ? 'text-primary' : ''}>{column.label}</span>
                              {isSortable && (
                                <span className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center">
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
                      currentItems.map((record: InvoiceGeneratorServiceRecord) => (
                        <TableRow
                          key={record.id}
                          className={
                            record?.invoiceNumber && record?.invoiceNumber !== '' && record?.invoiceNumber !== undefined
                              ? 'bg-green-50/80 text-foreground dark:bg-green-950/30'
                              : ''
                          }
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

            <PaginationControls
              className="mt-4 flex justify-center"
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={setCurrentPage}
            />
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
