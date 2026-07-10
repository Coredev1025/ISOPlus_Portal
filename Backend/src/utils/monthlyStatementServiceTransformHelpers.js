import { getCachedMSService, setCachedMSService } from './transformCache.js';

export function formatMonthlyStatementStatus(value) {
  if (!value) return undefined;
  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry) => {
      if (typeof entry === 'object' && entry.name) return entry.name;
      return String(entry);
    }).filter(Boolean).join(', ');
  }
  if (typeof value === 'object' && value.name) return value.name;
  if (typeof value === 'string') return value;
  return String(value);
}

function isPrimarySupplementOrUnspentHcp(name) {
  const n = (name || '').toLowerCase();
  return n.includes('primary supplement') || n.includes('unspent home care package') || n.includes('unspent hcp');
}

function resolveParticipantName(item, msRefItemsMap, ATTRIBUTE_NAMES, deps) {
  const getValue = (attributeName) => (item.data ? item.data[attributeName] ?? null : null);
  let participantName = getValue(ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
  const participantProfileId = deps.extractRefId(getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE));

  if (participantProfileId) {
    const profileName = deps.getParticipantNameFromProfile(msRefItemsMap.get(participantProfileId));
    if (profileName) participantName = profileName;
  }
  return participantName;
}

function resolveServiceProvider(deliveredByRaw, businessProfile, item, msRefItemsMap, ATTRIBUTE_NAMES, deps) {
  const deliveredByName = deliveredByRaw == null
    ? null
    : (typeof deliveredByRaw === 'object' ? (deliveredByRaw.name || deliveredByRaw.toString()) : String(deliveredByRaw));

  if (!deliveredByName || typeof deliveredByName !== 'string') {
    return { deliveredByName, serviceProvider: undefined };
  }

  const deliveredByLower = deliveredByName.toLowerCase();
  if (deliveredByLower.includes('company workforce')) {
    return { deliveredByName, serviceProvider: businessProfile?.name || undefined };
  }

  if (!deliveredByLower.includes('associated')) {
    return { deliveredByName, serviceProvider: undefined };
  }

  const getValue = (attributeName) => (item.data ? item.data[attributeName] ?? null : null);
  const apRefId = deps.extractRefId(getValue(ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER));
  const providerRefItem = apRefId ? msRefItemsMap.get(apRefId) : null;
  const businessIndividual = providerRefItem
    ? deps.getValueFromFlatData(providerRefItem, 'Business/Individual')
    : null;

  const serviceProvider = (businessIndividual != null && businessIndividual !== '')
    ? (typeof businessIndividual === 'object' && businessIndividual.name
      ? businessIndividual.name
      : String(businessIndividual))
    : (apRefId || undefined);

  return { deliveredByName, serviceProvider };
}

function resolveFundingSourceNames({
  fundingSourceData,
  msRefItemsMap,
  serviceCategory,
  extractAllRefIds,
  getFundingSourceNameFromItem,
  stripEmojiFromFundingSource,
}) {
  if (!fundingSourceData) return undefined;
  const fundingSourceNames = [];
  for (const fsId of extractAllRefIds(fundingSourceData)) {
    let fsName = getFundingSourceNameFromItem(msRefItemsMap.get(fsId));
    if (!fsName) continue;
    if (serviceCategory && isPrimarySupplementOrUnspentHcp(fsName)) {
      fsName = `${fsName} - ${stripEmojiFromFundingSource(serviceCategory)}`;
    }
    fundingSourceNames.push(fsName);
  }
  return fundingSourceNames.length > 0 ? fundingSourceNames.join(', ') : undefined;
}

export function transformMonthlyStatementServiceItem(item, context) {
  const {
    workspaceId,
    boardId,
    msRefItemsMap,
    businessProfile,
    ATTRIBUTE_NAMES,
    deps,
  } = context;

  const itemId = item.itemId;
  const itemUpdatedAt = item.updatedAt || item.createdAt;
  const cachedData = getCachedMSService(workspaceId, boardId, itemId, itemUpdatedAt);
  if (cachedData) return cachedData;

  const getValue = (attributeName) => (item.data ? item.data[attributeName] ?? null : null);
  const participantName = resolveParticipantName(item, msRefItemsMap, ATTRIBUTE_NAMES, deps);

  const servicePlanRefId = deps.extractRefId(getValue(ATTRIBUTE_NAMES.SERVICE_PLAN));
  const servicePlanItem = servicePlanRefId ? msRefItemsMap.get(servicePlanRefId) : null;
  const service = deps.getServiceFromServicePlan(servicePlanItem);

  const { deliveredByName, serviceProvider } = resolveServiceProvider(
    getValue(ATTRIBUTE_NAMES.DELIVERED_BY),
    businessProfile,
    item,
    msRefItemsMap,
    ATTRIBUTE_NAMES,
    deps,
  );

  const scheduledStart = getValue(ATTRIBUTE_NAMES.SCHEDULED_START) || null;
  const actualEnd = getValue(ATTRIBUTE_NAMES.ACTUAL_END) || null;
  const transactionStatus = formatMonthlyStatementStatus(getValue(ATTRIBUTE_NAMES.TRANSACTION_STATUS));

  const committedAtHm = getValue(ATTRIBUTE_NAMES.COMMITTED_AT_HM);
  const committedAtHmForDelivery = committedAtHm !== null && committedAtHm !== undefined
    ? (typeof committedAtHm === 'number' ? committedAtHm : Number(committedAtHm) || 0)
    : undefined;

  const unit = getValue(ATTRIBUTE_NAMES.UNIT) || 'Hour';
  const quantity = Number(getValue(ATTRIBUTE_NAMES.QUANTITY)) || 0;
  const unitPrice = Number(getValue(ATTRIBUTE_NAMES.UNIT_PRICE)) || 0;
  const totalAmount = Number(getValue(ATTRIBUTE_NAMES.TOTAL_AMOUNT)) || 0;
  const govSubsidy = Number(getValue(ATTRIBUTE_NAMES.GOV_SUBSIDY)) || 0;
  const participantContribution = Number(getValue(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)) || 0;

  const serviceCategoryRaw = servicePlanItem
    ? deps.getValueFromFlatData(servicePlanItem, ['Service Category', ATTRIBUTE_NAMES.SERVICE_CATEGORY])
    : null;
  const serviceCategory = serviceCategoryRaw
    ? (typeof serviceCategoryRaw === 'object' && serviceCategoryRaw.name
      ? serviceCategoryRaw.name
      : String(serviceCategoryRaw).trim())
    : '';

  const fundingSource = resolveFundingSourceNames({
    fundingSourceData: getValue(ATTRIBUTE_NAMES.FUNDING_SOURCE),
    msRefItemsMap,
    serviceCategory,
    extractAllRefIds: deps.extractAllRefIds,
    getFundingSourceNameFromItem: deps.getFundingSourceNameFromItem,
    stripEmojiFromFundingSource: deps.stripEmojiFromFundingSource,
  });

  const notes = getValue(ATTRIBUTE_NAMES.ADDITIONAL_NOTES) || '';
  const allocatedTimeValue = getValue(ATTRIBUTE_NAMES.ALLOCATED_TIME);
  const allocatedTime = allocatedTimeValue !== null && allocatedTimeValue !== undefined
    ? (typeof allocatedTimeValue === 'number' ? allocatedTimeValue : Number(allocatedTimeValue) || 0)
    : undefined;

  const transformedData = {
    participant: participantName,
    service,
    serviceProvider,
    deliveredBy: deliveredByName,
    scheduledStart,
    scheduledServiceDate: scheduledStart,
    scheduledShiftStart: scheduledStart,
    scheduledShiftStartDateTime: scheduledStart,
    actualEnd,
    actualShiftEndDateTime: actualEnd,
    serviceDeliveryDate: actualEnd,
    transactionStatus,
    committedAtHmForDelivery,
    unit,
    quantity,
    unitPrice,
    totalAmount,
    govSubsidy,
    participantContribution,
    fundingSource,
    notes,
    allocatedTime,
  };

  setCachedMSService(workspaceId, boardId, itemId, transformedData);
  return transformedData;
}
