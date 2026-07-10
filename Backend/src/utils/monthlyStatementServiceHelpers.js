export function resolveServiceItemFilterDate({
  useActualEnd,
  statusNorm,
  scheduledStartDate,
  actualEndDate,
  item,
}) {
  if (useActualEnd) return actualEndDate;
  const isAdjustmentLike =
    statusNorm.includes('adjust') || statusNorm.includes('refund') || statusNorm.includes('charge');
  if (isAdjustmentLike) {
    return (
      scheduledStartDate ||
      actualEndDate ||
      (item.updatedAt ? new Date(item.updatedAt) : null) ||
      (item.createdAt ? new Date(item.createdAt) : null)
    );
  }
  return scheduledStartDate;
}

export function mapRawServiceItem(item, profileMap, fundingSourceMap, helpers) {
  const {
    getValue,
    ATTR,
    formatStatus,
    normalizeString,
    DELIVERED_STATUS,
    parseDate,
    extractRefId,
    extractAllRefIds,
    getParticipantName,
    getFundingSourceName,
  } = helpers;

  const scheduledStart = getValue(item, ATTR.SCHEDULED_START);
  const actualEnd = getValue(item, ATTR.ACTUAL_END);
  const statusFormatted = formatStatus(getValue(item, ATTR.TRANSACTION_STATUS));
  const useActualEnd = normalizeString(statusFormatted) === normalizeString(DELIVERED_STATUS);
  const scheduledStartDate = parseDate(scheduledStart);
  const actualEndDate = parseDate(actualEnd);
  const statusNorm = normalizeString(statusFormatted);

  const profileValue = getValue(item, ATTR.PARTICIPANT_PROFILE);
  const profileId = extractRefId(profileValue);
  let participantName = profileId ? (getParticipantName(profileMap.get(profileId)) || '') : '';
  if (!participantName) participantName = getValue(item, ATTR.PARTICIPANT_FULL_NAME) || '';

  const fundingSourceIds = extractAllRefIds(getValue(item, ATTR.FUNDING_SOURCE));
  const fundingSourceResolvedBase = fundingSourceIds.length
    ? fundingSourceIds.map((id) => getFundingSourceName(fundingSourceMap.get(id))).filter(Boolean).join(', ')
    : '';

  return {
    item,
    scheduledStartDate,
    actualEndDate,
    scheduledStart,
    actualEnd,
    filterDate: resolveServiceItemFilterDate({
      useActualEnd,
      statusNorm,
      scheduledStartDate,
      actualEndDate,
      item,
    }),
    participantName: String(participantName),
    profileValue,
    statusFormatted: statusFormatted || '',
    servicePlanId: extractRefId(getValue(item, ATTR.SERVICE_PLAN)),
    fundingSourceIds,
    fundingSourceResolvedBase,
  };
}

export function filterProcessedServiceItems(processed, filters) {
  const {
    participantParam,
    startDate,
    endDate,
    transactionStatusFilter,
    fundingSourceFilter,
  } = filters;

  let result = processed;

  if (participantParam && participantParam !== 'all') {
    try {
      const escapedParticipantParam = participantParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escapedParticipantParam, 'i');
      result = result.filter((p) =>
        re.test(p.participantName) ||
        (p.profileValue && (
          (typeof p.profileValue === 'string' && re.test(p.profileValue)) ||
          (Array.isArray(p.profileValue) && p.profileValue.some((v) => re.test(String(v)))) ||
          (typeof p.profileValue === 'object' && p.profileValue.id && re.test(String(p.profileValue.id)))
        )),
      );
    } catch {
      /* invalid regex */
    }
  }

  if (startDate) {
    const d = new Date(startDate);
    result = result.filter((p) => p.filterDate && p.filterDate >= d);
  }
  if (endDate) {
    const d = new Date(endDate);
    result = result.filter((p) => p.filterDate && p.filterDate <= d);
  }

  if (transactionStatusFilter && transactionStatusFilter.toLowerCase() !== 'all') {
    const v = transactionStatusFilter.trim();
    result = result.filter((p) => p.statusFormatted === v);
  }

  if (fundingSourceFilter && fundingSourceFilter !== 'all') {
    const fv = fundingSourceFilter.trim();
    result = result.filter((p) => p.fundingSourceResolvedBase && p.fundingSourceResolvedBase === fv);
  }

  return result;
}
