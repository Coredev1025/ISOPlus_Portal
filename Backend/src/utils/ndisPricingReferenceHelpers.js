import { ITEM_DELETED } from '../services/isoplus.js';
import { NDIS_SERVICEPLAN_ATTR } from '../utils/ndisServiceRecords.js';

export const LEGACY_SERVICE_AREA_MAP = {
  'Non-Remote (ACT)': 'ACT($)',
  'Non-Remote (NSW)': 'NSW($)',
  'Non-Remote (NT)': 'NT($)',
  'Non-Remote (QLD)': 'QLD($)',
  'Non-Remote (SA)': 'SA($)',
  'Non-Remote (TAS)': 'TAS($)',
  'Non-Remote (VIC)': 'VIC($)',
  'Non-Remote (WA)': 'WA($)',
  Remote: 'Remote($)',
  'Very Remote': 'Very Remote($)',
  '': 'ACT($)',
};

const PRICING_STATE_COLUMNS = [
  'ACT($)', 'NSW($)', 'NT($)', 'QLD($)', 'SA($)', 'TAS($)', 'VIC($)', 'WA($)', 'Remote($)', 'Very Remote($)',
];

function readAttributeValue(values, name) {
  return values.find((value) => value?.attribute?.name === name)?.data?.toString?.() ?? '';
}

export function buildLegacyPricingCatalog(values, id, extraFields = {}) {
  const itemNumber = readAttributeValue(values, 'Support Item Number');
  if (!itemNumber) {
    throw new Error('Support Item Number is required');
  }
  const catalog = {
    id,
    itemName: readAttributeValue(values, 'Support Item Name'),
    itemNumber,
    unit: readAttributeValue(values, 'Unit'),
  };
  PRICING_STATE_COLUMNS.forEach((column) => {
    catalog[column] = readAttributeValue(values, column);
  });
  return { ...catalog, ...extraFields };
}

export async function resolveLegacyServiceAreaReference(workspaceId, boardId, reference, getItemValues) {
  const serviceValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (serviceValues === ITEM_DELETED || !serviceValues) return null;
  const values = Array.isArray(serviceValues.values) ? serviceValues.values : [];
  const serviceArea = readAttributeValue(values, 'Service Area');
  if (!serviceArea) {
    throw new Error('Service Area is required');
  }
  return {
    serviceArea,
    serviceAreaType: LEGACY_SERVICE_AREA_MAP[serviceArea] || 'ACT($)',
  };
}

export async function resolveLegacyPricingCatalogReference(workspaceId, boardId, reference, getItemValues, extraFields = {}) {
  const itemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (itemValues === ITEM_DELETED || !itemValues) return null;
  const values = Array.isArray(itemValues.values) ? itemValues.values : [];
  return buildLegacyPricingCatalog(values, itemValues.id, extraFields);
}

export async function resolveLegacyLabourTravelReference(workspaceId, boardId, reference, getItemValues) {
  const itemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (itemValues === ITEM_DELETED || !itemValues) return null;
  const values = Array.isArray(itemValues.values) ? itemValues.values : [];
  const itemName = readAttributeValue(values, 'Labour Travel Time Costs');
  if (!itemName) {
    throw new Error('Labour Travel Time Costs is required');
  }
  return { id: itemValues.id, itemName };
}

export async function fetchLegacyNdisReferencedItems({
  workspaceId,
  boardId,
  itemId,
  getReferences,
  getAttribute,
  getItemValues,
  handlerMap,
  emptyResult,
}) {
  const results = { ...emptyResult };
  const referenceResponse = await getReferences(workspaceId, boardId, itemId);
  if (!referenceResponse) {
    return Object.keys(emptyResult).map((key) => results[key]);
  }

  for (const reference of referenceResponse.data || []) {
    const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
    if (!attribute) continue;
    const config = handlerMap[attribute.name];
    if (!config) continue;
    const value = await config.handler(workspaceId, boardId, reference, getItemValues);
    if (value !== null && value !== undefined) {
      results[config.resultKey] = value;
    }
  }

  return Object.keys(emptyResult).map((key) => results[key]);
}

function legacyPricingHandler(resultKey) {
  return {
    resultKey,
    handler: (workspaceId, boardId, reference, getItemValues) =>
      resolveLegacyPricingCatalogReference(workspaceId, boardId, reference, getItemValues),
  };
}

export function createLegacyQuoteReferenceHandlers() {
  return {
    'Service Area': {
      resultKey: 'serviceAreaValues',
      handler: (workspaceId, boardId, reference, getItemValues) =>
        resolveLegacyServiceAreaReference(workspaceId, boardId, reference, getItemValues),
    },
    'Direct Support Item Number': legacyPricingHandler('directSupportValues'),
    'Provider Travel - Non-Labour Cost Item Number': legacyPricingHandler('providerTravelValues'),
    'Activity Based Transport Item Number': legacyPricingHandler('activityBasedTransportValues'),
    'Centre Capital Costs Item': legacyPricingHandler('centreCapitalCostsValues'),
    'Provider Travel - Labour Travel Time Costs': {
      resultKey: 'providerTravelLabourTravelTime',
      handler: (workspaceId, boardId, reference, getItemValues) =>
        resolveLegacyLabourTravelReference(workspaceId, boardId, reference, getItemValues),
    },
  };
}

export async function fetchLegacyNdisQuoteReferencedItems(deps) {
  return fetchLegacyNdisReferencedItems({
    ...deps,
    handlerMap: createLegacyQuoteReferenceHandlers(),
    emptyResult: {
      serviceAreaValues: null,
      directSupportValues: null,
      providerTravelValues: null,
      activityBasedTransportValues: null,
      centreCapitalCostsValues: null,
      providerTravelLabourTravelTime: null,
    },
  });
}

function buildParticipantsPlanCatalog(values, id) {
  const base = buildLegacyPricingCatalog(values, id);
  return {
    ...base,
    providerTravel: readAttributeValue(values, 'Provider Travel') || 'NA',
    ndiaRequestedReports: readAttributeValue(values, 'NDIA Requested Reports') || 'NA',
    nonFaceToFaceSupportProvision: readAttributeValue(values, 'Non-Face-to-Face Support Provision') || 'NA',
    shortNoticeCancellations: readAttributeValue(values, 'Short Notice Cancellations') || 'NA',
  };
}

async function resolveParticipantsPlanCatalogReference(
  workspaceId,
  boardId,
  reference,
  referenceName,
  getItemValues,
  warn,
  ctx,
) {
  const itemValues = await loadReferencedItemValuesWithWarn(
    workspaceId,
    boardId,
    reference.to_item_id,
    referenceName,
    getItemValues,
    warn,
    ctx,
  );
  if (!itemValues) return null;
  const values = Array.isArray(itemValues.values) ? itemValues.values : [];
  const itemNumber = readAttributeValue(values, 'Support Item Number');
  if (!itemNumber) throw new Error('Support Item Number is required');
  return buildParticipantsPlanCatalog(values, itemValues.id);
}

async function resolveParticipantIntakeReference(
  workspaceId,
  boardId,
  reference,
  referenceName,
  getItemValues,
  warn,
  ctx,
) {
  const participantProfile = await loadReferencedItemValuesWithWarn(
    workspaceId,
    boardId,
    reference.to_item_id,
    referenceName,
    getItemValues,
    warn,
    ctx,
  );
  if (!participantProfile) return null;
  const values = Array.isArray(participantProfile.values) ? participantProfile.values : [];
  return {
    fullName: readAttributeValue(values, 'Full Name/Preferred Name') || '',
    firstName: readAttributeValue(values, 'First Name') || '',
    lastName: readAttributeValue(values, 'Last Name') || '',
  };
}

export async function loadReferencedItemValuesWithWarn(
  workspaceId,
  boardId,
  referencedItemId,
  referenceName,
  getItemValues,
  warn,
  ctx,
) {
  const referenced = await getItemValues(workspaceId, boardId, referencedItemId);
  if (referenced === ITEM_DELETED) {
    warn('ISO+™ Service', 'Referenced item deleted in ISO+', { ...ctx, referenceName, referencedItemId });
    return null;
  }
  if (!referenced) {
    warn('ISO+™ Service', 'Referenced item not found or failed to load', { ...ctx, referenceName, referencedItemId });
    return null;
  }
  if (!Array.isArray(referenced.values)) {
    warn('ISO+™ Service', 'Referenced item values missing/invalid', {
      ...ctx,
      referenceName,
      referencedItemId,
      valuesType: typeof referenced.values,
    });
    return null;
  }
  return referenced;
}

function participantsPlanCatalogHandler(resultKey, referenceName, warn, ctx) {
  return {
    resultKey,
    handler: async (workspaceId, boardId, reference, getItemValues) =>
      resolveParticipantsPlanCatalogReference(
        workspaceId,
        boardId,
        reference,
        referenceName,
        getItemValues,
        warn,
        ctx,
      ),
  };
}

export function createLegacyParticipantsPlanReferenceHandlers(warn, ctx) {
  return {
    'Service Area': {
      resultKey: 'serviceAreaValues',
      handler: async (workspaceId, boardId, reference, getItemValues) =>
        resolveLegacyServiceAreaReference(workspaceId, boardId, reference, getItemValues),
    },
    'Direct Support Item Number': participantsPlanCatalogHandler(
      'directSupportValues',
      'Direct Support Item Number',
      warn,
      ctx,
    ),
    'Provider Travel - Non-Labour Cost Item Number': participantsPlanCatalogHandler(
      'providerTravelValues',
      'Provider Travel - Non-Labour Cost Item Number',
      warn,
      ctx,
    ),
    'Activity Based Transport Item Number': participantsPlanCatalogHandler(
      'activityBasedTransportValues',
      'Activity Based Transport Item Number',
      warn,
      ctx,
    ),
    'Centre Capital Costs Item': participantsPlanCatalogHandler(
      'centreCapitalCostsValues',
      'Centre Capital Costs Item',
      warn,
      ctx,
    ),
    'Participant Intake Form': {
      resultKey: 'participantProfileValues',
      handler: async (workspaceId, boardId, reference, getItemValues) =>
        resolveParticipantIntakeReference(
          workspaceId,
          boardId,
          reference,
          'Participant Intake Form',
          getItemValues,
          warn,
          ctx,
        ),
    },
  };
}

export async function fetchLegacyNdisParticipantsPlanReferencedItems({ workspaceId, boardId, itemId, getReferences, getAttribute, getItemValues, warn }) {
  const ctx = { workspaceId, boardId, itemId };
  const referenceResponse = await getReferences(workspaceId, boardId, itemId);
  const refs = Array.isArray(referenceResponse?.data) ? referenceResponse.data : [];
  if (!refs.length) {
    warn('ISO+™ Service', 'Missing references for Participants Service Plan item', { ...ctx });
    return [null, null, null, null, null, null];
  }

  const results = {
    serviceAreaValues: null,
    directSupportValues: null,
    providerTravelValues: null,
    activityBasedTransportValues: null,
    centreCapitalCostsValues: null,
    participantProfileValues: null,
  };
  const handlerMap = createLegacyParticipantsPlanReferenceHandlers(warn, ctx);

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
    results.directSupportValues,
    results.providerTravelValues,
    results.activityBasedTransportValues,
    results.centreCapitalCostsValues,
    results.participantProfileValues,
  ];
}

export async function resolveServiceAreaReference(workspaceId, boardId, reference, getItemValues, newServiceAreaMap) {
  const serviceValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (serviceValues === ITEM_DELETED || !serviceValues) return null;
  const values = Array.isArray(serviceValues.values) ? serviceValues.values : [];
  if (!values.some((v) => v.attribute.name === 'Service Area')) {
    throw new Error('Service Area is required');
  }
  const rawArea = values.find((v) => v.attribute.name === 'Service Area')?.data?.toString() ?? '';
  return {
    serviceArea: rawArea,
    serviceAreaType: newServiceAreaMap[rawArea] || 'National($)',
  };
}

export async function resolveCatalogReference(workspaceId, boardId, reference, getItemValues, buildCatalogFromValues) {
  const itemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
  if (itemValues === ITEM_DELETED || !itemValues) return null;
  const values = Array.isArray(itemValues.values) ? itemValues.values : [];
  const catalog = buildCatalogFromValues(values);
  if (!catalog.itemNumber) return null;
  return { id: itemValues.id, ...catalog };
}

export async function processNdisQuotePricingReference(
  attributeName,
  reference,
  workspaceId,
  boardId,
  { getItemValues, buildCatalogFromValues, newServiceAreaMap },
) {
  switch (attributeName) {
    case 'Service Area':
      return {
        kind: 'serviceArea',
        value: await resolveServiceAreaReference(workspaceId, boardId, reference, getItemValues, newServiceAreaMap),
      };
    case NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT:
      return {
        kind: 'support',
        value: await resolveCatalogReference(workspaceId, boardId, reference, getItemValues, buildCatalogFromValues),
      };
    case NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR:
      return {
        kind: 'providerTravel',
        value: await resolveCatalogReference(workspaceId, boardId, reference, getItemValues, buildCatalogFromValues),
      };
    default:
      return { kind: 'unknown', value: null };
  }
}
