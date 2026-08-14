import {
  NDIS_MASTERPLAN_ATTR,
  buildNdisMasterPlanServiceRows,
  buildNdisSupportCatalogueForServicePlan,
  extractRefId,
  formatDdMmYyyy,
} from './ndisServiceRecords.js';
import { resolveNdisPricingRuleForServicePlan } from './ndisPricingRules.js';
import {
  buildMasterItemsMap,
  enrichNdisInvoiceGeneratorRows,
} from './ndisInvoiceGeneratorOutput.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';

export function parseMasterItemIdsFromBody(body) {
  const raw = Array.isArray(body?.itemIds)
    ? body.itemIds
    : (Array.isArray(body?.items) ? body.items : []);

  return [...new Set(raw.map((entry) => masterItemIdFromEntry(entry)).filter(Boolean))];
}

function masterItemIdFromEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object') return null;
  if (entry.sourceItemId) return String(entry.sourceItemId);
  if (entry.id && String(entry.id).includes(':')) return String(entry.id).split(':')[0];
  if (entry.id) return String(entry.id);
  return null;
}

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

export function enrichInvoiceRows(allRows, masterItems, timezone) {
  return enrichNdisInvoiceGeneratorRows(
    allRows,
    buildMasterItemsMap(masterItems),
    timezone,
  );
}

export function ndisInvoicePdfFilename(workspaceId, boardId, invoiceNumberBase, participantName) {
  const safeSuffix = (participantName || 'Multiple')
    .replace(/[^a-zA-Z0-9-_]+/g, '_')
    .slice(0, 40);
  return `output/${workspaceId}/${boardId}/NDIS-invoices/${invoiceNumberBase}-ISO+™-${safeSuffix}.pdf`;
}

export function resolveInvoiceTimezone(business) {
  return business?.headOfficeTimezone || DEFAULT_TIMEZONE;
}

export function resolveDueDate(invoiceDateRaw, dueDateRaw) {
  if (dueDateRaw) return String(dueDateRaw).replace('Z', '');
  const d = new Date(invoiceDateRaw);
  d.setDate(d.getDate() + 14);
  return d.toISOString();
}
