import { ITEM_DELETED } from '../services/isoplus.js';

const MASTER_PLAN_UNIT_ATTRS = [
  ['directSupportUnit', 'Unit (Direct Support)'],
  ['directSupportUnitPrice', 'Agreed Unit Price for Direct Support ($)'],
  ['nonLabourTravelUnit', 'Unit (Provider Travel - Non-Labour Cost)'],
  ['nonLabourTravelUnitPrice', 'Agreed Unit Price for Non-Labour Travel ($)'],
  ['activityBasedTransportUnit', 'Unit (Activity Based Transport)'],
  ['activityBasedTransportUnitPrice', 'Agreed Price for Activity Based Transport ($)'],
  ['centreCapitalCostsUnit', 'Unit (Centre Capital Costs)'],
  ['centreCapitalCostsUnitPrice', 'Agreed Unit Price for Centre Capital Costs($)'],
  ['labourTravelTimeUnit', 'Unit (Labour Travel Time)'],
  ['labourTravelTimeUnitPrice', 'Agreed Unit Price for Labour Travel Time ($)'],
  ['usedAllowanceUnit', 'Unit (Allowances)'],
  ['usedAllowanceAmount', 'Agreed Price for Allowances($)'],
  ['nonFaceToFaceSupportUnit', 'Unit (Non-Face-to-Face Support)'],
  ['nonFaceToFaceSupportUnitPrice', 'Agreed Unit Price for Non-Face-to-Face Support($)'],
];

function readAttr(values, name) {
  return values.find((v) => v.attribute.name === name)?.data?.toString() || '';
}

function readAttrOrNull(values, name) {
  const found = values.find((v) => v.attribute.name === name);
  return found ? found.data.toString() : null;
}

function readMasterPlanUnitFields(values) {
  const units = {};
  for (const [key, attrName] of MASTER_PLAN_UNIT_ATTRS) {
    units[key] = readAttrOrNull(values, attrName);
  }
  return units;
}

function buildMasterPlanServicePlanValues(
  directSupportValues,
  providerTravelValues,
  activityBasedTransportValues,
  centreCapitalCostsValues,
  units,
) {
  return {
    directSupportItemNumber: directSupportValues?.itemNumber || '',
    directSupportItemName: directSupportValues?.itemName || '',
    directSupportUnit: units.directSupportUnit,
    directSupportUnitPrice: units.directSupportUnitPrice,
    providerTravelItemNumber: providerTravelValues?.itemNumber || '',
    providerTravelItemName: providerTravelValues?.itemName || '',
    nonLabourTravelUnit: units.nonLabourTravelUnit,
    nonLabourTravelUnitPrice: units.nonLabourTravelUnitPrice,
    activityBasedTransportItemNumber: activityBasedTransportValues?.itemNumber || '',
    activityBasedTransportItemName: activityBasedTransportValues?.itemName || '',
    activityBasedTransportUnit: units.activityBasedTransportUnit,
    activityBasedTransportUnitPrice: units.activityBasedTransportUnitPrice,
    centreCapitalCostsItemNumber: centreCapitalCostsValues?.itemNumber || '',
    centreCapitalCostsItemName: centreCapitalCostsValues?.itemName || '',
    centreCapitalCostsUnit: units.centreCapitalCostsUnit,
    centreCapitalCostsUnitPrice: units.centreCapitalCostsUnitPrice,
    labourTravelTimeUnit: units.labourTravelTimeUnit,
    labourTravelTimeUnitPrice: units.labourTravelTimeUnitPrice,
    usedAllowanceUnit: units.usedAllowanceUnit,
    usedAllowanceAmount: units.usedAllowanceAmount,
    nonFaceToFaceSupportUnit: units.nonFaceToFaceSupportUnit,
    nonFaceToFaceSupportUnitPrice: units.nonFaceToFaceSupportUnitPrice,
    directSupportShortNoticeCancellations: directSupportValues?.shortNoticeCancellations || '',
    providerTravelShortNoticeCancellations: providerTravelValues?.shortNoticeCancellations || '',
    activityBasedTransportShortNoticeCancellations: activityBasedTransportValues?.shortNoticeCancellations || '',
    centreCapitalCostsShortNoticeCancellations: centreCapitalCostsValues?.shortNoticeCancellations || '',
  };
}

async function resolveMasterPlanServicePlan(workspaceId, boardId, reference, getItemValues, getParticipantsPlanRefs) {
  const servicePlan = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (servicePlan === ITEM_DELETED || !servicePlan) return null;
  const [, directSupportValues, providerTravelValues, activityBasedTransportValues, centreCapitalCostsValues] =
    await getParticipantsPlanRefs(workspaceId, boardId, reference.to_item_id);
  const values = Array.isArray(servicePlan.values) ? servicePlan.values : [];
  const units = readMasterPlanUnitFields(values);
  return buildMasterPlanServicePlanValues(
    directSupportValues,
    providerTravelValues,
    activityBasedTransportValues,
    centreCapitalCostsValues,
    units,
  );
}

async function resolveMasterPlanCancellationType(workspaceId, boardId, reference, getItemValues) {
  const cancellationType = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (cancellationType === ITEM_DELETED || !cancellationType) return null;
  const values = Array.isArray(cancellationType.values) ? cancellationType.values : [];
  return {
    definition: readAttr(values, 'Definition'),
    billableToClient: readAttr(values, 'Billable to Client %'),
    payableToWorker: readAttr(values, 'Payable to Worker %'),
  };
}

async function resolveMasterPlanFund(workspaceId, boardId, reference, getItemValues) {
  const fund = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (fund === ITEM_DELETED || !fund) return null;
  const values = Array.isArray(fund.values) ? fund.values : [];
  const fundAmount = Number(values.find((v) => v.attribute.name === 'Fund Amount($)')?.data || 0);
  const previouslyUsed = Number(values.find((v) => v.attribute.name === 'Previously Used ($)')?.data || 0);
  const invoicedAndReceived = Number(
    values.find((v) => v.attribute.name === 'Invoiced and Received Amount($)')?.data || 0,
  );
  const availableFund = fundAmount - previouslyUsed - invoicedAndReceived;
  const budgetSpent = fundAmount !== 0 ? (availableFund * 100) / fundAmount : 0;
  const fundingBudgetStatus =
    budgetSpent > 0 ? '👍 Within Budget' : budgetSpent < 0 ? '👎 Over Budget' : '👌 On Budget';
  return { fundingBudgetStatus };
}

async function resolveMasterPlanParticipantProfile(workspaceId, boardId, reference, getItemValues) {
  const participantProfile = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (participantProfile === ITEM_DELETED || !participantProfile) return null;
  const values = Array.isArray(participantProfile.values) ? participantProfile.values : [];
  return {
    billingContact: readAttr(values, 'Billing Contact'),
    billingAddress: readAttr(values, 'Billing Address'),
    Phone: readAttr(values, 'Primary Phone Number'),
    email: readAttr(values, 'Email'),
    address: readAttr(values, 'Address'),
    firstName: readAttr(values, 'First Name'),
    lastName: readAttr(values, 'Last Name'),
    fullName: readAttr(values, 'Full Name/Preferred Name'),
  };
}

async function resolveMasterPlanParticipationType(workspaceId, boardId, reference, getItemValues) {
  const participationType = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (participationType === ITEM_DELETED || !participationType) return null;
  const values = Array.isArray(participationType.values) ? participationType.values : [];
  return {
    participationType: readAttr(values, 'Participation Type'),
    definition: readAttr(values, 'Definition'),
  };
}

function createMasterPlanHandlerMap(getParticipantsPlanRefs) {
  return {
    'Service Plan': {
      resultKey: 'servicePlanValues',
      handler: (workspaceId, boardId, reference, getItemValues) =>
        resolveMasterPlanServicePlan(workspaceId, boardId, reference, getItemValues, getParticipantsPlanRefs),
    },
    'Cancellation Type': {
      resultKey: 'cancellationTypeValues',
      handler: resolveMasterPlanCancellationType,
    },
    Fund: {
      resultKey: 'fundValues',
      handler: resolveMasterPlanFund,
    },
    'Participant Profile': {
      resultKey: 'participantProfileValues',
      handler: resolveMasterPlanParticipantProfile,
    },
    'Participation Type': {
      resultKey: 'participationTypeValues',
      handler: resolveMasterPlanParticipationType,
    },
  };
}

export async function fetchNdisMasterPlanReferencedItems({
  workspaceId,
  boardId,
  itemId,
  getReferences,
  getAttribute,
  getItemValues,
  getParticipantsPlanRefs,
}) {
  const results = {
    servicePlanValues: null,
    cancellationTypeValues: null,
    fundValues: null,
    participantProfileValues: null,
    participationTypeValues: null,
  };

  const referenceResponse = await getReferences(workspaceId, boardId, itemId);
  if (!referenceResponse) return [null, null];

  const handlerMap = createMasterPlanHandlerMap(getParticipantsPlanRefs);
  for (const reference of referenceResponse?.data ?? []) {
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
    results.servicePlanValues,
    results.cancellationTypeValues,
    results.fundValues,
    results.participantProfileValues,
    results.participationTypeValues,
  ];
}
