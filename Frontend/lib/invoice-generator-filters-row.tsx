'use client';

import { Button } from "@/components/ui/button";
import { Search, Calendar, Filter, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { format } from "date-fns";
import { TRANSACTION_STATUS_FILTERS } from "@/lib/invoice-generator-helpers";
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
            <div className="flex flex-nowrap gap-4 mb-6 overflow-x-auto p-2">
              <div className="w-fit flex-shrink-0">
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
                  <Button variant="outline" className="w-fit justify-start text-left font-normal flex-shrink-0">
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
                  <Button variant="outline" className="w-fit justify-start text-left font-normal flex-shrink-0">
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

              {!isNdisBoard && (
                <Select value={transactionStatusFilter} onValueChange={setTransactionStatusFilter}>
                  <SelectTrigger className="w-fit flex-shrink-0 min-w-[220px]">
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
              )}

              {isNdisBoard && (
                <Select value={jobStatusFilter} onValueChange={setJobStatusFilter}>
                  <SelectTrigger className="w-fit flex-shrink-0 min-w-[180px]">
                    <div className="flex items-center gap-2 min-w-0 w-full">
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
                  <div className="flex items-center gap-2 min-w-0 w-full">
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
