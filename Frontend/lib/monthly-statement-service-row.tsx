import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";

export type MonthlyStatementServiceRecord = {
  id: string;
  participant?: string;
  participantName?: string;
  service?: string;
  taskName?: string;
  scheduledServiceDate?: string | null;
  scheduledShiftStart?: string | null;
  serviceDeliveryDate?: string | null;
  actualShiftEndDateTime?: string | null;
  transactionStatus?: string;
  committedAtHmForDelivery?: number;
  unit?: string;
  quantity?: number;
  unitPrice?: number;
  totalAmount?: number;
  govSubsidy?: number;
  participantContribution?: number;
  fundingSource?: string;
  notes?: string;
};

function getTransactionBadgeVariant(transactionStatus?: string) {
  const lower = transactionStatus?.toLowerCase() || '';
  if (lower.includes('cancelled')) return 'destructive' as const;
  if (lower.includes('delivered')) return 'default' as const;
  return 'secondary' as const;
}

function formatScheduledDate(service: MonthlyStatementServiceRecord, formatDate: (value: string) => string) {
  if (service.scheduledServiceDate) return formatDate(service.scheduledServiceDate);
  if (service.scheduledShiftStart) return formatDate(service.scheduledShiftStart);
  return 'N/A';
}

function formatDeliveryDate(service: MonthlyStatementServiceRecord, formatDate: (value: string) => string) {
  if (service.serviceDeliveryDate) return formatDate(service.serviceDeliveryDate);
  if (service.actualShiftEndDateTime) return formatDate(service.actualShiftEndDateTime);
  return 'N/A';
}

export function MonthlyStatementServiceRow({
  service,
  formatDate,
  formatCurrency,
  getServiceProviderLabel,
  sanitizeNotesHtml,
}: {
  service: MonthlyStatementServiceRecord;
  formatDate: (value: string) => string;
  formatCurrency: (amount?: number | null) => string;
  getServiceProviderLabel: (service: MonthlyStatementServiceRecord) => string;
  sanitizeNotesHtml: (html: string) => string;
}) {
  return (
    <TableRow key={service.id} className="text-xs">
      <TableCell className="whitespace-nowrap">
        {service.participant || service.participantName || '-'}
      </TableCell>
      <TableCell className="min-w-[250px]">
        {service.service || service.taskName || '-'}
      </TableCell>
      <TableCell className="min-w-[180px]">
        {getServiceProviderLabel(service)}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {formatScheduledDate(service, formatDate)}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {formatDeliveryDate(service, formatDate)}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {service.transactionStatus && service.transactionStatus.trim() !== '' ? (
          <Badge variant={getTransactionBadgeVariant(service.transactionStatus)} className="text-xs w-max">
            {service.transactionStatus}
          </Badge>
        ) : (
          'N/A'
        )}
      </TableCell>
      <TableCell className="text-center">
        {service.committedAtHmForDelivery && service.committedAtHmForDelivery > 0 ? (
          <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-blue-500 text-white">Yes</span>
        ) : (
          <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-background text-foreground border border-input dark:bg-white/10 dark:text-white dark:border-white/10">No</span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap">{service.unit || '-'}</TableCell>
      <TableCell className="text-right">{Number(service.quantity ?? 0).toFixed(2)}</TableCell>
      <TableCell className="text-right">{formatCurrency(service.unitPrice ?? 0)}</TableCell>
      <TableCell className="text-right font-medium">{formatCurrency(service.totalAmount ?? 0)}</TableCell>
      <TableCell className="text-right">{formatCurrency(service.govSubsidy ?? 0)}</TableCell>
      <TableCell className="text-right">{formatCurrency(service.participantContribution ?? 0)}</TableCell>
      <TableCell className="min-w-[150px]">{service.fundingSource || 'N/A'}</TableCell>
      <TableCell className="max-w-[250px]">
        {service.notes && service.notes.trim() ? (
          <div
            className="notes-cell text-sm prose prose-p:my-0.5 prose-p:leading-tight max-w-none dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: sanitizeNotesHtml(service.notes) }}
          />
        ) : (
          'N/A'
        )}
      </TableCell>
    </TableRow>
  );
}
