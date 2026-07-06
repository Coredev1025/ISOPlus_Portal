function isPrimarySupplementOrUnspentHcp(name) {
  const n = (name || '').toLowerCase();
  return n.includes('primary supplement') || n.includes('unspent home care package') || n.includes('unspent hcp');
}

function resolveDeliveredByAndProvider(deliveredByRaw, businessProfile, item, refMap, helpers) {
  const { getValue, ATTR, extractRefId, getValueFromFlatData } = helpers;
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

  const apRefId = extractRefId(getValue(item, ATTR.ASSOCIATED_PROVIDER));
  const providerRefItem = apRefId ? refMap.get(apRefId) : null;
  const businessIndividual = providerRefItem
    ? getValueFromFlatData(providerRefItem, 'Business/Individual')
    : null;

  const serviceProvider = (businessIndividual != null && businessIndividual !== '')
    ? (typeof businessIndividual === 'object' && businessIndividual.name
      ? businessIndividual.name
      : String(businessIndividual))
    : (apRefId || undefined);

  return { deliveredByName, serviceProvider };
}

function resolveFundingSourceLabel(p, refMap, serviceCategory, helpers) {
  const { getFundingSourceName, stripEmoji } = helpers;
  if (!p.fundingSourceIds.length) return undefined;

  const names = [];
  for (const fsId of p.fundingSourceIds) {
    let fsName = getFundingSourceName(refMap.get(fsId));
    if (!fsName) continue;
    if (serviceCategory && isPrimarySupplementOrUnspentHcp(fsName)) {
      fsName = `${fsName} - ${stripEmoji(serviceCategory)}`;
    }
    names.push(fsName);
  }
  return names.length ? names.join(', ') : undefined;
}

function resolveServiceCategory(servicePlanItem, helpers) {
  const { getValueFromFlatData, ATTR } = helpers;
  const serviceCategoryRaw = servicePlanItem
    ? getValueFromFlatData(servicePlanItem, ['Service Category', ATTR.SERVICE_CATEGORY])
    : null;
  if (!serviceCategoryRaw) return '';
  return typeof serviceCategoryRaw === 'object' && serviceCategoryRaw.name
    ? serviceCategoryRaw.name
    : String(serviceCategoryRaw).trim();
}

function parseAllocatedTime(item, helpers) {
  const { getValueMulti } = helpers;
  const allocatedTimeValue = getValueMulti(item, ['Allocated time (Hr.)', 'Allocated Time (Hr.)']);
  if (allocatedTimeValue === null || allocatedTimeValue === undefined) return undefined;
  return typeof allocatedTimeValue === 'number'
    ? allocatedTimeValue
    : Number(allocatedTimeValue) || 0;
}

export function transformProcessedServiceItem(p, refMap, businessProfile, helpers) {
  const {
    item,
    scheduledStart,
    actualEnd,
    participantName,
    getValue,
    ATTR,
    formatStatus,
    parseNumber,
    getServiceFromServicePlan,
  } = helpers;

  const committedAtHm = getValue(item, ATTR.COMMITTED_AT_HM);
  const servicePlanItem = p.servicePlanId ? refMap.get(p.servicePlanId) : null;
  const service = getServiceFromServicePlan(servicePlanItem) || '';

  const { deliveredByName, serviceProvider } = resolveDeliveredByAndProvider(
    getValue(item, ATTR.DELIVERED_BY),
    businessProfile,
    item,
    refMap,
    helpers,
  );

  const serviceCategory = resolveServiceCategory(servicePlanItem, helpers);
  const fundingSource = resolveFundingSourceLabel(p, refMap, serviceCategory, helpers);

  return {
    id: item.itemId,
    participant: participantName,
    service,
    serviceProvider,
    deliveredBy: deliveredByName,
    updatedAt: item.updatedAt,
    createdAt: item.createdAt,
    scheduledStart,
    scheduledServiceDate: scheduledStart,
    scheduledShiftStart: scheduledStart,
    scheduledShiftStartDateTime: scheduledStart,
    actualEnd,
    actualShiftEndDateTime: actualEnd,
    serviceDeliveryDate: actualEnd,
    serviceCategory,
    transactionStatus: formatStatus(getValue(item, ATTR.TRANSACTION_STATUS)),
    committedAtHmForDelivery: committedAtHm !== null && committedAtHm !== undefined
      ? (typeof committedAtHm === 'number' ? committedAtHm : Number(committedAtHm) || 0)
      : undefined,
    unit: getValue(item, ATTR.UNIT) || 'Hour',
    quantity: parseNumber(getValue(item, ATTR.QUANTITY)) || 0,
    unitPrice: parseNumber(getValue(item, ATTR.UNIT_PRICE)) || 0,
    totalAmount: parseNumber(getValue(item, ATTR.TOTAL_AMOUNT)) || 0,
    govSubsidy: parseNumber(getValue(item, ATTR.GOV_SUBSIDY)) || 0,
    participantContribution: parseNumber(getValue(item, ATTR.PARTICIPANT_CONTRIBUTION)) || 0,
    fundingSource,
    notes: getValue(item, ATTR.ADDITIONAL_NOTES) || '',
    allocatedTime: parseAllocatedTime(item, helpers),
  };
}
