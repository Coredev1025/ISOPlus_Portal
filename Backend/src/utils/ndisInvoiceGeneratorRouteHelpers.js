import {
  buildNdisMasterPlanServiceRows,
  buildNdisSupportCatalogueForServicePlan,
  collectNdisSupportCatalogueRefIds,
  formatLabelValue as formatNdisLabelValue,
  NDIS_MASTERPLAN_ATTR,
  extractRefId as extractNdisRefId,
  extractAllRefIds as extractNdisAllRefIds,
  parseNumberValue as parseNdisNumber,
  getValueMulti as getNdisValueMulti,
  getParticipantDisplayName as getNdisParticipantDisplayName,
} from './ndisServiceRecords.js';
import { toRequiredQueryString } from './securityHelpers.js';
import { resolveNdisPricingRuleForServicePlan } from './ndisPricingRules.js';
import {
  buildMasterItemsMap,
  enrichNdisInvoiceGeneratorRows,
} from './ndisInvoiceGeneratorOutput.js';
import { parseListPagination } from './itemsRouteHelpers.js';

function isApprovedTimesheet(item) {
  const approval = item?.data?.[NDIS_MASTERPLAN_ATTR.TIMESHEET_APPROVAL];
  return formatNdisLabelValue(approval).trim().toLowerCase() === 'approved';
}

function collectNdisRefIdSets(masterItems, isUuidLike) {
  const servicePlanIds = new Set();
  const participantProfileIds = new Set();
  const cancellationTypeIds = new Set();
  const allowancesRefIds = new Set();
  const nonFaceToFaceRefIds = new Set();

  for (const item of masterItems) {
    const spId = extractNdisRefId(item?.data?.[NDIS_MASTERPLAN_ATTR.SERVICE_PLAN]);
    if (spId && isUuidLike(spId)) servicePlanIds.add(spId);

    const ppId = extractNdisRefId(item?.data?.[NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE]);
    if (ppId && isUuidLike(ppId)) participantProfileIds.add(ppId);

    const ctId = extractNdisRefId(item?.data?.['Cancellation Type']);
    if (ctId && isUuidLike(ctId)) cancellationTypeIds.add(ctId);

    extractNdisAllRefIds(item?.data?.[NDIS_MASTERPLAN_ATTR.ALLOWANCES_TYPE])
      .filter((id) => isUuidLike(id))
      .forEach((id) => allowancesRefIds.add(id));

    extractNdisAllRefIds(item?.data?.[NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_SUPPORTS])
      .filter((id) => isUuidLike(id))
      .forEach((id) => nonFaceToFaceRefIds.add(id));
  }

  return {
    servicePlanIds,
    participantProfileIds,
    cancellationTypeIds,
    allowancesRefIds,
    nonFaceToFaceRefIds,
  };
}

async function loadNdisRefItemsMap(workspaceId, boardId, refIdSets, deps) {
  const {
    servicePlanIds,
    participantProfileIds,
    cancellationTypeIds,
    allowancesRefIds,
    nonFaceToFaceRefIds,
  } = refIdSets;

  const refItemsMap = await deps.bulkFetchReferenceItemsFromDB(workspaceId, boardId, [
    ...servicePlanIds,
    ...participantProfileIds,
    ...cancellationTypeIds,
    ...allowancesRefIds,
    ...nonFaceToFaceRefIds,
  ]);

  const supportItemIds = new Set();
  const servicePlanIdList = [...servicePlanIds];
  const pricingRules = await Promise.all(
    servicePlanIdList.map((spId) => {
      const spItem = refItemsMap.get(spId);
      if (!spItem?.data) return Promise.resolve(null);
      return resolveNdisPricingRuleForServicePlan(workspaceId, spItem, boardId);
    }),
  );
  for (let i = 0; i < servicePlanIdList.length; i++) {
    const spId = servicePlanIdList[i];
    const spItem = refItemsMap.get(spId);
    const pricingRule = pricingRules[i];
    if (!spItem?.data || !pricingRule) continue;
    collectNdisSupportCatalogueRefIds(spItem.data, pricingRule).forEach((id) => supportItemIds.add(id));
  }

  if (supportItemIds.size > 0) {
    const supportMap = await deps.bulkFetchReferenceItemsFromDB(workspaceId, boardId, [...supportItemIds]);
    for (const [k, v] of supportMap) {
      refItemsMap.set(k, v);
    }
  }

  return { refItemsMap, servicePlanIds };
}

async function loadNdisInvoiceMaps(workspaceId, boardId, masterItems, InvoiceNumber) {
  const itemIdsForInvoice = masterItems.map((i) => i.itemId);
  const invoiceNumbers = await InvoiceNumber.find({
    workspaceId,
    boardId,
    itemId: { $in: itemIdsForInvoice },
    type: 'PDF',
  }).lean();
  return {
    invoiceNumberMap: new Map(invoiceNumbers.map((inv) => [inv.itemId, inv.invoiceNumber])),
    invoiceFileUrlMap: new Map(invoiceNumbers.map((inv) => [inv.itemId, inv.pdfLink || null])),
  };
}

function resolveRefDisplayName(refId, refItemsMap) {
  const refItem = refItemsMap.get(refId);
  if (!refItem?.data) return '';
  const candidates = ['Service Delivery Mode', 'Name', 'Definition', 'Full Name/Preferred Name', 'Preferred Name'];
  for (const key of candidates) {
    const v = refItem.data[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function resolveValueToNames(value, refItemsMap, isUuidLike) {
  if (!value) return '';
  const ids = extractNdisAllRefIds(value).filter((id) => isUuidLike(id));
  if (ids.length > 0) {
    const names = ids.map((id) => resolveRefDisplayName(id, refItemsMap)).filter((name) => Boolean(name));
    if (names.length > 0) return names.join(', ');
  }
  return formatNdisLabelValue(value).trim();
}

function createRefResolvers(refItemsMap) {
  return {
    resolveRefDisplayName: (refId) => resolveRefDisplayName(refId, refItemsMap),
    resolveValueToNames: (value, isUuidLike) => resolveValueToNames(value, refItemsMap, isUuidLike),
  };
}

function detectNdisStatusFieldLabel(masterItems) {
  for (const item of masterItems) {
    const keys = Object.keys(item?.data || {});
    if (keys.includes('Shift Status')) {
      return 'Shift Status';
    }
  }
  return 'Job Status';
}

function getNdisStatusFieldAttributeNames(statusFieldLabel) {
  return statusFieldLabel === 'Shift Status'
    ? ['Shift Status', 'ShiftStatus']
    : [NDIS_MASTERPLAN_ATTR.JOB_STATUS, 'Job status', 'JobStatus'];
}

function filterNdisByParticipant(masterItems, participant, refItemsMap, warn, req) {
  if (!participant) return masterItems;
  try {
    const escapedParticipant = participant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const participantRegex = new RegExp(escapedParticipant, 'i');
    return masterItems.filter((item) => {
      const ppId = extractNdisRefId(item?.data?.[NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE]);
      const profileItem = ppId ? refItemsMap.get(ppId) : null;
      const name = getNdisParticipantDisplayName(profileItem) ||
        (item?.data?.[NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME]
          ? String(item.data[NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME])
          : '');
      return participantRegex.test(String(name || ''));
    });
  } catch (regexErr) {
    warn('Items-Service', 'Invalid participant regex pattern (NDIS invoice-generator)', {
      participant,
      error: regexErr.message,
    }, req ?? null);
    return masterItems;
  }
}

function filterNdisByPaymentStatus(masterItems, paymentStatusFilter) {
  if (!paymentStatusFilter || paymentStatusFilter === 'all') return masterItems;
  return masterItems.filter((item) => {
    const ps = formatNdisLabelValue(
      getNdisValueMulti(item, [NDIS_MASTERPLAN_ATTR.PAYMENT_STATUS, 'Payment status', 'PaymentStatus']),
    ).trim();
    return ps === paymentStatusFilter;
  });
}

function filterNdisByJobStatus(masterItems, jobStatusFilter, statusFieldAttributeNames) {
  if (!jobStatusFilter || jobStatusFilter === 'all') return masterItems;
  const desired = String(jobStatusFilter).trim().toLowerCase();
  return masterItems.filter((item) => {
    const js = formatNdisLabelValue(getNdisValueMulti(item, statusFieldAttributeNames)).trim().toLowerCase();
    return js === desired;
  });
}

function filterNdisByInvoiceStatus(masterItems, status, invoiceNumberMap) {
  if (!status || status === 'all') return masterItems;
  return masterItems.filter((item) => {
    const invNo = invoiceNumberMap.get(item.itemId);
    const derived = invNo ? 'invoiced' : 'pending';
    return derived === status;
  });
}

function filterNdisByDates(masterItems, { startDate, endDate, serviceDeliveryStart, serviceDeliveryEnd }) {
  const startDateObj = startDate ? new Date(startDate) : null;
  const endDateObj = endDate ? new Date(endDate) : null;
  const serviceDeliveryStartObj = serviceDeliveryStart ? new Date(serviceDeliveryStart) : null;
  const serviceDeliveryEndObj = serviceDeliveryEnd ? new Date(serviceDeliveryEnd) : null;

  return masterItems.filter((item) => {
    const scheduledStartRaw = item?.data?.[NDIS_MASTERPLAN_ATTR.SCHEDULED_START];
    const actualStartRaw = item?.data?.[NDIS_MASTERPLAN_ATTR.ACTUAL_START]
      ?? item?.data?.['Actual Shift Start Date & Time'];
    const scheduledStartDate = scheduledStartRaw ? new Date(scheduledStartRaw) : null;
    const actualStartDate = actualStartRaw ? new Date(actualStartRaw) : null;

    if (startDateObj && (!scheduledStartDate || isNaN(scheduledStartDate.getTime()) || scheduledStartDate < startDateObj)) {
      return false;
    }
    if (endDateObj && (!scheduledStartDate || isNaN(scheduledStartDate.getTime()) || scheduledStartDate > endDateObj)) {
      return false;
    }
    if (serviceDeliveryStartObj && (!actualStartDate || isNaN(actualStartDate.getTime()) || actualStartDate < serviceDeliveryStartObj)) {
      return false;
    }
    if (serviceDeliveryEndObj && (!actualStartDate || isNaN(actualStartDate.getTime()) || actualStartDate > serviceDeliveryEndObj)) {
      return false;
    }
    return true;
  });
}

function getNdisSortDate(item, sortBy) {
  const scheduledStartRaw = item?.data?.[NDIS_MASTERPLAN_ATTR.SCHEDULED_START];
  const actualStartRaw = item?.data?.[NDIS_MASTERPLAN_ATTR.ACTUAL_START]
    ?? item?.data?.['Actual Shift Start Date & Time'];
  if (sortBy === 'serviceDeliveryDate') {
    const d = actualStartRaw ? new Date(actualStartRaw) : null;
    return d && !isNaN(d.getTime()) ? d : null;
  }
  const d = scheduledStartRaw ? new Date(scheduledStartRaw) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}

function sortNdisMasterItems(masterItems, sortBy, sortOrder) {
  const selectedSortOrder = sortOrder === 'desc' ? -1 : 1;
  masterItems.sort((a, b) => {
    const aD = getNdisSortDate(a, sortBy);
    const bD = getNdisSortDate(b, sortBy);
    const aNull = !aD;
    const bNull = !bD;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (aD.getTime() < bD.getTime()) return -1 * selectedSortOrder;
    if (aD.getTime() > bD.getTime()) return 1 * selectedSortOrder;
    return 0;
  });
  return masterItems;
}

function prepareItemForRowExpansion(item, resolveValueToNames, isUuidLike) {
  const resolvedAllowances = resolveValueToNames(item?.data?.[NDIS_MASTERPLAN_ATTR.ALLOWANCES_TYPE], isUuidLike);
  const resolvedNf2f = resolveValueToNames(item?.data?.[NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_SUPPORTS], isUuidLike);
  const resolvedServiceDeliveryMode = resolveValueToNames(item?.data?.[NDIS_MASTERPLAN_ATTR.SERVICE_DELIVERY_MODE], isUuidLike);

  if (!resolvedAllowances && !resolvedNf2f && !resolvedServiceDeliveryMode) {
    return item;
  }

  return {
    ...item,
    data: {
      ...(item.data || {}),
      [NDIS_MASTERPLAN_ATTR.ALLOWANCES_TYPE]: resolvedAllowances
        || (item?.data?.[NDIS_MASTERPLAN_ATTR.ALLOWANCES_TYPE] ?? ''),
      [NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_SUPPORTS]: resolvedNf2f
        || (item?.data?.[NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_SUPPORTS] ?? ''),
      [NDIS_MASTERPLAN_ATTR.SERVICE_DELIVERY_MODE]: resolvedServiceDeliveryMode
        || (item?.data?.[NDIS_MASTERPLAN_ATTR.SERVICE_DELIVERY_MODE] ?? ''),
    },
  };
}

async function expandNdisMasterItemsToRows({
  masterItems,
  refItemsMap,
  resolveValueToNames,
  isUuidLike,
  workspaceId,
  boardId,
  invoiceNumberMap,
  invoiceFileUrlMap,
  headOfficeTimezone,
}) {
  const pricingRules = await Promise.all(masterItems.map((item) => {
    const spId = extractNdisRefId(item?.data?.[NDIS_MASTERPLAN_ATTR.SERVICE_PLAN]);
    const servicePlanItem = spId ? refItemsMap.get(spId) : null;
    return resolveNdisPricingRuleForServicePlan(workspaceId, servicePlanItem, boardId);
  }));

  const expandedRows = [];
  for (let i = 0; i < masterItems.length; i++) {
    const item = masterItems[i];
    const itemForRows = prepareItemForRowExpansion(item, resolveValueToNames, isUuidLike);

    const ppId = extractNdisRefId(item?.data?.[NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE]);
    const spId = extractNdisRefId(item?.data?.[NDIS_MASTERPLAN_ATTR.SERVICE_PLAN]);
    const ctId = extractNdisRefId(item?.data?.['Cancellation Type']);

    const participantProfileItem = ppId ? refItemsMap.get(ppId) : null;
    const servicePlanItem = spId ? refItemsMap.get(spId) : null;
    const cancellationTypeItem = ctId ? refItemsMap.get(ctId) : null;

    const participantName =
      getNdisParticipantDisplayName(participantProfileItem) ||
      (item?.data?.[NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME]
        ? String(item.data[NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME]).trim()
        : '');

    const pricingRule = pricingRules[i];
    const supportCatalogue = buildNdisSupportCatalogueForServicePlan(servicePlanItem, refItemsMap, pricingRule);

    const rows = buildNdisMasterPlanServiceRows({
      masterPlanItem: itemForRows,
      participantName,
      participantProfileItem,
      servicePlanItem,
      supportCatalogue,
      cancellationTypeItem,
      invoiceNumber: invoiceNumberMap.get(item.itemId),
      invoicePdfLink: invoiceFileUrlMap.get(item.itemId),
      timeZone: headOfficeTimezone,
      pricingRule,
    });

    expandedRows.push(...rows);
  }
  return expandedRows;
}

function computeNdisRowTotals(enrichedExpandedRows) {
  let invoiced = 0;
  let pending = 0;
  let totalAmount = 0;
  for (const r of enrichedExpandedRows) {
    if (r.status === 'invoiced') invoiced += 1;
    else pending += 1;
    totalAmount += parseNdisNumber(r.totalAmount);
  }
  return { invoiced, pending, totalAmount, total: enrichedExpandedRows.length };
}

export async function getNdisInvoiceGeneratorData(
  { workspaceId, boardId, query, req },
  deps,
) {
  const {
    participant = '',
    startDate,
    endDate,
    serviceDeliveryStart,
    serviceDeliveryEnd,
    paymentStatus: paymentStatusFilter = '',
    jobStatus: jobStatusFilter = '',
    status = 'all',
    page = 1,
    limit: limitParam,
    sortBy = 'scheduledServiceDate',
    sortOrder = 'asc',
  } = query;

  const safeWorkspaceId = toRequiredQueryString(workspaceId);
  const safeBoardId = toRequiredQueryString(boardId);
  const { limitNumber, applyPagination, skip } = parseListPagination(page, limitParam);

  const businessForTz = await deps.Business.findOne({ workspaceId: safeWorkspaceId })
    .select('headOfficeTimezone').lean().catch(() => null);
  const headOfficeTimezone = businessForTz?.headOfficeTimezone || 'Australia/Sydney';

  const baseQuery = { workspaceId: safeWorkspaceId, boardId: safeBoardId };
  const folderIds = await deps.getFolderIds('Master Plan,Shift Planning and Reporting', safeWorkspaceId, safeBoardId);
  if (folderIds && folderIds.length > 0) {
    baseQuery.folderId = { $in: folderIds };
  }

  const allItems = await deps.Item.find(baseQuery).lean();
  let masterItems = allItems.filter((item) => isApprovedTimesheet(item));

  const refIdSets = collectNdisRefIdSets(masterItems, deps.isUuidLike);
  const { refItemsMap } = await loadNdisRefItemsMap(safeWorkspaceId, safeBoardId, refIdSets, deps);
  const { invoiceNumberMap, invoiceFileUrlMap } = await loadNdisInvoiceMaps(
    safeWorkspaceId,
    safeBoardId,
    masterItems,
    deps.InvoiceNumber,
  );

  const { resolveValueToNames } = createRefResolvers(refItemsMap);
  const statusFieldLabel = detectNdisStatusFieldLabel(masterItems);
  const statusFieldAttributeNames = getNdisStatusFieldAttributeNames(statusFieldLabel);

  masterItems = filterNdisByParticipant(masterItems, participant, refItemsMap, deps.warn, req);
  masterItems = filterNdisByPaymentStatus(masterItems, paymentStatusFilter);
  masterItems = filterNdisByJobStatus(masterItems, jobStatusFilter, statusFieldAttributeNames);
  masterItems = filterNdisByInvoiceStatus(masterItems, status, invoiceNumberMap);
  masterItems = filterNdisByDates(masterItems, { startDate, endDate, serviceDeliveryStart, serviceDeliveryEnd });
  masterItems = sortNdisMasterItems(masterItems, sortBy, sortOrder);

  const expandedRows = await expandNdisMasterItemsToRows({
    masterItems,
    refItemsMap,
    resolveValueToNames,
    isUuidLike: deps.isUuidLike,
    workspaceId: safeWorkspaceId,
    boardId: safeBoardId,
    invoiceNumberMap,
    invoiceFileUrlMap,
    headOfficeTimezone,
  });

  const enrichedExpandedRows = enrichNdisInvoiceGeneratorRows(
    expandedRows,
    buildMasterItemsMap(masterItems),
    headOfficeTimezone,
  );

  const totals = computeNdisRowTotals(enrichedExpandedRows);
  const items = applyPagination && limitNumber
    ? enrichedExpandedRows.slice(skip, skip + limitNumber)
    : enrichedExpandedRows;

  return {
    items,
    total: totals.total,
    invoiced: totals.invoiced,
    pending: totals.pending,
    totalAmount: totals.totalAmount,
    totalGovSubsidy: 0,
    totalParticipantContribution: 0,
    statusFieldLabel,
  };
}
