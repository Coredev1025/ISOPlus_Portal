const LEGACY_RESET_ATTR_NAMES = [
  'Direct Support Value($) - Time Based Support',
  'Direct Support Value($) - Non Time Based Support',
  'Provider Travel - Non-Labour Cost Amount($)',
  'Activity Base Transport Amount($)',
  'Centre Capital Costs Amount($)',
  'Labour Travel Time Amount($)',
  'Allowances Amount($)',
  'Non-Face-to-Face Amount($)',
  'Cancellation Fee($)',
];

const NEW_RESET_ATTR_NAMES = (NDIS_MASTERPLAN_ATTR) => [
  NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE,
  NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_NON_LABOUR_AMOUNT,
  NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT,
  NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_AMOUNT,
  NDIS_MASTERPLAN_ATTR.ALLOWANCES_AMOUNT,
  NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE,
];

export function buildMasterPlanAttributeFinder(itemValuesWithAttributeId) {
  return (name) => itemValuesWithAttributeId.find((v) => v.attribute?.name === name)?.attribute?.id;
}

export function buildMasterPlanResetValues(findAttrId, attrNames) {
  const resetValues = [];
  for (const name of attrNames) {
    const id = findAttrId(name);
    if (id) resetValues.push({ data: 0, attribute_id: id });
  }
  return resetValues;
}

export async function tryResetMasterPlanValues({
  workspaceId,
  boardId,
  itemId,
  resetValues,
  putMasterPlanItemValues,
  warn,
  extractIsoPlusErrorDetail,
  req,
}) {
  if (!resetValues.length) return;
  try {
    await putMasterPlanItemValues(workspaceId, boardId, itemId, resetValues);
  } catch (resetErr) {
    warn('Xero-Service', 'Master plan reset values failed (continuing with calculated values)', {
      workspaceId,
      boardId,
      itemId,
      status: resetErr?.response?.status,
      detail: extractIsoPlusErrorDetail(resetErr),
    }, req ?? null);
  }
}

function computeShiftQuantity(itemsValues, durationKey) {
  const duration = Number(itemsValues[durationKey]);
  return duration > 0 ? Number(duration.toFixed(1)) : 0;
}

export function buildNewMasterPlanSupportUpdate({
  findAttrId,
  NDIS_MASTERPLAN_ATTR,
  servicePlanValues,
  itemsValues,
  groupSize,
  isHourUnit,
  formatValue,
  toApiNumber,
}) {
  const supportAttrId = findAttrId(NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE);
  if (!supportAttrId) return null;

  let supportValue;
  if (isHourUnit(servicePlanValues?.supportUnit)) {
    const qty = computeShiftQuantity(itemsValues, 'Actual Shift Duration(Hr.)');
    supportValue = formatValue((servicePlanValues?.supportUnitPrice || 0) * qty / groupSize);
  } else {
    const qty = Number(itemsValues['Quantity (Non-Time-Based Support)']) || 0;
    supportValue = formatValue((servicePlanValues?.supportUnitPrice || 0) * qty);
  }
  return { data: toApiNumber(supportValue), attribute_id: supportAttrId };
}

export function buildNewMasterPlanProviderTravelUpdate({
  findAttrId,
  NDIS_MASTERPLAN_ATTR,
  servicePlanValues,
  itemsValues,
  formatValue,
  toApiNumber,
  computeProviderTravelNonLabourAmount,
}) {
  if (!servicePlanValues?.nonLabourTravelUnitPrice) return null;
  const ptId = findAttrId(NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_NON_LABOUR_AMOUNT);
  if (!ptId) return null;

  const mileage = Number(itemsValues[NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_MILEAGE]) || 0;
  const otherCosts = Number(
    itemsValues['Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied ($)']
    || itemsValues[NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_OTHER_COSTS],
  ) || 0;
  const amount = formatValue(computeProviderTravelNonLabourAmount(servicePlanValues.nonLabourTravelUnitPrice, mileage, otherCosts));
  return { data: toApiNumber(amount), attribute_id: ptId };
}

export function buildNewMasterPlanActivityTransportUpdate({
  findAttrId,
  NDIS_MASTERPLAN_ATTR,
  servicePlanValues,
  itemsValues,
  formatValue,
  toApiNumber,
  computeActivityBaseTransportAmount,
}) {
  if (!servicePlanValues?.activityBasedTransportUnitPrice) return null;
  const abtId = findAttrId(NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT);
  if (!abtId) return null;

  const mileage = Number(itemsValues[NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_MILEAGE]) || 0;
  const otherCosts = Number(itemsValues[NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_OTHER_COSTS]) || 0;
  const amount = formatValue(computeActivityBaseTransportAmount(servicePlanValues.activityBasedTransportUnitPrice, mileage, otherCosts));
  return { data: toApiNumber(amount), attribute_id: abtId };
}

export function buildNewMasterPlanLabourTravelUpdate({
  findAttrId,
  NDIS_MASTERPLAN_ATTR,
  servicePlanValues,
  itemsValues,
  formatValue,
  toApiNumber,
  computeLabourTravelTimeAmount,
}) {
  if (!servicePlanValues?.labourTravelTimeUnitPrice) return null;
  const lttId = findAttrId(NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_AMOUNT);
  if (!lttId) return null;

  const minutes = Number(itemsValues[NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_MIN]) || 0;
  const amount = formatValue(computeLabourTravelTimeAmount(servicePlanValues.labourTravelTimeUnitPrice, minutes));
  return { data: toApiNumber(amount), attribute_id: lttId };
}

export function buildNewMasterPlanAllowancesUpdate({
  findAttrId,
  NDIS_MASTERPLAN_ATTR,
  itemsValues,
  formatValue,
  toApiNumber,
}) {
  if (!itemsValues['Used Allowance Amount($) as per the Service Plan']) return null;
  const allowId = findAttrId(NDIS_MASTERPLAN_ATTR.ALLOWANCES_AMOUNT);
  if (!allowId) return null;

  const amount = formatValue(itemsValues[NDIS_MASTERPLAN_ATTR.USED_ALLOWANCE_AMOUNT] || 0);
  return { data: toApiNumber(amount), attribute_id: allowId };
}

export function buildNewMasterPlanActiveUpdates(ctx) {
  const updates = [
    buildNewMasterPlanSupportUpdate(ctx),
    buildNewMasterPlanProviderTravelUpdate(ctx),
    buildNewMasterPlanActivityTransportUpdate(ctx),
    buildNewMasterPlanLabourTravelUpdate(ctx),
    buildNewMasterPlanAllowancesUpdate(ctx),
  ].filter(Boolean);
  return updates;
}

export function buildNewMasterPlanCancellationUpdate({
  findAttrId,
  NDIS_MASTERPLAN_ATTR,
  servicePlanValues,
  itemsValues,
  formatValue,
  toApiNumber,
}) {
  const cancFeeId = findAttrId(NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE);
  if (!cancFeeId) return null;

  const scheduledDuration = computeShiftQuantity(itemsValues, 'Scheduled Shift Duration(Hr.)');
  const cancUnitPrice = Number(servicePlanValues?.cancellationUnitPrice) || 0;
  const amount = formatValue(scheduledDuration * cancUnitPrice);
  return { data: toApiNumber(amount), attribute_id: cancFeeId };
}

export function buildNewMasterPlanFundStatusUpdate({
  fundValues,
  itemValuesWithAttributeId,
  resolveConfigurationStatusLabelId,
}) {
  if (!fundValues) return null;
  const fundStatusAttr = itemValuesWithAttributeId.find((v) => v.attribute?.name === 'Funding Budget Status');
  if (!fundStatusAttr?.attribute?.id) return null;

  const statusLabelId = resolveConfigurationStatusLabelId(
    fundStatusAttr,
    fundValues.fundingBudgetStatus,
    '#388903',
  );
  if (!statusLabelId) return null;
  return { data: [statusLabelId], attribute_id: fundStatusAttr.attribute.id };
}

export async function handleMasterPlanNew(req, res, deps) {
  const { workspaceId, boardId } = req.params;
  const items = req.body?.items?.[0];
  if (!items?.id) {
    return res.status(200).json({ error: 'Invalid payload', message: 'Missing item id' });
  }

  try {
    const itemsValues = items.values;
    const [servicePlanValues, , fundValues] = await deps.getNDISMasterPlanNewPricingReferencedItems(workspaceId, boardId, items.id);

    if (!servicePlanValues) {
      deps.setIntegrationMessage(workspaceId, boardId, items.id, 'Service Plan Item not found');
      return res.status(200).json({ error: 'Service Plan Item not found' });
    }

    const responseItemValues = await deps.getItemValues(workspaceId, boardId, items.id);
    const itemValuesWithAttributeId = responseItemValues.values;
    const groupSize = Number(itemsValues['Group Size']) || 1;
    const findAttrId = buildMasterPlanAttributeFinder(itemValuesWithAttributeId);
    const cancelled = deps.isShiftCancelled(itemsValues);

    await deps.setIntegrationMessage(workspaceId, boardId, items.id, 'Calculating values...');
    const resetValues = buildMasterPlanResetValues(findAttrId, NEW_RESET_ATTR_NAMES(deps.NDIS_MASTERPLAN_ATTR));
    await tryResetMasterPlanValues({
      workspaceId,
      boardId,
      itemId: items.id,
      resetValues,
      putMasterPlanItemValues: deps.putMasterPlanItemValues,
      warn: deps.warn,
      extractIsoPlusErrorDetail: deps.extractIsoPlusErrorDetail,
      req,
    });

    const amountCtx = {
      findAttrId,
      NDIS_MASTERPLAN_ATTR: deps.NDIS_MASTERPLAN_ATTR,
      servicePlanValues,
      itemsValues,
      groupSize,
      isHourUnit: deps.isHourUnit,
      formatValue: deps.formatValue,
      toApiNumber: deps.toApiNumber,
      computeProviderTravelNonLabourAmount: deps.computeProviderTravelNonLabourAmount,
      computeActivityBaseTransportAmount: deps.computeActivityBaseTransportAmount,
      computeLabourTravelTimeAmount: deps.computeLabourTravelTimeAmount,
    };

    const updateValues = cancelled
      ? [buildNewMasterPlanCancellationUpdate(amountCtx)].filter(Boolean)
      : buildNewMasterPlanActiveUpdates(amountCtx);

    const fundUpdate = buildNewMasterPlanFundStatusUpdate({
      fundValues,
      itemValuesWithAttributeId,
      resolveConfigurationStatusLabelId: deps.resolveConfigurationStatusLabelId,
    });
    if (fundUpdate) updateValues.push(fundUpdate);

    if (updateValues.length === 0) {
      deps.setIntegrationMessage(workspaceId, boardId, items.id, 'No master plan values to update');
      return res.status(200).json({ message: 'No master plan values to update' });
    }

    const response = await deps.putMasterPlanItemValues(workspaceId, boardId, items.id, updateValues);
    if (response.status === 200) {
      deps.setIntegrationMessage(workspaceId, boardId, items.id, 'Master plan processed successfully');
      return res.status(200).json({ message: 'Master plan processed' });
    }
    deps.setIntegrationMessage(workspaceId, boardId, items.id, 'Failed to update master plan');
    return res.status(200).json({ error: 'Failed to update master plan' });
  } catch (err) {
    const isoPlusDetail = deps.extractIsoPlusErrorDetail(err);
    deps.error('Xero-Service', 'Master plan new pricing automation failed', {
      workspaceId,
      boardId,
      status: err?.response?.status,
      detail: isoPlusDetail,
      message: err?.message,
      stack: err?.stack,
    }, req ?? null);
    deps.setIntegrationMessage(
      workspaceId,
      boardId,
      items?.id,
      `Master plan update failed: ${isoPlusDetail}`,
    );
    return res.status(200).json({ error: 'Master plan failed', message: isoPlusDetail || err?.message || 'Server error' });
  }
}

function findLegacyAttrId(itemValuesWithAttributeId, name) {
  return itemValuesWithAttributeId.find((v) => v.attribute.name === name)?.attribute?.id;
}

export function buildLegacyMasterPlanResetPayload(itemValuesWithAttributeId) {
  return LEGACY_RESET_ATTR_NAMES.map((name) => ({
    data: 0,
    attribute_id: findLegacyAttrId(itemValuesWithAttributeId, name),
  })).filter((entry) => entry.attribute_id);
}

export function buildLegacyDirectSupportUpdates({
  servicePlanValues,
  itemsValues,
  groupSize,
  itemValuesWithAttributeId,
  formatValue,
}) {
  const timeAttrId = findLegacyAttrId(itemValuesWithAttributeId, 'Direct Support Value($) - Time Based Support');
  const nonTimeAttrId = findLegacyAttrId(itemValuesWithAttributeId, 'Direct Support Value($) - Non Time Based Support');
  if (!timeAttrId || !nonTimeAttrId) return [];

  if (servicePlanValues?.directSupportUnit === 'Hour(H)') {
    const qty = computeShiftQuantity(itemsValues, 'Actual Shift Duration(Hr.)');
    return [
      { data: formatValue(servicePlanValues.directSupportUnitPrice * qty / groupSize), attribute_id: timeAttrId },
      { data: 0, attribute_id: nonTimeAttrId },
    ];
  }

  return [
    {
      data: formatValue(servicePlanValues?.directSupportUnitPrice * (itemsValues['Quantity (Direct Support - Non Time Based Support)'] || 0)),
      attribute_id: nonTimeAttrId,
    },
    { data: 0, attribute_id: timeAttrId },
  ];
}

function buildLegacyOptionalAmountUpdate(itemValuesWithAttributeId, attrName, amount) {
  const attrId = findLegacyAttrId(itemValuesWithAttributeId, attrName);
  if (!attrId) return null;
  return { data: amount, attribute_id: attrId };
}

function buildLegacyProviderTravelUpdate(servicePlanValues, itemsValues, itemValuesWithAttributeId, formatValue) {
  if (!servicePlanValues?.nonLabourTravelUnitPrice) return null;
  const mileage = itemsValues['Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a vehicle is used.'] || 0;
  const other = itemsValues['Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied.'] || 0;
  return buildLegacyOptionalAmountUpdate(
    itemValuesWithAttributeId,
    'Provider Travel - Non-Labour Cost Amount($)',
    formatValue(servicePlanValues.nonLabourTravelUnitPrice * (Number(mileage) + Number(other))),
  );
}

function buildLegacyActivityTransportUpdate(servicePlanValues, itemsValues, itemValuesWithAttributeId, formatValue, computeActivityBaseTransportAmount, NDIS_MASTERPLAN_ATTR) {
  if (!servicePlanValues?.activityBasedTransportUnitPrice) return null;
  return buildLegacyOptionalAmountUpdate(
    itemValuesWithAttributeId,
    NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT,
    formatValue(computeActivityBaseTransportAmount(
      servicePlanValues.activityBasedTransportUnitPrice,
      itemsValues[NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_MILEAGE] || 0,
      itemsValues[NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_OTHER_COSTS] || 0,
    )),
  );
}

function buildLegacyCentreCapitalUpdate(servicePlanValues, itemsValues, itemValuesWithAttributeId, formatValue) {
  const centreCapitalAttr = 'Centre Capital Costs Amount($)';
  if (servicePlanValues?.centreCapitalCostsUnitPrice) {
    const qty = computeShiftQuantity(itemsValues, 'Actual Shift Duration(Hr.)');
    return buildLegacyOptionalAmountUpdate(
      itemValuesWithAttributeId,
      centreCapitalAttr,
      formatValue(servicePlanValues.centreCapitalCostsUnitPrice * qty),
    );
  }
  return buildLegacyOptionalAmountUpdate(itemValuesWithAttributeId, centreCapitalAttr, 0);
}

function buildLegacyLabourTravelUpdate(servicePlanValues, itemsValues, itemValuesWithAttributeId, formatValue) {
  if (!servicePlanValues?.labourTravelTimeUnitPrice) return null;
  const labourMin = itemsValues['Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable.'] || 0;
  return buildLegacyOptionalAmountUpdate(
    itemValuesWithAttributeId,
    'Labour Travel Time Amount($)',
    formatValue(servicePlanValues.labourTravelTimeUnitPrice * labourMin),
  );
}

function buildLegacyAllowancesUpdate(itemsValues, itemValuesWithAttributeId, formatValue) {
  if (!itemsValues['Used Allowance Amount($) as per the Service Plan']) return null;
  return buildLegacyOptionalAmountUpdate(
    itemValuesWithAttributeId,
    'Allowances Amount($)',
    formatValue(itemsValues['Used Allowance Amount($) as per the Service Plan'] || 0),
  );
}

function buildLegacyNonFaceToFaceUpdate(servicePlanValues, itemsValues, itemValuesWithAttributeId, formatValue) {
  if (!servicePlanValues?.nonFaceToFaceSupportUnitPrice) return null;
  return buildLegacyOptionalAmountUpdate(
    itemValuesWithAttributeId,
    'Non-Face-to-Face Amount($)',
    formatValue(servicePlanValues.nonFaceToFaceSupportUnitPrice * (itemsValues['Time spent in the Non-Face-to-Face Amount as per the Service Plan (Hr.)'] || 0)),
  );
}

export function buildLegacyActiveServiceAmounts({
  servicePlanValues,
  itemsValues,
  itemValuesWithAttributeId,
  formatValue,
  computeActivityBaseTransportAmount,
  NDIS_MASTERPLAN_ATTR,
}) {
  const optionalUpdates = [
    buildLegacyProviderTravelUpdate(servicePlanValues, itemsValues, itemValuesWithAttributeId, formatValue),
    buildLegacyActivityTransportUpdate(servicePlanValues, itemsValues, itemValuesWithAttributeId, formatValue, computeActivityBaseTransportAmount, NDIS_MASTERPLAN_ATTR),
    buildLegacyCentreCapitalUpdate(servicePlanValues, itemsValues, itemValuesWithAttributeId, formatValue),
    buildLegacyLabourTravelUpdate(servicePlanValues, itemsValues, itemValuesWithAttributeId, formatValue),
    buildLegacyAllowancesUpdate(itemsValues, itemValuesWithAttributeId, formatValue),
    buildLegacyNonFaceToFaceUpdate(servicePlanValues, itemsValues, itemValuesWithAttributeId, formatValue),
  ].filter(Boolean);

  return [
    ...buildLegacyDirectSupportUpdates({
      servicePlanValues,
      itemsValues,
      groupSize: Number(itemsValues['Group Size']) || 1,
      itemValuesWithAttributeId,
      formatValue,
    }),
    ...optionalUpdates,
  ];
}

function computeLegacyDirectSupportCancellation({
  servicePlanValues,
  itemsValues,
  groupSize,
  scheduledShiftDuration,
  cancellationPercentage,
  formatValue,
}) {
  if (servicePlanValues?.directSupportShortNoticeCancellations !== 'Y') return 0;

  if (servicePlanValues?.directSupportUnit === 'Hour(H)') {
    const baseUnitPrice = groupSize > 0 ? Number(servicePlanValues.directSupportUnitPrice) / groupSize : 0;
    const unitPrice = Number(formatValue(baseUnitPrice * (cancellationPercentage / 100)));
    return Number(formatValue(scheduledShiftDuration * unitPrice));
  }

  const nonTimeBasedValue = Number(servicePlanValues.directSupportUnitPrice) || 0;
  const unitPrice = Number(formatValue(nonTimeBasedValue * (cancellationPercentage / 100)));
  const qty = Number(itemsValues['Quantity (Direct Support - Non Time Based Support)']) || 0;
  return Number(formatValue(qty * unitPrice));
}

function computeLegacyTravelCancellation(unitPrice, scheduledShiftDuration, cancellationPercentage, formatValue) {
  const adjusted = Number(formatValue(unitPrice * (cancellationPercentage / 100)));
  return Number(formatValue(scheduledShiftDuration * adjusted));
}

export function buildLegacyCancellationFeeUpdate({
  servicePlanValues,
  cancellationTypeValues,
  itemsValues,
  itemValuesWithAttributeId,
  formatValue,
}) {
  const cancellationPercentage = Number(cancellationTypeValues?.billableToClient) || 0;
  const scheduledShiftDuration = itemsValues['Scheduled Shift Duration(Hr.)'] > 0
    ? Number(Number(itemsValues['Scheduled Shift Duration(Hr.)']).toFixed(1))
    : 0;
  const groupSize = Number(itemsValues['Group Size']) || 1;

  let cancellationFee = computeLegacyDirectSupportCancellation({
    servicePlanValues,
    itemsValues,
    groupSize,
    scheduledShiftDuration,
    cancellationPercentage,
    formatValue,
  });

  if (servicePlanValues?.providerTravelShortNoticeCancellations === 'Y') {
    const baseUnitPrice = Number(servicePlanValues?.nonLabourTravelUnitPrice) || 0;
    cancellationFee += computeLegacyTravelCancellation(baseUnitPrice, scheduledShiftDuration, cancellationPercentage, formatValue);
  }
  if (servicePlanValues?.activityBasedTransportShortNoticeCancellations === 'Y') {
    const baseUnitPrice = Number(servicePlanValues?.activityBasedTransportUnitPrice) || 0;
    cancellationFee += computeLegacyTravelCancellation(baseUnitPrice, scheduledShiftDuration, cancellationPercentage, formatValue);
  }
  if (servicePlanValues?.centreCapitalCostsShortNoticeCancellations === 'Y') {
    const baseUnitPrice = Number(servicePlanValues?.centreCapitalCostsUnitPrice) || 0;
    cancellationFee += computeLegacyTravelCancellation(baseUnitPrice, scheduledShiftDuration, cancellationPercentage, formatValue);
  }

  const attrId = findLegacyAttrId(itemValuesWithAttributeId, 'Cancellation Fee($)');
  if (!attrId) return null;
  return { data: formatValue(cancellationFee), attribute_id: attrId };
}

export async function handleLegacyMasterPlan(req, res, deps) {
  const { workspaceId, boardId } = req.params;
  const items = req.body?.items?.[0];
  const itemsValues = items?.values || {};

  deps.info('Xero-Service', 'Incoming request to Master plan', { workspaceId, boardId, body: itemsValues }, req ?? null);

  const [servicePlanValues, cancellationTypeValues, fundValues] = await deps.getNDISMasterPlanReferencedItems(workspaceId, boardId, items.id);
  if (!servicePlanValues) {
    deps.setIntegrationMessage(workspaceId, boardId, items.id, 'Service Plan Item not found');
    return res.status(200).json({ error: 'Service Plan Item not found' });
  }

  const responseItemValues = await deps.getItemValues(workspaceId, boardId, items.id);
  const itemValuesWithAttributeId = responseItemValues.values;
  const cancelled = deps.isShiftCancelled(itemsValues);

  await deps.setIntegrationMessage(workspaceId, boardId, items.id, 'Calculating values...');
  await deps.putMasterPlanItemValues(
    workspaceId,
    boardId,
    items.id,
    buildLegacyMasterPlanResetPayload(itemValuesWithAttributeId),
  );

  const updateValues = [];
  if (!cancelled) {
    updateValues.push(...buildLegacyActiveServiceAmounts({
      servicePlanValues,
      itemsValues,
      itemValuesWithAttributeId,
      formatValue: deps.formatValue,
      computeActivityBaseTransportAmount: deps.computeActivityBaseTransportAmount,
      NDIS_MASTERPLAN_ATTR: deps.NDIS_MASTERPLAN_ATTR,
    }));
  }

  if (cancelled) {
    if (!cancellationTypeValues) {
      deps.setIntegrationMessage(workspaceId, boardId, items.id, 'A cancellation type is required.');
      return res.status(200).json({ error: 'A cancellation type is required.' });
    }
    const cancellationUpdate = buildLegacyCancellationFeeUpdate({
      servicePlanValues,
      cancellationTypeValues,
      itemsValues,
      itemValuesWithAttributeId,
      formatValue: deps.formatValue,
    });
    if (cancellationUpdate) updateValues.push(cancellationUpdate);
  }

  if (fundValues) {
    const fundAttrId = findLegacyAttrId(itemValuesWithAttributeId, 'Funding Budget Status');
    if (fundAttrId) {
      updateValues.push({ data: fundValues.fundingBudgetStatus, attribute_id: fundAttrId });
    }
  }

  const response = await deps.putMasterPlanItemValues(workspaceId, boardId, items.id, updateValues);
  if (response.status === 200) {
    deps.setIntegrationMessage(workspaceId, boardId, items.id, 'Master plan processed successfully');
    deps.info('Xero-Service', 'Master plan processed successfully', { updateValues }, req ?? null);
    return res.status(200).json({ message: 'Master plan processed' });
  }

  deps.setIntegrationMessage(workspaceId, boardId, items.id, 'Failed to update master plan');
  deps.warn('Xero-Service', 'Failed to update master plan', { updateValues }, req ?? null);
  return res.status(200).json({ error: 'Failed to update master plan' });
}
