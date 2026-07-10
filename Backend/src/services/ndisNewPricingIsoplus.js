import { warn } from '../utils/logger.js';
import {
    getItemValues,
    getReferences,
    getAttribute,
    ITEM_DELETED,
} from './isoplus.js';
import { processNdisQuotePricingReference } from '../utils/ndisPricingReferenceHelpers.js';
import {
    buildNdisPricingCatalogFromValues,
    fetchNewNdisParticipantsPlanReferencedItems,
    fetchNewNdisMasterPlanReferencedItems,
} from '../utils/ndisNewPricingReferenceHelpers.js';

export const NEW_SERVICE_AREA_MAP = {
    'Non-Remote (ACT)': 'National($)',
    'Non-Remote (NSW)': 'National($)',
    'Non-Remote (NT)': 'National($)',
    'Non-Remote (QLD)': 'National($)',
    'Non-Remote (SA)': 'National($)',
    'Non-Remote (TAS)': 'National($)',
    'Non-Remote (VIC)': 'National($)',
    'Non-Remote (WA)': 'National($)',
    'Remote': 'Remote($)',
    'Very Remote': 'Very Remote($)',
    '': 'National($)',
};

export async function loadNdisPricingCatalogItem(workspaceId, boardId, catalogItemId) {
    if (!catalogItemId) return null;
    const referenced = await getItemValues(workspaceId, boardId, catalogItemId);
    if (referenced === ITEM_DELETED || !referenced || !Array.isArray(referenced.values)) return null;
    return {
        id: referenced.id,
        ...buildNdisPricingCatalogFromValues(referenced.values),
    };
}

export async function getQuoteNDISNewPricingReferencedItems(workspaceId, boardId, itemId) {
    let serviceAreaValues = null;
    let supportValues = null;
    let providerTravelValues = null;

    const referenceResponse = await getReferences(workspaceId, boardId, itemId);
    if (!referenceResponse) return [null, null, null];

    for (const reference of referenceResponse?.data ?? []) {
        const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
        if (!attribute) continue;

        const { kind, value } = await processNdisQuotePricingReference(
            attribute.name,
            reference,
            workspaceId,
            boardId,
            {
                getItemValues,
                buildCatalogFromValues: buildNdisPricingCatalogFromValues,
                newServiceAreaMap: NEW_SERVICE_AREA_MAP,
            },
        );
        if (!value) continue;
        if (kind === 'serviceArea') serviceAreaValues = value;
        if (kind === 'support') supportValues = value;
        if (kind === 'providerTravel') providerTravelValues = value;
    }
    return [serviceAreaValues, supportValues, providerTravelValues];
}

export async function getNDISParticipantsServicePlanNewPricingReferencedItems(workspaceId, boardId, itemId) {
    return fetchNewNdisParticipantsPlanReferencedItems({
        workspaceId,
        boardId,
        itemId,
        getReferences,
        getAttribute,
        getItemValues,
        warn,
        buildCatalogFromValues: buildNdisPricingCatalogFromValues,
        newServiceAreaMap: NEW_SERVICE_AREA_MAP,
    });
}

export async function getNDISMasterPlanNewPricingReferencedItems(workspaceId, boardId, itemId) {
    return fetchNewNdisMasterPlanReferencedItems({
        workspaceId,
        boardId,
        itemId,
        getReferences,
        getAttribute,
        getItemValues,
        fetchParticipantsPlanRefs: getNDISParticipantsServicePlanNewPricingReferencedItems,
    });
}
