import {
  NDIS_MASTERPLAN_ATTR,
  buildNdisMasterPlanServiceRows,
  buildNdisSupportCatalogueForServicePlan,
  extractRefId,
  formatDdMmYyyy,
} from './ndisServiceRecords.js';
import { resolveNdisPricingRuleForServicePlan } from './ndisPricingRules.js';

export function formatInvoiceMoney(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '0.00';
  return (Math.round(n * 100) / 100).toFixed(2);
}

export async function buildRowsForMasterItem({
  masterPlanItem,
  refItemsMap,
  participantName,
  profileItem,
  invoiceNumber,
  timezone,
  workspaceId,
  boardId,
}) {
  const spId = extractRefId(masterPlanItem?.data?.[NDIS_MASTERPLAN_ATTR.SERVICE_PLAN]);
  const servicePlanItem = spId ? refItemsMap.get(spId) : null;
  if (!servicePlanItem) {
    throw new Error(
      'Master plan information is required. Master plan is missing a service plan reference.',
    );
  }

  const ctId = extractRefId(masterPlanItem?.data?.['Cancellation Type']);
  const cancellationTypeItem = ctId ? refItemsMap.get(ctId) : null;
  const pricingRule = await resolveNdisPricingRuleForServicePlan(
    workspaceId, servicePlanItem, boardId,
  );
  const supportCatalogue = buildNdisSupportCatalogueForServicePlan(
    servicePlanItem, refItemsMap, pricingRule,
  );

  return buildNdisMasterPlanServiceRows({
    masterPlanItem,
    participantName,
    participantProfileItem: profileItem,
    servicePlanItem,
    supportCatalogue,
    cancellationTypeItem,
    invoiceNumber,
    invoicePdfLink: null,
    timeZone: timezone,
    pricingRule,
  });
}

export async function collectNdisInvoiceRows(args) {
  const allRows = [];
  for (const masterPlanItem of args.masterItems) {
    allRows.push(...await buildRowsForMasterItem({ ...args, masterPlanItem }));
  }
  return allRows;
}

export function buildNdisInvoiceOrders(enrichedRows, timezone) {
  let subTotalNum = 0;
  const gstLabel = 'GST Free';
  const ordersArr = enrichedRows.map((row) => {
    const jobStatus = (row.jobStatus || '').toString().trim().toLowerCase();
    const dateIso = jobStatus === 'cancelled'
      ? (row.scheduledServiceDate || row.serviceDeliveryDate || '')
      : (row.serviceDeliveryDate || row.scheduledServiceDate || '');
    subTotalNum += Number(row.totalAmount || 0);
    return [
      formatDdMmYyyy(dateIso, timezone) || ' ',
      (row.service || ' ').toString(),
      (row.unit || ' ').toString(),
      formatInvoiceMoney(row.quantity),
      formatInvoiceMoney(row.unitPrice),
      gstLabel,
      formatInvoiceMoney(row.totalAmount),
    ];
  });
  return { ordersArr, subTotal: formatInvoiceMoney(subTotalNum) };
}

export function ndisInvoicePdfFilename(
  workspaceId, boardId, invoiceNumberBase, participantName, periodSuffix = '',
) {
  const safeSuffix = (participantName || 'Multiple')
    .replace(/[^a-zA-Z0-9-_]+/g, '_')
    .slice(0, 40);
  // `periodSuffix` is '' for manual generation, which has no period — so those
  // keys are byte-identical to before, and the PDFLink rows already storing
  // them stay valid.
  return `output/${workspaceId}/${boardId}/NDIS-invoices/${invoiceNumberBase}-ISO+™-${safeSuffix}${periodSuffix}.pdf`;
}

export function resolveDueDate(invoiceDateRaw, dueDateRaw) {
  if (dueDateRaw) return String(dueDateRaw).replace('Z', '');
  const d = new Date(invoiceDateRaw);
  d.setDate(d.getDate() + 14);
  return d.toISOString();
}
