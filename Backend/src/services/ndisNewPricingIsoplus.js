import { warn } from '../utils/logger.js';
import {
    getItemValues,
    getReferences,
    getAttribute,
    ITEM_DELETED,
} from './isoplus.js';

const NEW_SERVICE_AREA_MAP = {
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

function buildNdisPricingCatalogFromValues(values) {
    const safe = (name) => values.find(v => v?.attribute?.name === name)?.data?.toString?.() || '';
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

    const refs = referenceResponse?.data ?? [];
    for (const reference of refs) {
        const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
        if (!attribute) continue;

        switch (attribute.name) {
            case 'Service Area': {
                const serviceValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (serviceValues === ITEM_DELETED || !serviceValues) continue;
                const values = Array.isArray(serviceValues.values) ? serviceValues.values : [];
                if (!values.some(v => v.attribute.name === 'Service Area')) {
                    throw new Error('Service Area is required');
                }
                const rawArea = values.find(v => v.attribute.name === 'Service Area')?.data?.toString() ?? '';
                serviceAreaValues = {
                    serviceArea: rawArea,
                    serviceAreaType: NEW_SERVICE_AREA_MAP[rawArea] || 'National($)',
                };
                break;
            }
            case 'Support Item Number': {
                const supportItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (supportItemValues === ITEM_DELETED || !supportItemValues) continue;
                const values = Array.isArray(supportItemValues.values) ? supportItemValues.values : [];
                const catalog = buildNdisPricingCatalogFromValues(values);
                if (!catalog.itemNumber) continue;
                supportValues = { id: supportItemValues.id, ...catalog };
                break;
            }
            case 'Provider Travel - Non-Labour Cost Item Number': {
                const ptItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (ptItemValues === ITEM_DELETED || !ptItemValues) continue;
                const values = Array.isArray(ptItemValues.values) ? ptItemValues.values : [];
                const catalog = buildNdisPricingCatalogFromValues(values);
                if (!catalog.itemNumber) continue;
                providerTravelValues = { id: ptItemValues.id, ...catalog };
                break;
            }
        }
    }
    return [serviceAreaValues, supportValues, providerTravelValues];
}

export async function getNDISParticipantsServicePlanNewPricingReferencedItems(workspaceId, boardId, itemId) {
    const ctx = { workspaceId, boardId, itemId };
    let serviceAreaValues = null;
    let supportValues = null;
    let providerTravelValues = null;
    let participantProfileValues = null;
    let labourTravelTimeValues = null;
    let cancellationValues = null;

    const referenceResponse = await getReferences(workspaceId, boardId, itemId);
    const refs = Array.isArray(referenceResponse?.data) ? referenceResponse.data : [];
    if (!refs.length) {
        warn('ISO+™ Service', 'Missing references for Participants Service Plan item', { ...ctx });
        return [null, null, null, null, null, null];
    }

    const loadReferencedItemValues = async (referencedItemId, referenceName) => {
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
    };

    for (const reference of refs) {
        const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
        if (!attribute) continue;

        switch (attribute.name) {
            case 'Service Area': {
                const serviceValues = await loadReferencedItemValues(reference.to_item_id, attribute.name);
                if (!serviceValues) break;
                const values = Array.isArray(serviceValues.values) ? serviceValues.values : [];
                const serviceArea = values.find(v => v?.attribute?.name === 'Service Area')?.data?.toString?.();
                if (!serviceArea) {
                    throw new Error('Service Area is required');
                }
                serviceAreaValues = {
                    serviceArea,
                    serviceAreaType: NEW_SERVICE_AREA_MAP[serviceArea] || 'National($)',
                };
                break;
            }
            case 'Support Item Number': {
                const supportItemValues = await loadReferencedItemValues(reference.to_item_id, attribute.name);
                if (!supportItemValues) break;
                const values = Array.isArray(supportItemValues.values) ? supportItemValues.values : [];
                const catalog = buildNdisPricingCatalogFromValues(values);
                if (!catalog.itemNumber) break;
                supportValues = { id: supportItemValues.id, ...catalog };
                break;
            }
            case 'Provider Travel - Non-Labour Cost Item Number': {
                const ptItemValues = await loadReferencedItemValues(reference.to_item_id, attribute.name);
                if (!ptItemValues) break;
                const values = Array.isArray(ptItemValues.values) ? ptItemValues.values : [];
                const catalog = buildNdisPricingCatalogFromValues(values);
                if (!catalog.itemNumber) break;
                providerTravelValues = { id: ptItemValues.id, ...catalog };
                break;
            }
            case 'Provider Travel - Labour Travel Time Costs Item Number': {
                const ltItemValues = await loadReferencedItemValues(reference.to_item_id, attribute.name);
                if (!ltItemValues) break;
                const values = Array.isArray(ltItemValues.values) ? ltItemValues.values : [];
                const catalog = buildNdisPricingCatalogFromValues(values);
                if (!catalog.itemNumber) break;
                labourTravelTimeValues = { id: ltItemValues.id, ...catalog };
                break;
            }
            case 'Cancellation Item Number': {
                const cancItemValues = await loadReferencedItemValues(reference.to_item_id, attribute.name);
                if (!cancItemValues) break;
                const values = Array.isArray(cancItemValues.values) ? cancItemValues.values : [];
                const catalog = buildNdisPricingCatalogFromValues(values);
                if (!catalog.itemNumber) break;
                cancellationValues = { id: cancItemValues.id, ...catalog };
                break;
            }
            case 'Participant Intake Form': {
                const participantProfile = await loadReferencedItemValues(reference.to_item_id, attribute.name);
                if (!participantProfile) break;
                const values = Array.isArray(participantProfile.values) ? participantProfile.values : [];
                const safe = (name) => values.find(v => v?.attribute?.name === name)?.data?.toString?.() || '';
                participantProfileValues = {
                    fullName: safe('Full Name/Preferred Name'),
                    firstName: safe('First Name'),
                    lastName: safe('Last Name'),
                };
                break;
            }
        }
    }

    return [serviceAreaValues, supportValues, providerTravelValues, participantProfileValues, labourTravelTimeValues, cancellationValues];
}

export async function getNDISMasterPlanNewPricingReferencedItems(workspaceId, boardId, itemId) {
    let servicePlanValues = null;
    let cancellationTypeValues = null;
    let fundValues = null;
    let participantProfileValues = null;
    let participationTypeValues = null;

    const referenceResponse = await getReferences(workspaceId, boardId, itemId);
    if (!referenceResponse) return [null, null, null, null, null];

    const refs = referenceResponse?.data ?? [];
    for (const reference of refs) {
        const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
        if (!attribute) continue;

        switch (attribute.name) {
            case 'Service Plan': {
                const servicePlan = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (servicePlan === ITEM_DELETED || !servicePlan) continue;
                const [, , providerTravelValues, , labourTravelTimeValues, cancellationValues] =
                    await getNDISParticipantsServicePlanNewPricingReferencedItems(workspaceId, boardId, reference.to_item_id);
                const values = Array.isArray(servicePlan.values) ? servicePlan.values : [];
                const findVal = (name) => {
                    const found = values.find(v => v.attribute.name === name);
                    return found?.data != null ? found.data.toString() : null;
                };

                servicePlanValues = {
                    supportItemNumber: findVal('Support Item Number') || '',
                    supportUnit: findVal('Unit (Support)'),
                    supportUnitPrice: findVal('Agreed Unit Price for Support ($)'),
                    providerTravelItemNumber: providerTravelValues?.itemNumber || '',
                    providerTravelItemName: providerTravelValues?.itemName || '',
                    nonLabourTravelUnit: findVal('Unit (Provider Travel - Non-Labour Cost)'),
                    nonLabourTravelUnitPrice: findVal('Agreed Unit Price for Non-Labour Travel ($)'),
                    labourTravelTimeUnit: findVal('Unit (Labour Travel Time)') || labourTravelTimeValues?.unit || null,
                    labourTravelTimeUnitPrice: findVal('Agreed Unit Price for Labour Travel Time ($)'),
                    usedAllowanceUnit: findVal('Unit (Allowances)'),
                    usedAllowanceAmount: findVal('Agreed Price for Allowances($)'),
                    cancellationUnit: findVal('Unit (Cancellation)'),
                    cancellationUnitPrice: findVal('Agreed Unit Price for Cancellation ($)'),
                    cancellationShortNoticeCancellations: cancellationValues?.shortNoticeCancellations || '',
                };
                break;
            }
            case 'Cancellation Type': {
                const cancellationType = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (cancellationType === ITEM_DELETED || !cancellationType) continue;
                const values = Array.isArray(cancellationType.values) ? cancellationType.values : [];
                cancellationTypeValues = {
                    definition: values.find(v => v.attribute.name === 'Definition')?.data?.toString() || '',
                    billableToClient: values.find(v => v.attribute.name === 'Billable to Client %')?.data?.toString() || '',
                    payableToWorker: values.find(v => v.attribute.name === 'Payable to Worker %')?.data?.toString() || '',
                };
                break;
            }
            case 'Fund': {
                const fund = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (fund === ITEM_DELETED || !fund) continue;
                const values = Array.isArray(fund.values) ? fund.values : [];
                const fundAmount = Number(values.find(v => v.attribute.name === 'Fund Amount($)')?.data || 0);
                const previouslyUsed = Number(values.find(v => v.attribute.name === 'Previously Used ($)')?.data || 0);
                const invoicedAndReceived = Number(values.find(v => v.attribute.name === 'Invoiced and Received Amount($)')?.data || 0);
                const availableFund = fundAmount - previouslyUsed - invoicedAndReceived;
                const budgetSpent = fundAmount !== 0 ? (availableFund * 100 / fundAmount) : 0;
                const fundingBudgetStatus = budgetSpent > 0 ? '👍 Within Budget' : budgetSpent < 0 ? '👎 Over Budget' : '👌 On Budget';
                fundValues = { fundingBudgetStatus };
                break;
            }
            case 'Participant Profile': {
                const participantProfile = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (participantProfile === ITEM_DELETED || !participantProfile) continue;
                const values = Array.isArray(participantProfile.values) ? participantProfile.values : [];
                participantProfileValues = {
                    billingContact: values.find(v => v.attribute.name === 'Billing Contact')?.data?.toString() || '',
                    billingAddress: values.find(v => v.attribute.name === 'Billing Address')?.data?.toString() || '',
                    Phone: values.find(v => v.attribute.name === 'Primary Phone Number')?.data?.toString() || '',
                    email: values.find(v => v.attribute.name === 'Email')?.data?.toString() || '',
                    address: values.find(v => v.attribute.name === 'Address')?.data?.toString() || '',
                    firstName: values.find(v => v.attribute.name === 'First Name')?.data?.toString() || '',
                    lastName: values.find(v => v.attribute.name === 'Last Name')?.data?.toString() || '',
                    fullName: values.find(v => v.attribute.name === 'Full Name/Preferred Name')?.data?.toString() || '',
                };
                break;
            }
            case 'Participation Type': {
                const participationType = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (participationType === ITEM_DELETED || !participationType) continue;
                const values = Array.isArray(participationType.values) ? participationType.values : [];
                participationTypeValues = {
                    participationType: values.find(v => v.attribute.name === 'Participation Type')?.data?.toString() || '',
                    definition: values.find(v => v.attribute.name === 'Definition')?.data?.toString() || '',
                };
                break;
            }
        }
    }

    return [servicePlanValues, cancellationTypeValues, fundValues, participantProfileValues, participationTypeValues];
}
