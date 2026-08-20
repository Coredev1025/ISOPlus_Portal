import type { DateRange } from 'react-day-picker';
import { isCareManagementLabel } from '@/lib/access';
import { formatDateOnlyYYYYMMDD } from '@/lib/timezone';

export const TRANSACTION_STATUS_FILTERS = [
  { value: 'all', label: 'All Transaction Status', isoValue: '' },
  { value: 'delivered', label: 'Delivered - To be claimed and invoiced.', description: 'To be claimed and invoiced.', isoValue: 'Delivered - To be claimed and invoiced.' },
  { value: 'cancelled', label: 'Cancelled - To be claimed and invoiced if applicable.', description: 'To be claimed and invoiced if applicable.', isoValue: 'Cancelled - To be claimed and invoiced if applicable.' },
  { value: 'adjustment-refund', label: 'Adjustment (Refund) - To be claimed and invoiced.', description: 'To be claimed and invoiced.', isoValue: 'Adjustment (Refund) - To be claimed and invoiced.' },
  { value: 'adjustment-charge', label: 'Adjustment (Charge) - To be claimed and invoiced.', description: 'To be claimed and invoiced.', isoValue: 'Adjustment (Charge) - To be claimed and invoiced.' },
];

export function getTransactionStatusSearchValue(filterValue: string) {
  return TRANSACTION_STATUS_FILTERS.find((option) => option.value === filterValue)?.isoValue || '';
}

const FUNDING_SOURCE_CODE_MAP: Record<string, string> = {
  'Home Support(HS) Quarterly': 'ON',
  'Home Support Care Management': 'CM',
  'Restorative Care Pathway': 'RC',
  'Assistive Technology - Short-term': 'AT',
  'End-of-Life Pathway': 'EL',
  'Assistive Technology': 'AT',
  'Assistive Technology - Ongoing': 'AS',
  'Home Modification': 'HM',
  'Primary Supplements': 'PS',
  'Unspent Home Care Package (HCP) Funds': 'HCP',
};

export function getFundingSourceCode(fundingSource?: string) {
  if (!fundingSource) {
    return '';
  }

  const fundingSourceLower = fundingSource.toLowerCase();

  for (const [key, code] of Object.entries(FUNDING_SOURCE_CODE_MAP)) {
    if (fundingSourceLower.includes(key.toLowerCase())) {
      return code;
    }
  }

  if (fundingSourceLower.includes('primary supplement')) {
    return 'PS';
  }
  if (
    fundingSourceLower.includes('unspent home care package') ||
    fundingSourceLower.includes('hcp fund') ||
    fundingSourceLower.includes('home care package')
  ) {
    return 'HCP';
  }

  return fundingSource.substring(0, 4).toUpperCase();
}

export function formatDateForCsvExport(dateString: string | null | undefined, businessTimezone: string) {
  if (!dateString) {
    return '';
  }
  return formatDateOnlyYYYYMMDD(dateString, businessTimezone);
}

export function formatNumberForCsvExport(value: number | string | undefined | null) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(numeric)) {
    return '';
  }
  return numeric.toFixed(2);
}

export type InvoiceGeneratorFilterParams = {
  statusFilter: string;
  participantFilter: string;
  transactionStatusFilter: string;
  paymentStatusFilter: string;
  jobStatusFilter: string;
  isNdisBoard: boolean;
  scheduledServiceDateRange?: DateRange;
  serviceDeliveryDateRange?: DateRange;
  sortBy: string;
  sortOrder: string;
  currentPage: number;
  itemsPerPage: number;
  businessTimezone: string;
  getTransactionStatusSearchValue: (filter: string) => string | null | undefined;
  dateToStartOfDayISO: (date: Date, timezone: string) => string;
  dateToEndOfDayISO: (date: Date, timezone: string) => string;
};

export function exclusiveInvoiceGeneratorDateRanges(
  scheduledServiceDateRange?: DateRange,
  serviceDeliveryDateRange?: DateRange,
) {
  if (scheduledServiceDateRange?.from && serviceDeliveryDateRange?.from) {
    return {
      scheduledServiceDateRange: undefined,
      serviceDeliveryDateRange,
    };
  }
  return { scheduledServiceDateRange, serviceDeliveryDateRange };
}

export function applyExclusiveInvoiceDateRange(
  field: 'scheduled' | 'serviceDelivery',
  range: DateRange | undefined,
  current: {
    scheduledServiceDateRange?: DateRange;
    serviceDeliveryDateRange?: DateRange;
  },
) {
  if (!range?.from) {
    return field === 'scheduled'
      ? { scheduledServiceDateRange: range, serviceDeliveryDateRange: current.serviceDeliveryDateRange }
      : { scheduledServiceDateRange: current.scheduledServiceDateRange, serviceDeliveryDateRange: range };
  }
  if (field === 'scheduled') {
    return { scheduledServiceDateRange: range, serviceDeliveryDateRange: undefined };
  }
  return { scheduledServiceDateRange: undefined, serviceDeliveryDateRange: range };
}

/**
 * Appends the four date-range params both the search and the CSV export send.
 * The date functions are arguments rather than imports because
 * `buildInvoiceGeneratorSearchParams` receives them on `InvoiceGeneratorFilterParams`
 * and its callers substitute them; `invoice-generator-export-helpers.ts` passes
 * the real ones from `@/lib/timezone`.
 */
export function appendDateRangeParams(
  params: URLSearchParams,
  scheduledServiceDateRange: DateRange | undefined,
  serviceDeliveryDateRange: DateRange | undefined,
  dateToStartOfDayISO: (date: Date, timezone: string) => string,
  dateToEndOfDayISO: (date: Date, timezone: string) => string,
  businessTimezone: string,
) {
  const exclusive = exclusiveInvoiceGeneratorDateRanges(
    scheduledServiceDateRange,
    serviceDeliveryDateRange,
  );
  if (exclusive.scheduledServiceDateRange?.from) {
    params.append(
      'startDate',
      dateToStartOfDayISO(new Date(exclusive.scheduledServiceDateRange.from), businessTimezone),
    );
  }
  if (exclusive.scheduledServiceDateRange?.to || exclusive.scheduledServiceDateRange?.from) {
    const toSource = exclusive.scheduledServiceDateRange?.to || exclusive.scheduledServiceDateRange?.from;
    params.append(
      'endDate',
      dateToEndOfDayISO(new Date(toSource as Date), businessTimezone),
    );
  }
  if (exclusive.serviceDeliveryDateRange?.from) {
    params.append(
      'serviceDeliveryStart',
      dateToStartOfDayISO(new Date(exclusive.serviceDeliveryDateRange.from), businessTimezone),
    );
  }
  if (exclusive.serviceDeliveryDateRange?.to || exclusive.serviceDeliveryDateRange?.from) {
    const toSource = exclusive.serviceDeliveryDateRange?.to || exclusive.serviceDeliveryDateRange?.from;
    params.append(
      'serviceDeliveryEnd',
      dateToEndOfDayISO(new Date(toSource as Date), businessTimezone),
    );
  }
}

export function buildInvoiceGeneratorSearchParams(filters: InvoiceGeneratorFilterParams): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.statusFilter !== 'all') {
    params.append('status', filters.statusFilter);
  }
  if (filters.participantFilter && filters.participantFilter !== 'all') {
    params.append('participant', filters.participantFilter);
  }

  const transactionStatusParam = filters.getTransactionStatusSearchValue(filters.transactionStatusFilter);
  if (transactionStatusParam) {
    params.append('transactionStatus', transactionStatusParam);
  }

  if (filters.paymentStatusFilter !== 'all') {
    params.append('paymentStatus', filters.paymentStatusFilter);
  }
  if (filters.isNdisBoard && filters.jobStatusFilter !== 'all') {
    params.append('jobStatus', filters.jobStatusFilter);
  }

  appendDateRangeParams(
    params,
    filters.scheduledServiceDateRange,
    filters.serviceDeliveryDateRange,
    filters.dateToStartOfDayISO,
    filters.dateToEndOfDayISO,
    filters.businessTimezone,
  );

  params.append('sortBy', filters.sortBy);
  params.append('sortOrder', filters.sortOrder);
  params.append('page', filters.currentPage.toString());
  params.append('limit', filters.itemsPerPage.toString());

  return params;
}

export function validateInvoiceGenerationInputs(
  selectedCount: number,
  invoiceDate: string,
  dueDate: string,
): string | null {
  if (!selectedCount) return 'Please select at least one item to include in the invoice.';
  if (!invoiceDate) return 'Please enter an invoice date.';
  if (!dueDate) return 'Please enter a due date.';
  return null;
}

export function buildInvoiceItemIds<T extends { id: string; sourceItemId?: string }>(
  selectedRecords: T[],
  isNdisBoard: boolean,
): string[] {
  if (isNdisBoard) {
    return Array.from(
      new Set(
        selectedRecords
          .map((r) => (r?.sourceItemId || String(r?.id || '')).toString().split(':')[0])
          .filter(Boolean),
      ),
    );
  }
  return selectedRecords.map((record) => record.id);
}

export function getInvoiceGeneratorBoardFlags(boardLabel: string) {
  const isLowCatBoard = boardLabel === 'Care Management - SaH - Low Cat';
  const isCareManagementBoard = isCareManagementLabel(boardLabel);
  const isNdisBoard = typeof boardLabel === 'string' && boardLabel.toLowerCase().includes('ndis');
  const isNdisCertificationOrVerificationBoard =
    boardLabel === 'Care Management - NDIS - Certification' ||
    boardLabel === 'Care Management - NDIS - Verification';

  return {
    isLowCatBoard,
    isCareManagementBoard,
    isNdisBoard,
    isNdisCertificationOrVerificationBoard,
  };
}
