import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';

export type InvoiceGeneratorServiceRecord = {
  id: string;
  participant: string;
  scheduledServiceDate: string | null;
  serviceDeliveryDate?: string | null;
  jobStatus?: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  govSubsidy: number;
  participantContribution: number;
  notes: string;
  service: string;
  gst?: string;
  invoiceNumber?: string;
  transactionStatus?: string;
  paymentStatus?: string;
  fundingSource?: string;
  fileUrl?: string;
};

export type InvoiceGeneratorTableColumn = {
  key: string;
  label: string;
  className?: string;
  render: (record: InvoiceGeneratorServiceRecord) => ReactNode;
};

function renderPdfDownloadCell(
  record: InvoiceGeneratorServiceRecord,
  onDownload: (fileUrl: string, invoiceNumber?: string) => void,
) {
  if (!record.fileUrl) {
    return '-';
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 gap-2"
      onClick={() => onDownload(record.fileUrl!, record.invoiceNumber)}
      title="Download PDF Invoice"
    >
      <Download className="h-4 w-4" />
      {record.invoiceNumber ? `Invoice #${record.invoiceNumber}` : 'Download'}
    </Button>
  );
}

function renderNotesCell(notes: string, stripHtml: (value?: string) => string) {
  const cleanNotes = stripHtml(notes);
  if (!cleanNotes) {
    return '-';
  }
  return (
    <span title={cleanNotes} className="block max-h-12 overflow-hidden text-sm text-muted-foreground">
      {cleanNotes}
    </span>
  );
}

function buildNdisColumns(
  ndisStatusFieldLabel: string,
  formatDisplayDate: (dateString: string | null | undefined) => string,
  formatCurrency: (amount: number) => string,
  onDownloadPdf: (fileUrl: string, invoiceNumber?: string) => void,
): InvoiceGeneratorTableColumn[] {
  return [
    { key: 'participant', label: 'Participant Name', className: 'min-w-[200px]', render: (r) => r.participant || '-' },
    { key: 'service', label: 'Service', className: 'min-w-[260px]', render: (r) => r.service || '-' },
    { key: 'scheduledServiceDate', label: 'Scheduled Service Date', className: 'min-w-[220px]', render: (r) => formatDisplayDate(r.scheduledServiceDate) },
    { key: 'serviceDeliveryDate', label: 'Service Delivery Date', className: 'min-w-[220px]', render: (r) => formatDisplayDate(r.serviceDeliveryDate) },
    { key: 'jobStatus', label: ndisStatusFieldLabel, className: 'min-w-[160px]', render: (r) => r.jobStatus || '-' },
    { key: 'unit', label: 'Unit', className: 'min-w-[140px]', render: (r) => r.unit || '-' },
    { key: 'quantity', label: 'Quantity', className: 'min-w-[120px]', render: (r) => (typeof r.quantity === 'number' ? r.quantity : r.quantity ?? '-') },
    { key: 'unitPrice', label: 'Unit Price', className: 'min-w-[150px]', render: (r) => formatCurrency(r.unitPrice) },
    { key: 'gst', label: 'GST', className: 'min-w-[120px]', render: (r) => r.gst || 'GST Free' },
    { key: 'totalAmount', label: 'Total Amount', className: 'min-w-[150px]', render: (r) => formatCurrency(r.totalAmount) },
    { key: 'fileUrl', label: 'PDF Download', className: 'min-w-[140px]', render: (r) => renderPdfDownloadCell(r, onDownloadPdf) },
    { key: 'paymentStatus', label: 'Payment Status', className: 'min-w-[180px]', render: (r) => r.paymentStatus || '-' },
  ];
}

function buildLowCatColumns(
  formatDisplayDate: (dateString: string | null | undefined) => string,
  formatCurrency: (amount: number) => string,
  stripHtml: (value?: string) => string,
  onDownloadPdf: (fileUrl: string, invoiceNumber?: string) => void,
): InvoiceGeneratorTableColumn[] {
  return [
    { key: 'participant', label: 'Participant Name', className: 'min-w-[200px]', render: (r) => r.participant || '-' },
    { key: 'service', label: 'Service', className: 'min-w-[220px]', render: (r) => r.service || '-' },
    { key: 'scheduledServiceDate', label: 'Scheduled Service Date', className: 'min-w-[220px]', render: (r) => formatDisplayDate(r.scheduledServiceDate) },
    { key: 'serviceDeliveryDate', label: 'Service Delivery Date', className: 'min-w-[220px]', render: (r) => formatDisplayDate(r.serviceDeliveryDate) },
    { key: 'transactionStatus', label: 'Transaction Status', className: 'min-w-[220px]', render: (r) => r.transactionStatus || '-' },
    { key: 'unit', label: 'Unit', className: 'min-w-[140px]', render: (r) => r.unit || '-' },
    { key: 'quantity', label: 'Quantity', className: 'min-w-[120px]', render: (r) => (typeof r.quantity === 'number' ? r.quantity : r.quantity ?? '-') },
    { key: 'unitPrice', label: 'Unit Price', className: 'min-w-[150px]', render: (r) => formatCurrency(r.unitPrice) },
    { key: 'totalAmount', label: 'Total Amount', className: 'min-w-[150px]', render: (r) => formatCurrency(r.totalAmount) },
    { key: 'fundingSource', label: 'Funding Source', className: 'min-w-[200px]', render: (r) => r.fundingSource || '-' },
    { key: 'notes', label: 'Notes', className: 'min-w-[220px]', render: (r) => renderNotesCell(r.notes, stripHtml) },
    { key: 'fileUrl', label: 'PDF Download', className: 'min-w-[100px]', render: (r) => renderPdfDownloadCell(r, onDownloadPdf) },
    { key: 'paymentStatus', label: 'Payment Status', className: 'min-w-[180px]', render: (r) => r.paymentStatus || '-' },
  ];
}

function buildDefaultColumns(
  formatDisplayDate: (dateString: string | null | undefined) => string,
  formatCurrency: (amount: number) => string,
  stripHtml: (value?: string) => string,
  onDownloadPdf: (fileUrl: string, invoiceNumber?: string) => void,
): InvoiceGeneratorTableColumn[] {
  return [
    { key: 'participant', label: 'Participant', className: 'min-w-[200px]', render: (r) => r.participant || '-' },
    { key: 'service', label: 'Service', className: 'min-w-[220px]', render: (r) => r.service || '-' },
    { key: 'scheduledServiceDate', label: 'Scheduled Service Date', className: 'min-w-[220px]', render: (r) => formatDisplayDate(r.scheduledServiceDate) },
    { key: 'serviceDeliveryDate', label: 'Service Delivery Date', className: 'min-w-[220px]', render: (r) => formatDisplayDate(r.serviceDeliveryDate) },
    { key: 'transactionStatus', label: 'Transaction Status', className: 'min-w-[220px]', render: (r) => r.transactionStatus || '-' },
    { key: 'unit', label: 'Unit', className: 'min-w-[140px]', render: (r) => r.unit || '-' },
    { key: 'quantity', label: 'Quantity', className: 'min-w-[120px]', render: (r) => (typeof r.quantity === 'number' ? r.quantity : r.quantity ?? '-') },
    { key: 'unitPrice', label: 'Unit Price', className: 'min-w-[150px]', render: (r) => formatCurrency(r.unitPrice) },
    { key: 'totalAmount', label: 'Total Amount', className: 'min-w-[150px]', render: (r) => formatCurrency(r.totalAmount) },
    { key: 'govSubsidy', label: 'Government Subsidy', className: 'min-w-[150px]', render: (r) => formatCurrency(r.govSubsidy) },
    { key: 'participantContribution', label: 'Participant Contribution', className: 'min-w-[190px]', render: (r) => formatCurrency(r.participantContribution) },
    { key: 'fundingSource', label: 'Funding Source', className: 'min-w-[200px]', render: (r) => r.fundingSource || '-' },
    { key: 'notes', label: 'Notes', className: 'min-w-[220px]', render: (r) => renderNotesCell(r.notes, stripHtml) },
    { key: 'fileUrl', label: 'PDF Download', className: 'min-w-[100px]', render: (r) => renderPdfDownloadCell(r, onDownloadPdf) },
    { key: 'paymentStatus', label: 'Payment Status', className: 'min-w-[180px]', render: (r) => r.paymentStatus || '-' },
  ];
}

export function buildInvoiceGeneratorTableColumns(options: {
  isNdisBoard: boolean;
  isLowCatBoard: boolean;
  ndisStatusFieldLabel: string;
  formatDisplayDate: (dateString: string | null | undefined) => string;
  formatCurrency: (amount: number) => string;
  stripHtml: (value?: string) => string;
  onDownloadPdf: (fileUrl: string, invoiceNumber?: string) => void;
}): InvoiceGeneratorTableColumn[] {
  if (options.isNdisBoard) {
    return buildNdisColumns(
      options.ndisStatusFieldLabel,
      options.formatDisplayDate,
      options.formatCurrency,
      options.onDownloadPdf,
    );
  }
  if (options.isLowCatBoard) {
    return buildLowCatColumns(
      options.formatDisplayDate,
      options.formatCurrency,
      options.stripHtml,
      options.onDownloadPdf,
    );
  }
  return buildDefaultColumns(
    options.formatDisplayDate,
    options.formatCurrency,
    options.stripHtml,
    options.onDownloadPdf,
  );
}
