import { ITEM_DELETED } from '../services/isoplus.js';
import { NDIS_SERVICEPLAN_ATTR } from './ndisServiceRecords.js';
import {
  loadReferencedItemValuesWithWarn,
  resolveCatalogReference,
  resolveServiceAreaReference,
} from './ndisPricingReferenceHelpers.js';

export function buildNdisPricingCatalogFromValues(values) {
  const safe = (name) => values.find((v) => v?.attribute?.name === name)?.data?.toString?.() || '';
  const itemNumber = safe('Support Item Number') || safe('Item Number');
  return {
    itemName: safe('Support Item Name') || safe('Name') || '',
    itemNumber,
    unit: safe('Unit') || '',
    'National($)': safe('National($)') || '',
    'ACT($)': safe('ACT($)') || '',
    'NSW($)': safe('NSW($)') || '',
    'NT($)': safe('NT($)') || '',
    'QLD($)': safe('QLD($)') || '',
    'SA($)': safe('SA($)') || '',
    'TAS($)': safe('TAS($)') || '',
    'VIC($)': safe('VIC($)') || '',
    'WA($)': safe('WA($)') || '',
    'Remote($)': safe('Remote($)') || '',
    'Very Remote($)': safe('Very Remote($)') || '',
    providerTravel: safe('Provider Travel') || 'NA',
    ndiaRequestedReports: safe('NDIA Requested Reports') || 'NA',
    nonFaceToFaceSupportProvision: safe('Non-Face-to-Face Support Provision') || 'NA',
    shortNoticeCancellations: safe('Short Notice Cancellations') || 'NA',
  };
}

function newCatalogHandler(resultKey, buildCatalogFromValues) {
  return {
    resultKey,
    handler: (workspaceId, boardId, reference, getItemValues) =>
      resolveCatalogReference(workspaceId, boardId, reference, getItemValues, buildCatalogFromValues),
  };
}

export function createNewParticipantsPlanReferenceHandlers(warn, ctx, buildCatalogFromValues, newServiceAreaMap) {
  return {
    'Service Area': {
      resultKey: 'serviceAreaValues',
      handler: (workspaceId, boardId, reference, getItemValues) =>
        resolveServiceAreaReference(workspaceId, boardId, reference, getItemValues, newServiceAreaMap),
    },
    [NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT]: newCatalogHandler('supportValues', buildCatalogFromValues),
    [NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR]: newCatalogHandler('providerTravelValues', buildCatalogFromValues),
    [NDIS_SERVICEPLAN_ATTR.ITEM_LABOUR_TRAVEL_TIME]: newCatalogHandler('labourTravelTimeValues', buildCatalogFromValues),
    [NDIS_SERVICEPLAN_ATTR.ITEM_CANCELLATION]: newCatalogHandler('cancellationValues', buildCatalogFromValues),
    [NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT]: newCatalogHandler('activityBasedTransportValues', buildCatalogFromValues),
    'Participant Intake Form': {
      resultKey: 'participantProfileValues',
      handler: async (workspaceId, boardId, reference, getItemValues) => {
        const participantProfile = await loadReferencedItemValuesWithWarn(
          workspaceId,
          boardId,
          reference.to_item_id,
          'Participant Intake Form',
          getItemValues,
          warn,
          ctx,
        );
        if (!participantProfile) return null;
        const values = Array.isArray(participantProfile.values) ? participantProfile.values : [];
        const safe = (name) => values.find((v) => v?.attribute?.name === name)?.data?.toString?.() || '';
        return { fullName: safe('Full Name/Preferred Name'), firstName: safe('First Name'), lastName: safe('Last Name') };
      },
    },
  };
}

export async function fetchNewNdisParticipantsPlanReferencedItems({
  workspaceId,
  boardId,
  itemId,
  getReferences,
  getAttribute,
  getItemValues,
  warn,
  buildCatalogFromValues,
  newServiceAreaMap,
}) {
  const ctx = { workspaceId, boardId, itemId };
  const referenceResponse = await getReferences(workspaceId, boardId, itemId);
  const refs = Array.isArray(referenceResponse?.data) ? referenceResponse.data : [];
  if (!refs.length) {
    warn('ISO+™ Service', 'Missing references for Participants Service Plan item', { ...ctx });
    return [null, null, null, null, null, null, null];
  }

  const results = {
    serviceAreaValues: null,
    supportValues: null,
    providerTravelValues: null,
    participantProfileValues: null,
    labourTravelTimeValues: null,
    cancellationValues: null,
    activityBasedTransportValues: null,
  };
  const handlerMap = createNewParticipantsPlanReferenceHandlers(warn, ctx, buildCatalogFromValues, newServiceAreaMap);

  for (const reference of refs) {
    const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
    if (!attribute) continue;
    const config = handlerMap[attribute.name];
    if (!config) continue;
    const value = await config.handler(workspaceId, boardId, reference, getItemValues);
    if (value !== null && value !== undefined) {
      results[config.resultKey] = value;
    }
  }

  return [
    results.serviceAreaValues,
    results.supportValues,
    results.providerTravelValues,
    results.participantProfileValues,
    results.labourTravelTimeValues,
    results.cancellationValues,
    results.activityBasedTransportValues,
  ];
}

function readServicePlanAttr(values, name) {
  const found = values.find((v) => v.attribute.name === name);
  return found?.data != null ? found.data.toString() : null;
}

export function buildNewMasterPlanServicePlanValues(servicePlan, nestedRefs) {
  const [, , providerTravelValues, , labourTravelTimeValues, cancellationValues, activityBasedTransportValues] = nestedRefs;
  const values = Array.isArray(servicePlan.values) ? servicePlan.values : [];
  return {
    supportItemNumber: readServicePlanAttr(values, NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT) || '',
    supportUnit: readServicePlanAttr(values, NDIS_SERVICEPLAN_ATTR.UNIT_SUPPORT),
    supportUnitPrice: readServicePlanAttr(values, NDIS_SERVICEPLAN_ATTR.PRICE_SUPPORT),
    providerTravelItemNumber: providerTravelValues?.itemNumber || '',
    providerTravelItemName: providerTravelValues?.itemName || '',
    nonLabourTravelUnit: readServicePlanAttr(values, NDIS_SERVICEPLAN_ATTR.UNIT_PROVIDER_TRAVEL_NON_LABOUR),
    nonLabourTravelUnitPrice: readServicePlanAttr(values, NDIS_SERVICEPLAN_ATTR.PRICE_PROVIDER_TRAVEL_NON_LABOUR),
    activityBasedTransportItemNumber: activityBasedTransportValues?.itemNumber || '',
    activityBasedTransportItemName: activityBasedTransportValues?.itemName || '',
    activityBasedTransportUnit: readServicePlanAttr(values, NDIS_SERVICEPLAN_ATTR.UNIT_ACTIVITY_TRANSPORT),
    activityBasedTransportUnitPrice: readServicePlanAttr(values, NDIS_SERVICEPLAN_ATTR.PRICE_ACTIVITY_TRANSPORT),
    activityBasedTransportShortNoticeCancellations: activityBasedTransportValues?.shortNoticeCancellations || '',
    labourTravelTimeUnit: readServicePlanAttr(values, NDIS_SERVICEPLAN_ATTR.UNIT_LABOUR_TRAVEL_TIME) || labourTravelTimeValues?.unit || null,
    labourTravelTimeUnitPrice: readServicePlanAttr(values, NDIS_SERVICEPLAN_ATTR.PRICE_LABOUR_TRAVEL_TIME),
    usedAllowanceUnit: readServicePlanAttr(values, NDIS_SERVICEPLAN_ATTR.UNIT_ALLOWANCES),
    usedAllowanceAmount: readServicePlanAttr(values, NDIS_SERVICEPLAN_ATTR.PRICE_ALLOWANCES),
    cancellationUnit: readServicePlanAttr(values, NDIS_SERVICEPLAN_ATTR.UNIT_CANCELLATION),
    cancellationUnitPrice: readServicePlanAttr(values, NDIS_SERVICEPLAN_ATTR.PRICE_CANCELLATION),
    cancellationShortNoticeCancellations: cancellationValues?.shortNoticeCancellations || '',
  };
}

function buildCancellationTypeValues(cancellationType) {
  const values = Array.isArray(cancellationType.values) ? cancellationType.values : [];
  return {
    definition: values.find((v) => v.attribute.name === 'Definition')?.data?.toString() || '',
    billableToClient: values.find((v) => v.attribute.name === 'Billable to Client %')?.data?.toString() || '',
    payableToWorker: values.find((v) => v.attribute.name === 'Payable to Worker %')?.data?.toString() || '',
  };
}

function buildFundValues(fund) {
  const values = Array.isArray(fund.values) ? fund.values : [];
  const fundAmount = Number(values.find((v) => v.attribute.name === 'Fund Amount($)')?.data || 0);
  const previouslyUsed = Number(values.find((v) => v.attribute.name === 'Previously Used ($)')?.data || 0);
  const invoicedAndReceived = Number(values.find((v) => v.attribute.name === 'Invoiced and Received Amount($)')?.data || 0);
  const availableFund = fundAmount - previouslyUsed - invoicedAndReceived;
  const budgetSpent = fundAmount !== 0 ? (availableFund * 100) / fundAmount : 0;
  const fundingBudgetStatus = budgetSpent > 0 ? '👍 Within Budget' : budgetSpent < 0 ? '👎 Over Budget' : '👌 On Budget';
  return { fundingBudgetStatus };
}

function buildParticipantProfileValues(participantProfile) {
  const values = Array.isArray(participantProfile.values) ? participantProfile.values : [];
  const read = (name) => values.find((v) => v.attribute.name === name)?.data?.toString() || '';
  return {
    billingContact: read('Billing Contact'),
    billingAddress: read('Billing Address'),
    Phone: read('Primary Phone Number'),
    email: read('Email'),
    address: read('Address'),
    firstName: read('First Name'),
    lastName: read('Last Name'),
    fullName: read('Full Name/Preferred Name'),
  };
}

function buildParticipationTypeValues(participationType) {
  const values = Array.isArray(participationType.values) ? participationType.values : [];
  return {
    participationType: values.find((v) => v.attribute.name === 'Participation Type')?.data?.toString() || '',
    definition: values.find((v) => v.attribute.name === 'Definition')?.data?.toString() || '',
  };
}

export async function resolveMasterPlanNewReference(attributeName, reference, workspaceId, boardId, getItemValues, fetchParticipantsPlanRefs) {
  switch (attributeName) {
    case 'Service Plan': {
      const servicePlan = await getItemValues(workspaceId, boardId, reference.to_item_id);
      if (servicePlan === ITEM_DELETED || !servicePlan) return { kind: 'servicePlan', value: null };
      const nestedRefs = await fetchParticipantsPlanRefs(workspaceId, boardId, reference.to_item_id);
      return { kind: 'servicePlan', value: buildNewMasterPlanServicePlanValues(servicePlan, nestedRefs) };
    }
    case 'Cancellation Type': {
      const cancellationType = await getItemValues(workspaceId, boardId, reference.to_item_id);
      if (cancellationType === ITEM_DELETED || !cancellationType) return { kind: 'cancellationType', value: null };
      return { kind: 'cancellationType', value: buildCancellationTypeValues(cancellationType) };
    }
    case 'Fund': {
      const fund = await getItemValues(workspaceId, boardId, reference.to_item_id);
      if (fund === ITEM_DELETED || !fund) return { kind: 'fund', value: null };
      return { kind: 'fund', value: buildFundValues(fund) };
    }
    case 'Participant Profile': {
      const participantProfile = await getItemValues(workspaceId, boardId, reference.to_item_id);
      if (participantProfile === ITEM_DELETED || !participantProfile) return { kind: 'participantProfile', value: null };
      return { kind: 'participantProfile', value: buildParticipantProfileValues(participantProfile) };
    }
    case 'Participation Type': {
      const participationType = await getItemValues(workspaceId, boardId, reference.to_item_id);
      if (participationType === ITEM_DELETED || !participationType) return { kind: 'participationType', value: null };
      return { kind: 'participationType', value: buildParticipationTypeValues(participationType) };
    }
    default:
      return { kind: 'unknown', value: null };
  }
}

function applyMasterPlanReferenceResult(results, kind, value) {
  if (!value) return;
  if (kind === 'servicePlan') results.servicePlanValues = value;
  if (kind === 'cancellationType') results.cancellationTypeValues = value;
  if (kind === 'fund') results.fundValues = value;
  if (kind === 'participantProfile') results.participantProfileValues = value;
  if (kind === 'participationType') results.participationTypeValues = value;
}

export async function fetchNewNdisMasterPlanReferencedItems({
  workspaceId,
  boardId,
  itemId,
  getReferences,
  getAttribute,
  getItemValues,
  fetchParticipantsPlanRefs,
}) {
  const referenceResponse = await getReferences(workspaceId, boardId, itemId);
  if (!referenceResponse) return [null, null, null, null, null];

  const results = {
    servicePlanValues: null,
    cancellationTypeValues: null,
    fundValues: null,
    participantProfileValues: null,
    participationTypeValues: null,
  };

  for (const reference of referenceResponse?.data ?? []) {
    const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
    if (!attribute) continue;
    const { kind, value } = await resolveMasterPlanNewReference(
      attribute.name,
      reference,
      workspaceId,
      boardId,
      getItemValues,
      fetchParticipantsPlanRefs,
    );
    if (!value) continue;
    applyMasterPlanReferenceResult(results, kind, value);
  }

  return [
    results.servicePlanValues,
    results.cancellationTypeValues,
    results.fundValues,
    results.participantProfileValues,
    results.participationTypeValues,
  ];
}
