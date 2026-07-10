export function evaluateLegacyServicePlanIntegration({
  selectedItem,
  providerTravelClaimable,
  labourTravelTimePrice,
  ndiaReportsClaimable,
  allowancesType,
  allowancesPrice,
  nonFaceToFaceClaimable,
  nonFaceToFaceSupportPrice,
  hasNonZeroValue,
}) {
  if (!selectedItem) {
    return { integrationMessage: 'Error: No Item Number Selected', fallbackColor: '#C60909' };
  }
  if (!providerTravelClaimable && hasNonZeroValue(labourTravelTimePrice)) {
    return { integrationMessage: 'Error: Labour Travel Time is not claimable from the NDIA.', fallbackColor: '#EE691E' };
  }
  if (!ndiaReportsClaimable && allowancesType === 'NDIA Requested Reports' && hasNonZeroValue(allowancesPrice)) {
    return { integrationMessage: 'Error: NDIA Requested Reports cost is not claimable from the NDIA.', fallbackColor: '#D99C05' };
  }
  if (!nonFaceToFaceClaimable && hasNonZeroValue(nonFaceToFaceSupportPrice)) {
    return { integrationMessage: 'Error: Non-face-to-face support provision is not claimable from the NDIA.', fallbackColor: '#CA56A8' };
  }
  return { integrationMessage: 'Aligned and Correct Selection', fallbackColor: '#388903' };
}

export function buildParticipantNameValue(participantProfileValues, normalizeStringValue) {
  let participantNameValue = normalizeStringValue(participantProfileValues?.fullName);
  if (participantNameValue) return participantNameValue;
  const firstName = normalizeStringValue(participantProfileValues?.firstName);
  const lastName = normalizeStringValue(participantProfileValues?.lastName);
  return `${firstName ? firstName + (firstName && lastName ? ' ' : '') : ''}${lastName ? lastName : ''}`.trim();
}

export function buildLegacyServicePlanVariableUpdates({
  getAttributeIdByName,
  participantNameValue,
  prioritizedItemNumber,
  itemValuesWithAttributeId,
  integrationMessage,
  fallbackColor,
  resolveConfigurationStatusLabelId,
}) {
  const updateValues = [];
  const servicePlanIdAttributeId = getAttributeIdByName('Service Plan ID');
  if (servicePlanIdAttributeId && participantNameValue && prioritizedItemNumber) {
    const servicePlanIdValue = `${participantNameValue} - ${prioritizedItemNumber}`.trim();
    if (servicePlanIdValue) {
      updateValues.push({ data: servicePlanIdValue, attribute_id: servicePlanIdAttributeId });
    }
  }
  const participantNameAttributeId = getAttributeIdByName('Participant Full Name');
  if (participantNameAttributeId && participantNameValue) {
    updateValues.push({ data: participantNameValue.trim(), attribute_id: participantNameAttributeId });
  }
  const statusAttribute = itemValuesWithAttributeId.find((v) => v.attribute?.name === 'Configuration Status');
  if (!statusAttribute) return { updateValues, missingStatus: true };
  const desiredStatusText = integrationMessage === 'Aligned and Correct Selection' ? integrationMessage : integrationMessage;
  const statusLabelId = resolveConfigurationStatusLabelId(statusAttribute, desiredStatusText, fallbackColor);
  if (statusLabelId) {
    updateValues.push({ data: [statusLabelId], attribute_id: statusAttribute.attribute.id });
  }
  return { updateValues, missingStatus: false };
}

const CONFIG_ITEM_NUMBER_SUFFIXES = ['TH', 'NF', 'RR', 'PT', 'CA'];

export function itemNumberContainsSuffix(itemNumber, suffix) {
  if (!itemNumber || !suffix) return false;
  return String(itemNumber).toUpperCase().trim().includes(`_${String(suffix).toUpperCase().trim()}`);
}

export function getItemNumberSuffix(itemNumber) {
  if (!itemNumber) return '';
  return CONFIG_ITEM_NUMBER_SUFFIXES.find((suffix) => itemNumberContainsSuffix(itemNumber, suffix)) || '';
}

export function evaluateNewServicePlanIntegration(ctx) {
  const {
    serviceAreaValues, sdm, hasParticipantIntakeForm, hasAnyItemNumber,
    itemsValues, expectedSuffix, supportSuffix,
    resolvedProviderTravelValues, resolvedLabourTravelValues,
    resolvedCancellationValues, resolvedActivityBasedTransportValues,
    hasSelectionValue, NDIS_SERVICEPLAN_ATTR,
  } = ctx;

  if (!serviceAreaValues?.serviceArea && !serviceAreaValues?.serviceAreaType) {
    return { integrationMessage: 'Error: No Service Area selected', fallbackColor: '#FFB186' };
  }
  if (!sdm) return { integrationMessage: 'Error: No Service Delivery Mode selected', fallbackColor: '#FFD3F2' };
  if (!hasParticipantIntakeForm) return { integrationMessage: 'Error: No Participant Intake Form Selected', fallbackColor: '#F36363' };
  if (!hasAnyItemNumber) return { integrationMessage: 'Error: No Item Number Selected', fallbackColor: '#C60909' };
  if (hasSelectionValue(itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT) && expectedSuffix !== null && supportSuffix !== expectedSuffix) {
    return { integrationMessage: 'Error: The selected Item Number does not match the selected Service Delivery Mode.', fallbackColor: '#EE691E' };
  }
  if (hasSelectionValue(itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR) && resolvedProviderTravelValues?.itemName && !resolvedProviderTravelValues.itemName.toLowerCase().includes('non-labour cost')) {
    return { integrationMessage: 'Error: The selected Item Number for Provider Travel - Non-Labour Cost is invalid.', fallbackColor: '#D99C05' };
  }
  if (hasSelectionValue(itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_LABOUR_TRAVEL_TIME) && resolvedLabourTravelValues?.itemNumber && !itemNumberContainsSuffix(resolvedLabourTravelValues.itemNumber, 'PT')) {
    return { integrationMessage: 'Error: The selected Item Number for Provider Travel - Labour Travel Time Costs is invalid.', fallbackColor: '#CA56A8' };
  }
  if (hasSelectionValue(itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_CANCELLATION) && resolvedCancellationValues?.itemNumber && !itemNumberContainsSuffix(resolvedCancellationValues.itemNumber, 'CA')) {
    return { integrationMessage: 'Error: The selected Item Number for Cancellation Costs is invalid.', fallbackColor: '#FFA2A2' };
  }
  if (hasSelectionValue(itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT) && resolvedActivityBasedTransportValues?.itemName && !resolvedActivityBasedTransportValues.itemName.toLowerCase().includes('activity based transport')) {
    return { integrationMessage: 'Error: The selected Item Number for Activity Based Transport Cost is invalid.', fallbackColor: '#FFE197' };
  }
  return { integrationMessage: 'Aligned and Correct Selection', fallbackColor: '#388903' };
}

export function buildNewServicePlanVariableUpdates({
  getAttributeIdByName,
  participantNameValue,
  prioritizedItemNumber,
  itemValuesWithAttributeId,
  integrationMessage,
  fallbackColor,
  resolveConfigurationStatusLabelId,
}) {
  const updateValues = [];
  const servicePlanIdAttributeId = getAttributeIdByName('Service Plan ID');
  if (servicePlanIdAttributeId && participantNameValue && prioritizedItemNumber) {
    const servicePlanIdValue = `${participantNameValue} - ${prioritizedItemNumber}`.trim();
    if (servicePlanIdValue) updateValues.push({ data: servicePlanIdValue, attribute_id: servicePlanIdAttributeId });
  }
  const participantNameAttributeId = getAttributeIdByName('Participant Full Name');
  if (participantNameAttributeId && participantNameValue) {
    updateValues.push({ data: participantNameValue.trim(), attribute_id: participantNameAttributeId });
  }
  const statusAttribute = itemValuesWithAttributeId.find((v) => v.attribute?.name === 'Configuration Status');
  if (!statusAttribute) return { updateValues, missingStatus: true };
  const statusLabelId = resolveConfigurationStatusLabelId(statusAttribute, integrationMessage, fallbackColor);
  if (statusLabelId) updateValues.push({ data: [statusLabelId], attribute_id: statusAttribute.attribute.id });
  return { updateValues, missingStatus: false };
}
