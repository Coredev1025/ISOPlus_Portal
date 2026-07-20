"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar, User, FileText, AlertCircle, FileCheck, FileSpreadsheet, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import Spinner from "@/components/ui/spin";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from "recharts";
import { Label } from "@/components/ui/label";
import {
  Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";
import { format } from "date-fns";

type ChartBarDatum = { name: string; label: string; shortLabel: string; value: number; color: string };

import { MonthlyStatementServiceRow, type MonthlyStatementServiceRecord } from "@/lib/monthly-statement-service-row";

function MonthlyStatementBudgetChartsSection({
  loadingServiceItems,
  chartConfigs,
  chartCardRefs,
  chartContainerRef,
  formatCurrency,
  ChartXAxisTick,
  ChartBarValueLabel,
}: Record<string, any>) {
  return (
    <Card className="p-6 shadow-lg print:shadow-none">
      <div className="mb-6">
        <h3 className="text-xl font-semibold">Budget Mini Charts</h3>
        <p className="text-sm text-muted-foreground">
          Visual summaries for each funding stream, including Expenditure, remaining budget, etc.
        </p>
      </div>
      {loadingServiceItems ? (
        <div className="text-center py-8">
          <Spinner />
        </div>
      ) : chartConfigs.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" ref={chartContainerRef}>
          {chartConfigs.map((chart: any, chartIndex: number) => (
            <div
              key={chart.code}
              ref={(el) => { chartCardRefs.current[chartIndex] = el; }}
              className="rounded-lg border border-border/60 bg-background p-3 flex flex-col gap-3 shadow-sm dark:bg-black dark:border-white/10 print:bg-white"
            >
              <div className="rounded-md bg-background overflow-hidden dark:bg-black print:bg-white" data-pdf-chart-container="true">
                <div className="px-2 py-2 text-center text-[22px] font-normal text-foreground dark:text-white print:text-black">
                  {chart.title}
                </div>
                <ChartContainer
                  config={chart.chartConfig}
                  className="w-full aspect-auto min-h-[18rem] h-72 overflow-visible bg-background dark:bg-black print:bg-white"
                >
                  <BarChart data={chart.data} margin={{ left: 4, right: 4, top: 44, bottom: 14 }} barCategoryGap="22%">
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="0" vertical={false} />
                    <XAxis
                      dataKey="shortLabel"
                      axisLine={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1 }}
                      tickLine={false}
                      interval={0}
                      height={96}
                      tick={<ChartXAxisTick />}
                      allowDataOverflow={false}
                    />
                    <YAxis hide />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          className="text-sm"
                          labelClassName="font-normal text-sm"
                          formatter={(value, name, item) => [
                            formatCurrency(typeof value === 'number' ? value : Number(value)),
                            (item?.payload as ChartBarDatum)?.label || name,
                          ]}
                        />
                      }
                    />
                    <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={52} isAnimationActive={false}>
                      <LabelList dataKey="value" content={<ChartBarValueLabel />} />
                      {chart.data.map((entry: ChartBarDatum) => (
                        <Cell key={`${chart.code}-${entry.name}`} fill={`var(--color-${entry.name})`} />
                      ))}
                    </Bar>
                  </BarChart>
                </ChartContainer>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          <AlertCircle className="h-12 w-12 mx-auto mb-2 opacity-50" />
          <p>No services found for the selected period</p>
        </div>
      )}
    </Card>
  );
}

function MonthlyStatementBudgetSections({
  loadingServiceItems,
  categorizedBudgetSections,
  handleBudgetCategoryExportCSV,
  exportingSection,
  isCurrencyColumn,
  isHourColumn,
  formatBudgetCellDisplay,
}: Record<string, any>) {
  return (
    <Card className="shadow-lg print:shadow-none">
      <div className="p-6 border-b">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-xl font-semibold">Individualised Budgets</h3>
            <p className="text-sm text-muted-foreground">
              Budget allocation and spending records for each funding stream
            </p>
          </div>
        </div>
      </div>
      {loadingServiceItems ? (
        <div className="p-6 text-center">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-6 p-6">
          {categorizedBudgetSections.map((section: any) => (
            <div key={section.categoryCode} className="border rounded-lg p-4">
              <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <h4 className="text-lg font-semibold">{section.sectionTitle}</h4>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 print:hidden"
                  onClick={() => handleBudgetCategoryExportCSV(section.categoryCode, section.sectionTitle)}
                  disabled={exportingSection === `budget-${section.categoryCode}`}
                >
                  <FileSpreadsheet className="h-4 w-4" />
                  Export CSV
                </Button>
              </div>
              <div className="overflow-x-auto">
                {section.items.length === 0 ? (
                  <div className="py-4 text-center text-sm text-muted-foreground">
                    No budget items found for this stream.
                  </div>
                ) : (
                  <Table className="text-sm min-w-max">
                    <TableHeader>
                      <TableRow>
                        {section.columns.map((column: string) => (
                          <TableHead
                            key={`${section.categoryCode}-${column}`}
                            className={isCurrencyColumn(column) || isHourColumn(column) ? 'text-right whitespace-nowrap' : 'whitespace-normal break-words'}
                          >
                            {column}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {section.items.map((item: any) => (
                        <TableRow key={item.id} className="text-xs">
                          {section.columns.map((column: string) => (
                            <TableCell
                              key={`${item.id}-${column}`}
                              className={isCurrencyColumn(column) || isHourColumn(column) ? 'text-right whitespace-nowrap' : 'whitespace-normal break-words'}
                            >
                              {formatBudgetCellDisplay(column, item)}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function MonthlyStatementServiceSortButton({
  label,
  sortKey,
  serviceSortBy,
  serviceSortOrder,
  setServiceSortBy,
  setServiceSortOrder,
  fetchServiceItems,
  servicePagination,
}: {
  label: string;
  sortKey: string;
  serviceSortBy: string;
  serviceSortOrder: string;
  setServiceSortBy: (value: string) => void;
  setServiceSortOrder: (value: string) => void;
  fetchServiceItems: (...args: any[]) => void;
  servicePagination: { limit: number };
}) {
  const isActive = serviceSortBy === sortKey;
  const nextOrder = isActive && serviceSortOrder === 'asc' ? 'desc' : 'asc';

  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 hover:text-foreground ${isActive ? 'text-red-600' : 'text-muted-foreground'}`}
      onClick={() => {
        setServiceSortBy(sortKey);
        setServiceSortOrder(nextOrder);
        fetchServiceItems(1, servicePagination.limit, sortKey, nextOrder);
      }}
    >
      {label}
      {isActive ? (serviceSortOrder === 'asc' ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />) : <ArrowUpDown className="h-3.5 w-3.5 shrink-0" />}
    </button>
  );
}

function MonthlyStatementServiceRecordsSection(props: Record<string, any>) {
  const {
    statementData, loadingServiceItems, serviceTransactionStatusFilter, setServiceTransactionStatusFilter,
    fetchServiceItems, servicePagination, serviceSortBy, serviceSortOrder, setServiceSortBy, setServiceSortOrder,
    serviceFundingSourceFilter, setServiceFundingSourceFilter, distinctTransactionStatuses, distinctFundingSources,
    handleServiceExportCSV, exportingSection, serviceItems, handleServicePageChange, serviceTotalPages,
    formatDate, formatCurrency, getServiceProviderLabel, sanitizeNotesHtml,
  } = props;

  return (
    <Card className="shadow-lg print:shadow-none">
      <div className="p-6 border-b">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-xl font-semibold">Service Records</h3>
            <p className="text-sm text-muted-foreground">
              The services scheduled for the participants and their status
            </p>
          </div>
          <div className="print:hidden flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="transaction-status-filter" className="text-sm whitespace-nowrap">Transaction Status</Label>
              <Select
                value={serviceTransactionStatusFilter}
                onValueChange={(value) => {
                  setServiceTransactionStatusFilter(value);
                  fetchServiceItems(1, servicePagination.limit, serviceSortBy, serviceSortOrder, value, serviceFundingSourceFilter);
                }}
                disabled={!statementData || loadingServiceItems}
              >
                <SelectTrigger id="transaction-status-filter" className="w-[220px]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {distinctTransactionStatuses.map((status: string) => (
                    <SelectItem key={status} value={status}>{status}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="funding-source-filter" className="text-sm whitespace-nowrap">Funding Source</Label>
              <Select
                value={serviceFundingSourceFilter}
                onValueChange={(value) => {
                  setServiceFundingSourceFilter(value);
                  fetchServiceItems(1, servicePagination.limit, serviceSortBy, serviceSortOrder, serviceTransactionStatusFilter, value);
                }}
                disabled={!statementData || loadingServiceItems}
              >
                <SelectTrigger id="funding-source-filter" className="w-[220px]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {distinctFundingSources.map((source: string) => (
                    <SelectItem key={source} value={source}>{source}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={handleServiceExportCSV}
              disabled={!statementData || exportingSection === 'service-csv'}
            >
              <FileSpreadsheet className="h-4 w-4" />
              Export CSV
            </Button>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        {loadingServiceItems ? (
          <div className="p-6 text-center"><Spinner /></div>
        ) : serviceItems.length > 0 ? (
          <Table className="text-sm">
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">Participant</TableHead>
                <TableHead className="whitespace-nowrap">Service</TableHead>
                <TableHead className="whitespace-nowrap">Service Provider</TableHead>
                <TableHead className="whitespace-nowrap">
                  <MonthlyStatementServiceSortButton label="Scheduled Service Date" sortKey="scheduledServiceDate" serviceSortBy={serviceSortBy} serviceSortOrder={serviceSortOrder} setServiceSortBy={setServiceSortBy} setServiceSortOrder={setServiceSortOrder} fetchServiceItems={fetchServiceItems} servicePagination={servicePagination} />
                </TableHead>
                <TableHead className="whitespace-nowrap">
                  <MonthlyStatementServiceSortButton label="Service Delivery Date" sortKey="serviceDeliveryDate" serviceSortBy={serviceSortBy} serviceSortOrder={serviceSortOrder} setServiceSortBy={setServiceSortBy} setServiceSortOrder={setServiceSortOrder} fetchServiceItems={fetchServiceItems} servicePagination={servicePagination} />
                </TableHead>
                <TableHead className="whitespace-nowrap">Transaction Status</TableHead>
                <TableHead className="whitespace-nowrap">Committed AT-HM for Delivery</TableHead>
                <TableHead className="whitespace-nowrap">Unit</TableHead>
                <TableHead className="text-right whitespace-nowrap">Quantity</TableHead>
                <TableHead className="text-right whitespace-nowrap">Unit Price ($)</TableHead>
                <TableHead className="text-right whitespace-nowrap">Total Amount ($)</TableHead>
                <TableHead className="text-right whitespace-nowrap">Gov Subsidy ($)</TableHead>
                <TableHead className="text-right whitespace-nowrap">Participant Contribution ($)</TableHead>
                <TableHead>Funding Source</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {serviceItems.map((service: MonthlyStatementServiceRecord) => (
                <MonthlyStatementServiceRow
                  key={service.id}
                  service={service}
                  formatDate={formatDate}
                  formatCurrency={formatCurrency}
                  getServiceProviderLabel={getServiceProviderLabel}
                  sanitizeNotesHtml={sanitizeNotesHtml}
                />
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="p-6 text-center text-muted-foreground">
            <AlertCircle className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p>No service records found for the selected period</p>
          </div>
        )}
      </div>
      {!loadingServiceItems && serviceItems.length > 0 && (
        <div className="mt-6">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => handleServicePageChange(servicePagination.page - 1)}
                  className={servicePagination.page === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                />
              </PaginationItem>
              {Array.from({ length: serviceTotalPages }, (_, i) => i + 1)
                .filter((page) =>
                  page === 1 ||
                  page === serviceTotalPages ||
                  (page >= servicePagination.page - 1 && page <= servicePagination.page + 1)
                )
                .map((page, index, arr) => (
                  <div key={`service-pagination-${page}`} className="flex">
                    {index > 0 && arr[index - 1] !== page - 1 && (
                      <PaginationItem><PaginationEllipsis /></PaginationItem>
                    )}
                    <PaginationItem>
                      <PaginationLink
                        onClick={() => handleServicePageChange(page)}
                        isActive={servicePagination.page === page}
                      >
                        {page}
                      </PaginationLink>
                    </PaginationItem>
                  </div>
                ))}
              <PaginationItem>
                <PaginationNext
                  onClick={() => handleServicePageChange(servicePagination.page + 1)}
                  className={servicePagination.page === serviceTotalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </Card>
  );
}

function MonthlyStatementSummaryFooter({ statementData, formatCurrency }: Record<string, any>) {
  return (
    <Card className="p-6 shadow-lg print:shadow-none print:break-inside-avoid">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-base font-semibold leading-none">Statement summary</h3>
          <p className="text-sm text-muted-foreground">
            Key figures for {statementData.month} {statementData.year}
          </p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4 print:bg-transparent">
          <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary print:bg-transparent">
            <Calendar className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Statement period</p>
            <p className="truncate text-sm font-semibold tabular-nums">{statementData.month} {statementData.year}</p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4 print:bg-transparent">
          <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary print:bg-transparent">
            <FileCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Generated</p>
            <p className="truncate text-sm font-semibold tabular-nums">{format(new Date(), 'dd/MM/yyyy')}</p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4 print:bg-transparent">
          <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary print:bg-transparent">
            <FileText className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Total services</p>
            <p className="truncate text-sm font-semibold tabular-nums">{statementData.summary.totalServices} services</p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4 print:bg-transparent">
          <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary print:bg-transparent">
            <FileSpreadsheet className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Government subsidy</p>
            <p className="truncate text-sm font-semibold tabular-nums">{formatCurrency(statementData.summary.govSubsidy)}</p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4 print:bg-transparent">
          <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary print:bg-transparent">
            <User className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Participant contribution</p>
            <p className="truncate text-sm font-semibold tabular-nums">{formatCurrency(statementData.summary.participantContribution)}</p>
          </div>
        </div>
      </div>
    </Card>
  );
}

export function MonthlyStatementStatementPanel(props: Record<string, any>) {
  const { statementData, businessDetails, loading, exportingSection, handleSaHMonthlyStatement } = props;

  if (!statementData) {
    return null;
  }

  return (
    <div className="space-y-6">
      <Card className="p-6 shadow-lg print:shadow-none">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-2xl font-bold mb-2">Support at Home Monthly Statement</h2>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Calendar className="h-4 w-4" />
                <span className="font-medium">{statementData.month} {statementData.year}</span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <User className="h-4 w-4" />
                <span className="font-medium">{statementData.participant}</span>
              </div>
            </div>
          </div>
          <div className="print:hidden">
            <Button
              className="gap-2"
              onClick={handleSaHMonthlyStatement}
              disabled={!statementData || exportingSection === 'statement-pdf' || loading}
            >
              {exportingSection === 'statement-pdf' ? (
                <><Spinner className="h-4 w-4" />Generating...</>
              ) : (
                <><FileCheck className="h-4 w-4" />Generate Monthly Statement</>
              )}
            </Button>
          </div>
        </div>
        {businessDetails.companyName && (
          <div className="mt-4 p-4 bg-muted/30 rounded-lg">
            <h3 className="font-semibold mb-2">Service Provider Details</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><span className="font-medium">Company:</span> {businessDetails.companyName}</div>
              <div><span className="font-medium">Phone:</span> {businessDetails.phoneNumber}</div>
              <div><span className="font-medium">Email:</span> {businessDetails.businessEmail}</div>
              <div><span className="font-medium">Address:</span> {businessDetails.address}</div>
              <div className="col-span-2"><span className="font-medium">Registration ID:</span> {businessDetails.companyRegistrationId || "N/A"}</div>
            </div>
          </div>
        )}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs uppercase tracking-wide">Participant Address</p>
            <p className="font-medium text-foreground">{statementData.participantAddress || 'Not provided'}</p>
            <p className="text-muted-foreground">
              {[statementData.participantSuburb, statementData.participantState, statementData.participantPostcode]
                .filter(Boolean)
                .join(', ') || '—'}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs uppercase tracking-wide">Identifiers</p>
            <p className="font-medium">My Aged Care ID</p>
            <p className="text-muted-foreground">{statementData.myAgedCareIdNumber || 'Not provided'}</p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs uppercase tracking-wide">Provider ID</p>
            <p className="font-medium text-foreground">{statementData.providerId || 'Not provided'}</p>
          </div>
        </div>
      </Card>
      <MonthlyStatementBudgetChartsSection {...props} />
      <MonthlyStatementBudgetSections {...props} />
      <MonthlyStatementServiceRecordsSection {...props} />
      <MonthlyStatementSummaryFooter {...props} />
    </div>
  );
}
