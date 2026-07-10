import { collectInvoiceRefIdsFromMasterItems } from './ndisInvoiceContextHelpers.js';
import { toRequiredQueryString } from './securityHelpers.js';

export function validateNdisExportBusiness({ registrationNumber, abn }) {
  if (!registrationNumber) {
    return { error: 'NDIS claim CSV export requires a Company Registration ID. Open ISO+ Portal → Business Configuration, enter your Company Registration ID, save your changes, and try the export again.' };
  }
  if (!abn) {
    return { error: 'NDIS claim CSV export requires an ABN. Open ISO+ Portal → Business Configuration, enter your ABN, save your changes, and try the export again.' };
  }
  return { registrationNumber, abn };
}

export function filterApprovedMasterItems(allMasterItems, formatNdisLabelValue, NDIS_MASTERPLAN_ATTR) {
  return allMasterItems.filter((item) => {
    const approval = item?.data?.[NDIS_MASTERPLAN_ATTR.TIMESHEET_APPROVAL];
    return formatNdisLabelValue(approval).trim().toLowerCase() === 'approved';
  });
}

export function detectNdisStatusFieldNames(masterItems) {
  for (const item of masterItems) {
    if (Object.keys(item?.data || {}).includes('Shift Status')) {
      return ['Shift Status', 'ShiftStatus'];
    }
  }
  return ['Job Status', 'Job status', 'JobStatus'];
}

function filterByParticipantRegex(masterItems, participant, refItemsMap, deps) {
  const escapedParticipant = participant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const participantRegex = new RegExp(escapedParticipant, 'i');
  return masterItems.filter((item) => {
    const ppId = deps.extractNdisRefId(item?.data?.[deps.NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE]);
    const profileItem = ppId ? refItemsMap.get(ppId) : null;
    const name = deps.getNdisParticipantDisplayName(profileItem) ||
      (item?.data?.[deps.NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME] ? String(item.data[deps.NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME]) : '');
    return participantRegex.test(String(name || ''));
  });
}

export function applyNdisMasterItemFilters(masterItems, filters, deps) {
  const {
    participant, paymentStatusFilter, jobStatusFilter, startDate, endDate,
    serviceDeliveryStart, serviceDeliveryEnd, statusFieldAttributeNames, refItemsMap, warn, req,
  } = filters;
  let result = masterItems;
  if (participant) {
    try {
      result = filterByParticipantRegex(result, participant, refItemsMap, deps);
    } catch (regexErr) {
      warn('Export-Service', 'Invalid participant regex pattern (NDIS invoice-csv)', { participant, error: regexErr.message }, req ?? null);
    }
  }
  if (paymentStatusFilter && paymentStatusFilter !== 'all') {
    result = result.filter((item) => {
      const ps = deps.formatNdisLabelValue(
        deps.getNdisValueMulti(item, [deps.NDIS_MASTERPLAN_ATTR.PAYMENT_STATUS, 'Payment status', 'PaymentStatus']),
      ).trim();
      return ps === paymentStatusFilter;
    });
  }
  if (jobStatusFilter && jobStatusFilter !== 'all') {
    const desired = String(jobStatusFilter).trim().toLowerCase();
    result = result.filter((item) => {
      const js = deps.formatNdisLabelValue(deps.getNdisValueMulti(item, statusFieldAttributeNames)).trim().toLowerCase();
      return js === desired;
    });
  }
  const startDateObj = startDate ? new Date(startDate) : null;
  const endDateObj = endDate ? new Date(endDate) : null;
  const serviceDeliveryStartObj = serviceDeliveryStart ? new Date(serviceDeliveryStart) : null;
  const serviceDeliveryEndObj = serviceDeliveryEnd ? new Date(serviceDeliveryEnd) : null;
  return result.filter((item) => {
    const scheduledStartRaw = item?.data?.[deps.NDIS_MASTERPLAN_ATTR.SCHEDULED_START];
    const actualStartRaw = item?.data?.[deps.NDIS_MASTERPLAN_ATTR.ACTUAL_START] ?? item?.data?.['Actual Shift Start Date & Time'];
    const scheduledStartDate = scheduledStartRaw ? new Date(scheduledStartRaw) : null;
    const actualStartDate = actualStartRaw ? new Date(actualStartRaw) : null;
    if (startDateObj && (!scheduledStartDate || isNaN(scheduledStartDate.getTime()) || scheduledStartDate < startDateObj)) return false;
    if (endDateObj && (!scheduledStartDate || isNaN(scheduledStartDate.getTime()) || scheduledStartDate > endDateObj)) return false;
    if (serviceDeliveryStartObj && (!actualStartDate || isNaN(actualStartDate.getTime()) || actualStartDate < serviceDeliveryStartObj)) return false;
    if (serviceDeliveryEndObj && (!actualStartDate || isNaN(actualStartDate.getTime()) || actualStartDate > serviceDeliveryEndObj)) return false;
    return true;
  });
}

export function sortNdisMasterItems(masterItems, sortBy, sortOrder, NDIS_MASTERPLAN_ATTR) {
  const selectedSortOrder = sortOrder === 'desc' ? -1 : 1;
  const getSortDate = (item) => {
    const scheduledStartRaw = item?.data?.[NDIS_MASTERPLAN_ATTR.SCHEDULED_START];
    const actualStartRaw = item?.data?.[NDIS_MASTERPLAN_ATTR.ACTUAL_START] ?? item?.data?.['Actual Shift Start Date & Time'];
    if (sortBy === 'serviceDeliveryDate') {
      const d = actualStartRaw ? new Date(actualStartRaw) : null;
      return d && !isNaN(d.getTime()) ? d : null;
    }
    const d = scheduledStartRaw ? new Date(scheduledStartRaw) : null;
    return d && !isNaN(d.getTime()) ? d : null;
  };
  return [...masterItems].sort((a, b) => {
    const aD = getSortDate(a);
    const bD = getSortDate(b);
    if (!aD && !bD) return 0;
    if (!aD) return 1;
    if (!bD) return -1;
    if (aD.getTime() < bD.getTime()) return -1 * selectedSortOrder;
    if (aD.getTime() > bD.getTime()) return 1 * selectedSortOrder;
    return 0;
  });
}

export function removeMasterItemsMissingNdisNumber(masterItems, refItemsMap, deps) {
  const missingNdis = [];
  for (const item of masterItems) {
    const ppId = deps.extractNdisRefId(item?.data?.[deps.NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE]);
    const profileItem = ppId ? refItemsMap.get(ppId) : null;
    const ndisNumber = deps.getParticipantNdisNumber(profileItem);
    if (!ndisNumber || ndisNumber === '0') {
      const participantName = deps.getNdisParticipantDisplayName(profileItem) ||
        (item?.data?.[deps.NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME] ? String(item.data[deps.NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME]).trim() : '');
      missingNdis.push({ itemId: item.itemId, participant: participantName || '' });
    }
  }
  if (!missingNdis.length) return { masterItems, missingNdis };
  const invalidIds = new Set(missingNdis.map((m) => m.itemId));
  return { masterItems: masterItems.filter((i) => !invalidIds.has(i.itemId)), missingNdis };
}

function resolveRefLabelValue(value, resolveRefName, deps) {
  const ids = deps.extractNdisAllRefIds(value).filter(deps.isUuidLikeNdis);
  if (ids.length > 0) {
    const names = ids.map(resolveRefName).filter(Boolean);
    if (names.length > 0) return names.join(', ');
  }
  return deps.formatNdisLabelValue(value).trim();
}

function buildItemForNdisRows(item, resolveRefName, deps) {
  const resolvedAllowances = resolveRefLabelValue(item?.data?.[deps.NDIS_MASTERPLAN_ATTR.ALLOWANCES_TYPE], resolveRefName, deps);
  const resolvedNf2f = resolveRefLabelValue(item?.data?.[deps.NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_SUPPORTS], resolveRefName, deps);
  const resolvedServiceDeliveryMode = resolveRefLabelValue(item?.data?.[deps.NDIS_MASTERPLAN_ATTR.SERVICE_DELIVERY_MODE], resolveRefName, deps);
  if (!resolvedAllowances && !resolvedNf2f && !resolvedServiceDeliveryMode) return item;
  return {
    ...item,
    data: {
      ...(item.data || {}),
      [deps.NDIS_MASTERPLAN_ATTR.ALLOWANCES_TYPE]: resolvedAllowances || (item?.data?.[deps.NDIS_MASTERPLAN_ATTR.ALLOWANCES_TYPE] ?? ''),
      [deps.NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_SUPPORTS]: resolvedNf2f || (item?.data?.[deps.NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_SUPPORTS] ?? ''),
      [deps.NDIS_MASTERPLAN_ATTR.SERVICE_DELIVERY_MODE]: resolvedServiceDeliveryMode || (item?.data?.[deps.NDIS_MASTERPLAN_ATTR.SERVICE_DELIVERY_MODE] ?? ''),
    },
  };
}

function mapServiceRowsToClaimRows(rows, ctx, item, itemForRows, participantProfileItem, cancellationReasonCode) {
  const { registrationNumber, abn, business, deps, sanitizeClaimReference, formatCsvNumber, claimReference } = ctx;
  const jobStatus = deps.formatNdisLabelValue(
    deps.getNdisValueMulti(item, [deps.NDIS_MASTERPLAN_ATTR.JOB_STATUS, 'Job Status', 'Shift Status']),
  ).trim();
  const actualStartRaw = item?.data?.[deps.NDIS_MASTERPLAN_ATTR.ACTUAL_START] ?? item?.data?.['Actual Shift Start Date & Time'];
  const actualEndRaw = item?.data?.[deps.NDIS_MASTERPLAN_ATTR.ACTUAL_END] ?? item?.data?.['Actual Shift End Date & Time'];
  const scheduledStartRaw = item?.data?.[deps.NDIS_MASTERPLAN_ATTR.SCHEDULED_START];
  const scheduledEndRaw = item?.data?.[deps.NDIS_MASTERPLAN_ATTR.SCHEDULED_END];
  const { supportDeliveredFrom, supportDeliveredTo } = deps.resolveNdisSupportDeliveredDates({
    jobStatus,
    scheduledStart: scheduledStartRaw,
    scheduledEnd: scheduledEndRaw,
    actualStart: actualStartRaw,
    actualEnd: actualEndRaw,
    formatDate: (value) => deps.formatDdMmYyyy(value, business?.headOfficeTimezone || 'Australia/Sydney'),
  });
  const ndisNumber = deps.getParticipantNdisNumber(participantProfileItem);
  const claimReferenceCsv = sanitizeClaimReference(claimReference);
  return rows.map((r) => {
    const claimType = deps.resolveNdisClaimType(
      r.claimType,
      itemForRows?.data?.[deps.NDIS_MASTERPLAN_ATTR.SERVICE_DELIVERY_MODE],
      r.code,
      r.supportNumber || '',
    );
    const code = String(r.code || '');
    const { quantity, hours } = deps.mapNdisClaimCsvQuantityAndHours(code, r.unit, r.quantity);
    return {
      RegistrationNumber: registrationNumber,
      NDISNumber: ndisNumber,
      SupportDeliveredFrom: supportDeliveredFrom,
      SupportDeliveredTo: supportDeliveredTo,
      SupportNumber: r.supportNumber || '',
      ClaimReference: claimReferenceCsv,
      Quantity: quantity,
      Hours: hours,
      UnitPrice: formatCsvNumber(r.unitPrice, 2),
      GSTCode: 'P2',
      ClaimType: claimType,
      CancellationReason: deps.isCancellationClaimRow(claimType, code) ? cancellationReasonCode : '',
      'ABN of Support Provider': abn,
    };
  });
}

export async function expandMasterItemToClaimRows(item, ctx) {
  const { workspaceId, boardId, refItemsMap, invoiceNumberMap, deps } = ctx;
  const itemId = item.itemId;
  const ppId = deps.extractNdisRefId(item?.data?.[deps.NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE]);
  const spId = deps.extractNdisRefId(item?.data?.[deps.NDIS_MASTERPLAN_ATTR.SERVICE_PLAN]);
  const ctId = deps.extractNdisRefId(item?.data?.['Cancellation Type']);
  const participantProfileItem = ppId ? refItemsMap.get(ppId) : null;
  const servicePlanItem = spId ? refItemsMap.get(spId) : null;
  const cancellationTypeItem = ctId ? refItemsMap.get(ctId) : null;
  const participantName = deps.getNdisParticipantDisplayName(participantProfileItem) ||
    (item?.data?.[deps.NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME] ? String(item.data[deps.NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME]).trim() : '');
  const pricingRule = await deps.resolveNdisPricingRuleForServicePlan(workspaceId, servicePlanItem, boardId);
  const supportCatalogue = deps.buildNdisSupportCatalogueForServicePlan(servicePlanItem, refItemsMap, pricingRule);
  const claimReference = invoiceNumberMap.get(itemId) || deps.formatNdisLabelValue(item?.data?.['Generated NDIS Invoice Number']).trim() || '';
  const resolveRefName = (refId) => deps.resolveRefItemDisplayName(refItemsMap.get(refId));
  const itemForRows = buildItemForNdisRows(item, resolveRefName, deps);
  const rows = deps.buildNdisMasterPlanServiceRows({
    masterPlanItem: itemForRows,
    participantName,
    participantProfileItem,
    servicePlanItem,
    supportCatalogue,
    cancellationTypeItem,
    invoiceNumber: claimReference,
    invoicePdfLink: null,
    timeZone: ctx.business?.headOfficeTimezone || 'Australia/Sydney',
    pricingRule,
  });
  const cancellationReasonLabel = deps.resolveCancellationReasonLabel(
    item?.data?.[deps.NDIS_MASTERPLAN_ATTR.CANCELLATION_REASON],
    (refId) => resolveRefName(refId),
  );
  const cancellationReasonCode = deps.mapCancellationReasonCode(cancellationReasonLabel);
  return mapServiceRowsToClaimRows(rows, { ...ctx, claimReference }, item, itemForRows, participantProfileItem, cancellationReasonCode);
}

async function loadNdisSupportCatalogueIntoMap(workspaceId, boardId, servicePlanIds, refItemsMap, deps) {
  const supportItemIds = new Set();
  for (const spId of servicePlanIds) {
    const spItem = refItemsMap.get(spId);
    if (!spItem?.data) continue;
    const pricingRule = await deps.resolveNdisPricingRuleForServicePlan(workspaceId, spItem, boardId);
    deps.collectNdisSupportCatalogueRefIds(spItem.data, pricingRule).forEach((id) => supportItemIds.add(id));
  }
  if (!supportItemIds.size) return refItemsMap;
  const supportMap = await deps.bulkFetchItemsFromDB(workspaceId, boardId, [...supportItemIds]);
  for (const [k, v] of supportMap) refItemsMap.set(k, v);
  return refItemsMap;
}

export async function handleNdisInvoiceCsvExport(req, res, deps) {
  const startTime = Date.now();
  try {
    const workspaceId = toRequiredQueryString(req.params.workspaceId);
    const boardId = toRequiredQueryString(req.params.boardId);
    const {
      participant = '', startDate, endDate, serviceDeliveryStart, serviceDeliveryEnd,
      paymentStatus: paymentStatusFilter = '', jobStatus: jobStatusFilter = '',
      sortBy = 'scheduledServiceDate', sortOrder = 'asc', limit = 'all',
    } = req.query;

    if (!workspaceId || !boardId) {
      return res.status(400).json({
        message: 'NDIS claim CSV export could not start because the workspace or board is missing. Return to your workspace list, open the board again, and try the export again.',
      });
    }

    const businessDoc = await deps.Business.findOne({ workspaceId: workspaceId.toString() })
      .select('abn companyRegistrationId headOfficeTimezone').lean();
    const businessCheck = validateNdisExportBusiness({
      registrationNumber: deps.sanitizeDigits(businessDoc?.companyRegistrationId || '', 30),
      abn: deps.sanitizeDigits(businessDoc?.abn || '', 20),
    });
    if (businessCheck.error) return res.status(400).json({ message: businessCheck.error });
    const { registrationNumber, abn } = businessCheck;

    const folderIds = await deps.getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
    const baseQuery = { workspaceId, boardId };
    if (folderIds?.length) baseQuery.folderId = { $in: folderIds };
    let masterItems = filterApprovedMasterItems(
      await deps.Item.find(baseQuery).lean(),
      deps.formatNdisLabelValue,
      deps.NDIS_MASTERPLAN_ATTR,
    );

    const refIdSets = collectInvoiceRefIdsFromMasterItems(masterItems);
    let refItemsMap = await deps.bulkFetchItemsFromDB(workspaceId, boardId, [
      ...refIdSets.servicePlanIds,
      ...refIdSets.participantProfileIds,
      ...refIdSets.cancellationTypeIds,
      ...refIdSets.serviceDeliveryModeIds,
      ...refIdSets.cancellationReasonIds,
      ...refIdSets.allowancesRefIds,
      ...refIdSets.nonFaceToFaceRefIds,
    ]);

    refItemsMap = await loadNdisSupportCatalogueIntoMap(workspaceId, boardId, refIdSets.servicePlanIds, refItemsMap, deps);

    const invoiceNumberMap = new Map(
      (await deps.InvoiceNumber.find({
        workspaceId, boardId, itemId: { $in: masterItems.map((i) => i.itemId) }, type: 'PDF',
      }).lean()).map((inv) => [inv.itemId, inv.invoiceNumber || '']),
    );

    const statusFieldAttributeNames = detectNdisStatusFieldNames(masterItems);
    masterItems = applyNdisMasterItemFilters(masterItems, {
      participant, paymentStatusFilter, jobStatusFilter, startDate, endDate,
      serviceDeliveryStart, serviceDeliveryEnd, statusFieldAttributeNames, refItemsMap,
      warn: deps.warn, req,
    }, deps);
    masterItems = sortNdisMasterItems(masterItems, sortBy, sortOrder, deps.NDIS_MASTERPLAN_ATTR);

    const sanitizeClaimReference = (value) => {
      if (!value) return '';
      return String(value).replace(/\s+/g, '_').replace(/[^A-Za-z0-9/_-]/g, '').slice(0, 50);
    };
    const formatCsvNumber = (value, decimals = 2) => {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return '';
      return n.toFixed(decimals).replace(/\.00$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
    };

    const removed = removeMasterItemsMissingNdisNumber(masterItems, refItemsMap, deps);
    masterItems = removed.masterItems;
    const missingNdis = removed.missingNdis;
    if (missingNdis.length > 0) {
      deps.warn('Export-Service', 'Skipping items with missing NDIS number during export', {
        workspaceId, boardId, skipped: missingNdis.length,
      }, req ?? null);
    }

    const claimRows = [];
    const expandCtx = {
      workspaceId, boardId, refItemsMap, invoiceNumberMap, business: businessDoc,
      registrationNumber, abn, deps, sanitizeClaimReference, formatCsvNumber,
    };
    for (const item of masterItems) {
      claimRows.push(...await expandMasterItemToClaimRows(item, expandCtx));
    }

    let finalRows = claimRows;
    if (String(limit).toLowerCase() !== 'all') {
      const parsed = parseInt(limit, 10);
      if (!isNaN(parsed) && parsed > 0) finalRows = claimRows.slice(0, parsed);
    }

    const duration = Date.now() - startTime;
    deps.info('Export-Service', 'Completed NDIS invoice CSV export (DB only)', {
      workspaceId, boardId, rowCount: finalRows.length, durationMs: duration,
    }, req ?? null);

    return res.status(200).json({
      items: finalRows,
      total: finalRows.length,
      skippedCount: missingNdis.length,
      skipped: missingNdis.slice(0, 50),
      exportDurationMs: duration,
    });
  } catch (err) {
    deps.error('Export-Service', 'Failed to export NDIS invoice CSV', { err }, req);
    return res.status(500).json({
      message: 'NDIS claim CSV export failed due to a server problem. Please try again. If this keeps happening, contact support.',
    });
  }
}
