import type { AxiosInstance } from 'axios';
import type { DateRange } from 'react-day-picker';
import {
  getFundingSourceCode,
  getTransactionStatusSearchValue,
  formatDateForCsvExport,
  formatNumberForCsvExport,
} from '@/lib/invoice-generator-helpers';
import { dateToStartOfDayISO, dateToEndOfDayISO } from '@/lib/timezone';

type ServiceRecord = {
  id: string;
  careRecipientIdentifier?: string;
  serviceIdentifier?: string;
  serviceDeliveryDate?: string | null;
  unit?: string;
  quantity?: number;
  unitPrice?: number;
  fundingSource?: string;
  deliveredByThirdParty?: string;
  itemOrWraparound?: string;
  itemDescriptionCode?: string;
  itemDescription?: string;
  wraparoundDescriptionCode?: string;
  wraparoundDescription?: string;
  prescribedItem?: string;
  itemPurchasedMethod?: string;
  loanedByOrganisationName?: string;
  loanedByInvoiceNumber?: string;
  healthProfessionalTypeCode?: string;
  healthProfessionalTypeOther?: string;
  itemFirstPayment?: string;
};

type ToastFns = {
  showSuccessToast: (message: string, options?: { description?: string }) => void;
  showErrorToast: (message: string, options?: { description?: string }) => void;
  showWarningToast: (message: string, options?: { description?: string }) => void;
};

function escapeForCsv(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const stringValue = String(value).replace(/"/g, '""');
  return `"${stringValue}"`;
}

function downloadCsvBlob(blob: Blob, fileName: string) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 100);
}

function buildTimestampedFileName(prefix: string, participantFilter: string) {
  const uniqueCode = Math.random().toString(36).substring(2, 7).toUpperCase();
  const currentDate = new Date();
  const timestamp = `${currentDate.getFullYear().toString().slice(2)}${(currentDate.getMonth() + 1).toString().padStart(2, '0')}${currentDate.getDate().toString().padStart(2, '0')}${currentDate.getHours().toString().padStart(2, '0')}${currentDate.getMinutes().toString().padStart(2, '0')}${currentDate.getSeconds().toString().padStart(2, '0')}`;
  const participantName = participantFilter && participantFilter !== 'all' ? participantFilter : '(Multiple)';
  return `${prefix}~${timestamp}~${participantName}~${uniqueCode}.csv`;
}

function appendDateRangeParams(
  params: URLSearchParams,
  scheduledServiceDateRange: DateRange | undefined,
  serviceDeliveryDateRange: DateRange | undefined,
  businessTimezone: string,
) {
  if (scheduledServiceDateRange?.from) {
    params.append('startDate', dateToStartOfDayISO(new Date(scheduledServiceDateRange.from), businessTimezone));
  }
  if (scheduledServiceDateRange?.to || scheduledServiceDateRange?.from) {
    const toSource = scheduledServiceDateRange?.to || scheduledServiceDateRange?.from;
    params.append('endDate', dateToEndOfDayISO(new Date(toSource as Date), businessTimezone));
  }
  if (serviceDeliveryDateRange?.from) {
    params.append('serviceDeliveryStart', dateToStartOfDayISO(new Date(serviceDeliveryDateRange.from), businessTimezone));
  }
  if (serviceDeliveryDateRange?.to || serviceDeliveryDateRange?.from) {
    const toSource = serviceDeliveryDateRange?.to || serviceDeliveryDateRange?.from;
    params.append('serviceDeliveryEnd', dateToEndOfDayISO(new Date(toSource as Date), businessTimezone));
  }
}

async function exportNdisCsv(options: {
  axios: AxiosInstance;
  id: string;
  boardId: string;
  participantFilter: string;
  scheduledServiceDateRange?: DateRange;
  serviceDeliveryDateRange?: DateRange;
  paymentStatusFilter: string;
  jobStatusFilter: string;
  sortBy: string;
  sortOrder: string;
  businessTimezone: string;
  toasts: ToastFns;
}) {
  const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/export/${options.id}/${options.boardId}/invoice-csv-ndis`;
  const params = new URLSearchParams();

  if (options.participantFilter && options.participantFilter !== 'all') {
    params.append('participant', options.participantFilter);
  }
  appendDateRangeParams(params, options.scheduledServiceDateRange, options.serviceDeliveryDateRange, options.businessTimezone);

  if (options.paymentStatusFilter !== 'all') {
    params.append('paymentStatus', options.paymentStatusFilter);
  }
  if (options.jobStatusFilter !== 'all') {
    params.append('jobStatus', options.jobStatusFilter);
  }

  params.append('sortBy', options.sortBy);
  params.append('sortOrder', options.sortOrder);
  params.append('limit', 'all');

  const response = await options.axios.get(apiUrl, {
    params: Object.fromEntries(params),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  });

  const allItems: Array<Record<string, unknown>> = response.data?.items || [];
  const skippedCount: number = response.data?.skippedCount || 0;
  const exportDuration = response.data?.exportDurationMs;

  if (skippedCount > 0) {
    options.toasts.showWarningToast(`${skippedCount} record${skippedCount === 1 ? '' : 's'} were skipped because required data was missing.`);
  }
  if (allItems.length === 0) {
    options.toasts.showErrorToast('No records to export.');
    return { exported: false as const };
  }

  const csvHeaders = [
    'RegistrationNumber',
    'NDISNumber',
    'SupportDeliveredFrom',
    'SupportDeliveredTo',
    'SupportNumber',
    'ClaimReference',
    'Quantity',
    'Hours',
    'UnitPrice',
    'GSTCode',
    'ClaimType',
    'CancellationReason',
    'ABN of Support Provider',
  ];

  const csvRows: string[] = [csvHeaders.join(',')];
  allItems.forEach((row) => {
    csvRows.push(csvHeaders.map((h) => escapeForCsv((row as Record<string, unknown>)[h])).join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  downloadCsvBlob(blob, buildTimestampedFileName('NDIS_CLAIM', options.participantFilter));

  const durationText = exportDuration ? ` (${(exportDuration / 1000).toFixed(1)}s)` : '';
  options.toasts.showSuccessToast(`Successfully exported ${allItems.length} records to CSV${durationText}.`);
  return { exported: true as const };
}

function buildStandardCsvRow(item: ServiceRecord, businessTimezone: string) {
  const invoiceNumber = item.id;
  const careRecipientIdentifier = item.careRecipientIdentifier || '';
  let serviceIdentifier = item.serviceIdentifier || '';
  if (serviceIdentifier.includes('/')) {
    serviceIdentifier = serviceIdentifier.split('/')[0].trim();
  }

  const deliveredByThirdParty = item.deliveredByThirdParty || '';
  const itemOrWraparound = item.itemOrWraparound || '';

  let itemDescriptionCode = '';
  let itemDescription = '';
  if (itemOrWraparound === 'Item') {
    itemDescriptionCode = item.itemDescriptionCode || '';
    itemDescription = item.itemDescription || '';
  }

  let wraparoundDescriptionCode = '';
  let wraparoundDescription = '';
  if (itemOrWraparound === 'Wraparound') {
    wraparoundDescriptionCode = item.wraparoundDescriptionCode || '';
    wraparoundDescription = item.wraparoundDescription || '';
  }

  const prescribedItem = item.prescribedItem || 'N';
  const purchasedMethodType = item.itemPurchasedMethod || '';
  const loanedByOrganisationName = purchasedMethodType === 'LOANED' ? (item.loanedByOrganisationName || '') : '';
  const loanedByInvoiceNumber = purchasedMethodType === 'LOANED' ? (item.loanedByInvoiceNumber || '') : '';
  const healthProfessionalTypeCode = item.healthProfessionalTypeCode || '';
  const healthProfessionalTypeOther = item.healthProfessionalTypeOther || '';
  const serviceDeliveryDateCsv = formatDateForCsvExport(item.serviceDeliveryDate, businessTimezone);
  const fundingSourceCode = getFundingSourceCode(item.fundingSource);
  const itemFirstPayment = item.itemFirstPayment || 'False';

  return [
    escapeForCsv(invoiceNumber),
    escapeForCsv(careRecipientIdentifier),
    escapeForCsv(serviceIdentifier),
    escapeForCsv(serviceDeliveryDateCsv),
    escapeForCsv(item.unit || ''),
    escapeForCsv(item.quantity ?? ''),
    escapeForCsv(formatNumberForCsvExport(item.unitPrice)),
    escapeForCsv(fundingSourceCode || ''),
    escapeForCsv(deliveredByThirdParty),
    escapeForCsv(itemOrWraparound),
    escapeForCsv(itemDescriptionCode),
    escapeForCsv(itemDescription),
    escapeForCsv(wraparoundDescriptionCode),
    escapeForCsv(wraparoundDescription),
    escapeForCsv(prescribedItem),
    escapeForCsv(purchasedMethodType),
    escapeForCsv(loanedByOrganisationName),
    escapeForCsv(loanedByInvoiceNumber),
    escapeForCsv(healthProfessionalTypeCode),
    escapeForCsv(healthProfessionalTypeOther),
    escapeForCsv(itemFirstPayment),
  ].join(',');
}

async function exportStandardCsv(options: {
  axios: AxiosInstance;
  id: string;
  boardId: string;
  participantFilter: string;
  scheduledServiceDateRange?: DateRange;
  serviceDeliveryDateRange?: DateRange;
  transactionStatusFilter: string;
  paymentStatusFilter: string;
  sortBy: string;
  sortOrder: string;
  businessTimezone: string;
  toasts: ToastFns;
}) {
  const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/export/${options.id}/${options.boardId}/invoice-csv`;
  const params = new URLSearchParams();

  if (options.participantFilter && options.participantFilter !== 'all') {
    params.append('participant', options.participantFilter);
  }
  appendDateRangeParams(params, options.scheduledServiceDateRange, options.serviceDeliveryDateRange, options.businessTimezone);

  const transactionStatusParam = getTransactionStatusSearchValue(options.transactionStatusFilter);
  if (transactionStatusParam) {
    params.append('transactionStatus', transactionStatusParam);
  }
  if (options.paymentStatusFilter !== 'all') {
    params.append('paymentStatus', options.paymentStatusFilter);
  }

  params.append('sortBy', options.sortBy);
  params.append('sortOrder', options.sortOrder);
  params.append('limit', 'all');

  const response = await options.axios.get(apiUrl, {
    params: Object.fromEntries(params),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  });

  const allItems: ServiceRecord[] = response.data?.items || [];
  const exportDuration = response.data?.exportDurationMs;

  if (allItems.length === 0) {
    options.toasts.showErrorToast('No records to export.');
    return { exported: false as const };
  }

  const csvHeaders = [
    'Item External Reference Identifier',
    'Care Recipient Identifier',
    'Service Identifier',
    'Delivery Date',
    'Unit Type',
    'Quantity',
    'Price Per Unit',
    'Funding Source',
    'Delivered By Third Party',
    'Item or Wraparound',
    'Item Description Code',
    'Item Description',
    'Wraparound Description Code',
    'Wraparound Description',
    'Prescribed Item',
    'Purchased Method Type',
    'Loaned by Organisation Name',
    'Loaned By Invoice Number',
    'Health Professional Type Code',
    'Health Professional Type Other',
    'Item First Payment',
  ];

  const csvRows: string[] = [csvHeaders.join(',')];
  allItems.forEach((item) => {
    csvRows.push(buildStandardCsvRow(item, options.businessTimezone));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  downloadCsvBlob(blob, buildTimestampedFileName('CLAIM', options.participantFilter));

  const durationText = exportDuration ? ` (${(exportDuration / 1000).toFixed(1)}s)` : '';
  options.toasts.showSuccessToast(`Successfully exported ${allItems.length} records to CSV${durationText}.`);
  return { exported: true as const };
}

export async function exportInvoiceGeneratorCsv(options: {
  axios: AxiosInstance;
  isNdisBoard: boolean;
  id: string;
  boardId: string;
  participantFilter: string;
  scheduledServiceDateRange?: DateRange;
  serviceDeliveryDateRange?: DateRange;
  transactionStatusFilter: string;
  paymentStatusFilter: string;
  jobStatusFilter: string;
  sortBy: string;
  sortOrder: string;
  businessTimezone: string;
  toasts: ToastFns;
}) {
  if (options.isNdisBoard) {
    return exportNdisCsv(options);
  }
  return exportStandardCsv(options);
}
