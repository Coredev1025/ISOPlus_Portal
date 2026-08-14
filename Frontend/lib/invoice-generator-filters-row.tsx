'use client';

import { Search, Filter } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { TRANSACTION_STATUS_FILTERS, applyExclusiveInvoiceDateRange } from "@/lib/invoice-generator-helpers";
import type { DateRange } from "react-day-picker";


export function InvoiceGeneratorFiltersRow(props: {
  isNdisBoard: boolean;
  participantFilter: string;
  setParticipantFilter: (v: string) => void;
  uniqueParticipants: string[];
  scheduledServiceDateRange?: DateRange;
  setScheduledServiceDateRange: (v: DateRange | undefined) => void;
  serviceDeliveryDateRange?: DateRange;
  setServiceDeliveryDateRange: (v: DateRange | undefined) => void;
  transactionStatusFilter: string;
  setTransactionStatusFilter: (v: string) => void;
  jobStatusFilter: string;
  setJobStatusFilter: (v: string) => void;
  ndisStatusFieldLabel: string;
  paymentStatusFilter: string;
  setPaymentStatusFilter: (v: string) => void;
  ndisPaymentStatusOptions: string[];
  paymentStatusFilters: Array<{ value: string; label: string }>;
}) {
  const {
    isNdisBoard,
    participantFilter, setParticipantFilter, uniqueParticipants,
    scheduledServiceDateRange, setScheduledServiceDateRange,
    serviceDeliveryDateRange, setServiceDeliveryDateRange,
    transactionStatusFilter, setTransactionStatusFilter,
    jobStatusFilter, setJobStatusFilter, ndisStatusFieldLabel,
    paymentStatusFilter, setPaymentStatusFilter,
    ndisPaymentStatusOptions, paymentStatusFilters,
  } = props;

  return (
    <div className="mb-6 flex flex-nowrap gap-3 overflow-x-auto rounded-lg border border-border/50 bg-muted/20 p-3">
      <div className="w-fit flex-shrink-0">
        <Select value={participantFilter} onValueChange={setParticipantFilter}>
          <SelectTrigger className="w-full">
            <div className="flex min-w-0 w-full items-center gap-2">
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

      <DateRangePicker
        label="Scheduled Service Date"
        value={scheduledServiceDateRange}
        onChange={(range) => {
          const next = applyExclusiveInvoiceDateRange('scheduled', range, {
            scheduledServiceDateRange,
            serviceDeliveryDateRange,
          });
          setScheduledServiceDateRange(next.scheduledServiceDateRange);
          setServiceDeliveryDateRange(next.serviceDeliveryDateRange);
        }}
      />

      <DateRangePicker
        label="Service Delivery Date"
        value={serviceDeliveryDateRange}
        onChange={(range) => {
          const next = applyExclusiveInvoiceDateRange('serviceDelivery', range, {
            scheduledServiceDateRange,
            serviceDeliveryDateRange,
          });
          setScheduledServiceDateRange(next.scheduledServiceDateRange);
          setServiceDeliveryDateRange(next.serviceDeliveryDateRange);
        }}
      />

      {!isNdisBoard && (
        <Select value={transactionStatusFilter} onValueChange={setTransactionStatusFilter}>
          <SelectTrigger className="w-fit min-w-[220px] flex-shrink-0">
            <div className="flex min-w-0 w-full items-center gap-2">
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
      )}

      {isNdisBoard && (
        <Select value={jobStatusFilter} onValueChange={setJobStatusFilter}>
          <SelectTrigger className="w-fit min-w-[180px] flex-shrink-0">
            <div className="flex min-w-0 w-full items-center gap-2">
              <Filter className="h-4 w-4 flex-shrink-0" />
              <SelectValue placeholder={ndisStatusFieldLabel} className="truncate" />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All {ndisStatusFieldLabel}</SelectItem>
            <SelectItem value="Scheduled">Scheduled</SelectItem>
            <SelectItem value="Completed">Completed</SelectItem>
            <SelectItem value="Cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      )}

      <Select value={paymentStatusFilter} onValueChange={setPaymentStatusFilter}>
        <SelectTrigger className="w-fit flex-shrink-0">
          <div className="flex min-w-0 w-full items-center gap-2">
            <Filter className="h-4 w-4 flex-shrink-0" />
            <SelectValue placeholder="Payment Status" className="truncate" />
          </div>
        </SelectTrigger>
        <SelectContent>
          {isNdisBoard ? (
            <>
              <SelectItem value="all">All Payment Status</SelectItem>
              {ndisPaymentStatusOptions.map((status) => (
                <SelectItem key={status} value={status}>
                  {status}
                </SelectItem>
              ))}
            </>
          ) : (
            paymentStatusFilters.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
