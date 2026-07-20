export function buildNdisUnitPriceMapping({
  safeGet,
  itemsValues,
  serviceAreaValues,
  pricingValues,
  itemNumberKey,
  unitAttr,
  unitPriceAttr,
}) {
  return {
    itemId: safeGet(itemsValues, itemNumberKey),
    serviceArea: serviceAreaValues.serviceAreaType,
    unit: pricingValues.unit,
    unitAttr,
    unitPrice: pricingValues[serviceAreaValues.serviceAreaType],
    unitPriceAttr,
  };
}

export async function applyServiceAreaQuotePricingUpdates({
  workspaceId,
  boardId,
  itemId,
  itemsValues,
  serviceAreaValues,
  directSupportValues,
  activityBasedTransportValues,
  providerTravelValues,
  centreCapitalCostsValues,
  safeGet,
  handleUpdate,
}) {
  if (directSupportValues) {
    await handleUpdate(
      workspaceId,
      boardId,
      itemId,
      buildNdisUnitPriceMapping({
        safeGet,
        itemsValues,
        serviceAreaValues,
        pricingValues: directSupportValues,
        itemNumberKey: 'Direct Support Item Number',
        unitAttr: 'Unit (Direct Support)',
        unitPriceAttr: 'Unit Price for Direct Support($)',
      }),
      'direct_support',
      'Direct Support',
    );
  }
  if (activityBasedTransportValues) {
    await handleUpdate(
      workspaceId,
      boardId,
      itemId,
      buildNdisUnitPriceMapping({
        safeGet,
        itemsValues,
        serviceAreaValues,
        pricingValues: activityBasedTransportValues,
        itemNumberKey: 'Activity Based Transport Item Number',
        unitAttr: 'Unit (Activity Based Transport)',
        unitPriceAttr: 'Unit Price for Activity Based Transport($)',
      }),
      'activity_based_transport',
      'Activity Based Transport',
    );
  }
  if (providerTravelValues) {
    await handleUpdate(
      workspaceId,
      boardId,
      itemId,
      buildNdisUnitPriceMapping({
        safeGet,
        itemsValues,
        serviceAreaValues,
        pricingValues: providerTravelValues,
        itemNumberKey: 'Provider Travel - Non-Labour Cost Item Number',
        unitAttr: 'Unit (Provider Travel - Non-Labour Cost)',
        unitPriceAttr: 'Unit Price for Provider Travel($)',
      }),
      'provider_travel_non_labour_cost',
      'Provider Travel Non Labour Cost',
    );
  }
  if (centreCapitalCostsValues) {
    await handleUpdate(
      workspaceId,
      boardId,
      itemId,
      buildNdisUnitPriceMapping({
        safeGet,
        itemsValues,
        serviceAreaValues,
        pricingValues: centreCapitalCostsValues,
        itemNumberKey: 'Centre Capital Costs Item',
        unitAttr: 'Unit (Centre Capital Costs)',
        unitPriceAttr: 'Unit Price for Centre Capital Costs($)',
      }),
      'centre_capital_cost',
      'Centre Capital Costs',
    );
  }
}

export async function applyServiceAreaParticipantsPlanPricingUpdates(ctx) {
  const {
    workspaceId,
    boardId,
    itemId,
    itemsValues,
    serviceAreaValues,
    directSupportValues,
    activityBasedTransportValues,
    providerTravelValues,
    centreCapitalCostsValues,
    safeGet,
    handleUpdate,
  } = ctx;

  if (directSupportValues) {
    await handleUpdate(
      workspaceId,
      boardId,
      itemId,
      buildNdisUnitPriceMapping({
        safeGet,
        itemsValues,
        serviceAreaValues,
        pricingValues: directSupportValues,
        itemNumberKey: 'Direct Support Item Number',
        unitAttr: 'Unit (Direct Support)',
        unitPriceAttr: 'Agreed Unit Price for Direct Support ($)',
      }),
      'direct_support',
      'Direct Support',
      'Participants-Service-Plan',
    );
  }
  if (activityBasedTransportValues) {
    await handleUpdate(
      workspaceId,
      boardId,
      itemId,
      buildNdisUnitPriceMapping({
        safeGet,
        itemsValues,
        serviceAreaValues,
        pricingValues: activityBasedTransportValues,
        itemNumberKey: 'Activity Based Transport Item Number',
        unitAttr: 'Unit (Activity Based Transport)',
        unitPriceAttr: 'Agreed Price for Activity Based Transport ($)',
      }),
      'activity_based_transport',
      'Activity Based Transport',
      'Participants-Service-Plan',
    );
  }
  if (providerTravelValues) {
    await handleUpdate(
      workspaceId,
      boardId,
      itemId,
      buildNdisUnitPriceMapping({
        safeGet,
        itemsValues,
        serviceAreaValues,
        pricingValues: providerTravelValues,
        itemNumberKey: 'Provider Travel - Non-Labour Cost Item Number',
        unitAttr: 'Unit (Provider Travel - Non-Labour Cost)',
        unitPriceAttr: 'Agreed Unit Price for Non-Labour Travel ($)',
      }),
      'provider_travel_non_labour_cost',
      'Provider Travel Non Labour Cost',
      'Participants-Service-Plan',
    );
  }
  if (centreCapitalCostsValues) {
    await handleUpdate(
      workspaceId,
      boardId,
      itemId,
      buildNdisUnitPriceMapping({
        safeGet,
        itemsValues,
        serviceAreaValues,
        pricingValues: centreCapitalCostsValues,
        itemNumberKey: 'Centre Capital Costs Item',
        unitAttr: 'Unit (Centre Capital Costs)',
        unitPriceAttr: 'Agreed Unit Price for Centre Capital Costs ($)',
      }),
      'centre_capital_cost',
      'Centre Capital Costs',
      'Participants-Service-Plan',
    );
  }
}

export async function processParticipantsServicePlanType({
  normalizedType,
  workspaceId,
  boardId,
  items,
  itemsValues,
  serviceAreaValues,
  directSupportValues,
  activityBasedTransportValues,
  providerTravelValues,
  centreCapitalCostsValues,
  safeGet,
  handleUpdate,
  updateVariablesParticipantsServicePlan,
  info,
  warn,
  req,
}) {
  switch (normalizedType) {
    case 'service_area': {
      if (!serviceAreaValues) return { status: 200, body: { error: 'Service Area Item not found' } };
      await applyServiceAreaParticipantsPlanPricingUpdates({
        workspaceId,
        boardId,
        itemId: items.id,
        itemsValues,
        serviceAreaValues,
        directSupportValues,
        activityBasedTransportValues,
        providerTravelValues,
        centreCapitalCostsValues,
        safeGet,
        handleUpdate,
      });
      await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
      info('Xero-Service', 'Service area processed successfully', itemsValues, req ?? null);
      return { status: 200, body: { message: 'Service area processed' } };
    }
    case 'direct_support': {
      if (!directSupportValues) return { status: 200, body: { error: 'Direct Support Item not found' } };
      const result = await handleUpdate(workspaceId, boardId, items.id, buildNdisUnitPriceMapping({
        safeGet,
        itemsValues,
        serviceAreaValues,
        pricingValues: directSupportValues,
        itemNumberKey: 'Direct Support Item Number',
        unitAttr: 'Unit (Direct Support)',
        unitPriceAttr: 'Agreed Unit Price for Direct Support ($)',
      }), 'direct_support', 'Direct Support', 'Participants-Service-Plan');
      await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
      return { status: 200, body: result };
    }
    case 'activity_based_transport': {
      if (!activityBasedTransportValues) return { status: 200, body: { error: 'Activity Based Transport Item not found' } };
      const result = await handleUpdate(workspaceId, boardId, items.id, buildNdisUnitPriceMapping({
        safeGet,
        itemsValues,
        serviceAreaValues,
        pricingValues: activityBasedTransportValues,
        itemNumberKey: 'Activity Based Transport Item Number',
        unitAttr: 'Unit (Activity Based Transport)',
        unitPriceAttr: 'Agreed Price for Activity Based Transport ($)',
      }), 'activity_based_transport', 'Activity Based Transport', 'Participants-Service-Plan');
      await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
      return { status: 200, body: result };
    }
    case 'provider_travel_non_labour_cost': {
      if (!providerTravelValues) return { status: 200, body: { error: 'Provider Travel Non Labour Cost Item not found' } };
      const result = await handleUpdate(workspaceId, boardId, items.id, buildNdisUnitPriceMapping({
        safeGet,
        itemsValues,
        serviceAreaValues,
        pricingValues: providerTravelValues,
        itemNumberKey: 'Provider Travel - Non-Labour Cost Item Number',
        unitAttr: 'Unit (Provider Travel - Non-Labour Cost)',
        unitPriceAttr: 'Agreed Unit Price for Non-Labour Travel ($)',
      }), 'provider_travel_non_labour_cost', 'Provider Travel Non Labour Cost');
      await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
      return { status: 200, body: result };
    }
    case 'centre_capital_cost': {
      if (!centreCapitalCostsValues) return { status: 200, body: { error: 'Centre Capital Cost Item not found' } };
      const result = await handleUpdate(workspaceId, boardId, items.id, buildNdisUnitPriceMapping({
        safeGet,
        itemsValues,
        serviceAreaValues,
        pricingValues: centreCapitalCostsValues,
        itemNumberKey: 'Centre Capital Costs Item',
        unitAttr: 'Unit (Centre Capital Costs)',
        unitPriceAttr: 'Agreed Unit Price for Centre Capital Costs($)',
      }), 'centre_capital_cost', 'Centre Capital Costs', 'Participants-Service-Plan');
      await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
      return { status: 200, body: result };
    }
    case 'update_service_plan_variables': {
      const result = await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
      return { status: 200, body: result };
    }
    default: {
      if (!normalizedType) {
        const result = await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
        return { status: 200, body: result };
      }
      warn('Xero-Service', 'Invalid type in set-unit', { type: normalizedType }, req ?? null);
      return { status: 200, body: { error: 'Invalid type', message: 'Invalid type in set-unit' } };
    }
  }
}
