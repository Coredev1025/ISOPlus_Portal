import express from 'express';
import dotenv from 'dotenv';
import { info, warn, error } from '../utils/logger.js';
import { Item } from '../dto/itemsPayload.js';
import { getQuoteNDISReferencedItems, getItemValues, getNDISParticipantsServicePlanReferencedItems, getNDISMasterPlanReferencedItems, setIntegrationMessage } from '../services/isoplus.js';
import {
    getQuoteNDISNewPricingReferencedItems,
    getNDISParticipantsServicePlanNewPricingReferencedItems,
    getNDISMasterPlanNewPricingReferencedItems,
    loadNdisPricingCatalogItem,
} from '../services/ndisNewPricingIsoplus.js';
import {
    hasSelectionValue,
    boardUsesNewNdisPricing,
    boardUsesLegacyNdisPricing,
    masterPlanBoardUsesNewNdisPricing,
    isShiftCancelled,
} from '../utils/ndisPricingRules.js';
import { NDIS_MASTERPLAN_ATTR, NDIS_SERVICEPLAN_ATTR, computeProviderTravelNonLabourAmount, computeActivityBaseTransportAmount, computeLabourTravelTimeAmount } from '../utils/ndisServiceRecords.js';
import axios from 'axios';

dotenv.config();
const router = express.Router();

function formatValue(val) {
    const num = Number(val);
    if (!isNaN(num)) {
      const factor = Math.pow(10, 2);
      const result = Math.round(num * factor) / factor;
  
      return result.toFixed(2);
    } else {
      return val;
    }
  }

function toApiNumber(val) {
    const num = Number(formatValue(val));
    return Number.isFinite(num) ? num : 0;
}

const ISOPLUS_API_HEADERS = {
    "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-API-Version": "2025-02-26.morava",
};

async function putMasterPlanItemValues(workspaceId, boardId, itemId, values) {
    if (!Array.isArray(values) || values.length === 0) return { status: 200, skipped: true };
    return axios.put(
        `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`,
        { values },
        { headers: ISOPLUS_API_HEADERS }
    );
}

function extractIsoPlusErrorDetail(err) {
    const data = err?.response?.data;
    if (!data) return err?.message || 'Unknown error';
    if (typeof data === 'string') return data;
    if (data.message) return data.message;
    if (data.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    return JSON.stringify(data);
}

function extractUnit(unitString) {
    switch (unitString) {
        case 'E':
            return 'Each(E)';
        case 'H':
            return 'Hour(H)';
        case 'D':
            return 'Daily(D)';
        case 'WK':
            return 'Week(WK)';
        case 'MON':
            return 'Month(MON)';
        case 'YR':
            return 'Annual(YR)';
        // 2026-27 NDIS Pricing Schedule units
        case 'Each':
        case 'Hour':
        case 'Day':
        case 'Week':
        case 'Month':
        case 'Year':
        case 'Annual':
            return unitString;
        default:
            return unitString || '';
    }
}

function isHourUnit(unit) {
    if (!unit) return false;
    const u = unit.trim();
    return u === 'Hour(H)' || u === 'Hour' || u === 'H';
}

function resolvePriceForArea(pricingItemValues, serviceAreaType) {
    if (!pricingItemValues) return undefined;
    const price = pricingItemValues[serviceAreaType];
    if (price !== undefined && price !== '' && price !== null) return price;
    return undefined;
}

function getSdmExpectedSuffix(sdm) {
    if (!sdm) return null;
    const lower = sdm.toLowerCase().replace(/[-\s]+/g, '');
    if (lower === 'facetoface') return '';
    if (lower.includes('telehealth')) return 'TH';
    if (lower.includes('nonfacetoface')) return 'NF';
    if (lower.includes('ndiarequested') || lower.includes('ndiarr')) return 'RR';
    return null;
}

function getItemNumberSuffix(itemNumber) {
    if (!itemNumber) return '';
    const upper = itemNumber.toUpperCase().trim();
    if (upper.endsWith('_TH')) return 'TH';
    if (upper.endsWith('_NF')) return 'NF';
    if (upper.endsWith('_RR')) return 'RR';
    if (upper.endsWith('_PT')) return 'PT';
    if (upper.endsWith('_CA')) return 'CA';
    return '';
}

function normalizeStringValue(value) {
    if (Array.isArray(value)) {
        return value[0]?.toString().trim() || '';
    }
    return value?.toString().trim() || '';
}

function safeGetRefId(itemsValues, key) {
    const raw = itemsValues?.[key];
    if (Array.isArray(raw) && raw.length > 0) return String(raw[0]);
    if (raw !== undefined && raw !== null && raw !== '') return String(raw);
    return '';
}

async function resolvePricingValues(existingValues, workspaceId, boardId, itemsValues, itemNumberKey) {
    const selectedId = safeGetRefId(itemsValues, itemNumberKey);
    if (selectedId) {
        const loaded = await loadNdisPricingCatalogItem(workspaceId, boardId, selectedId);
        if (loaded?.itemNumber) return loaded;
    }
    return existingValues || null;
}

function pricingPrerequisitesMet(itemsValues, serviceAreaValues) {
    const hasServiceArea = Boolean(serviceAreaValues?.serviceArea || serviceAreaValues?.serviceAreaType);
    const hasSdm = Boolean(normalizeStringValue(itemsValues?.['Service Delivery Mode']));
    return hasServiceArea && hasSdm;
}

async function applyUnitAndPriceUpdate(workspaceId, boardId, itemId, itemsValues, serviceAreaValues, pricingValues, mapping, webhookType) {
    if (!pricingValues) {
        return { error: `${mapping.label} item not found` };
    }
    if (!pricingPrerequisitesMet(itemsValues, serviceAreaValues)) {
        return { message: 'Waiting for Service Area and Service Delivery Mode before setting unit and price.' };
    }
    const sat = serviceAreaValues.serviceAreaType;
    const unitPrice = resolvePriceForArea(pricingValues, sat);
    if (unitPrice === undefined || unitPrice === null || unitPrice === '') {
        return { error: `No price found for ${mapping.label} in the selected service area.` };
    }
    return handleUpdate(workspaceId, boardId, itemId, {
        itemId: safeGetRefId(itemsValues, mapping.itemNumberKey),
        serviceArea: sat,
        unit: pricingValues.unit,
        unitAttr: mapping.unitAttr,
        unitPrice,
        unitPriceAttr: mapping.unitPriceAttr,
    }, mapping.type, mapping.label, webhookType);
}

const NDIS_SERVICE_PLAN_PRICING_MAPPINGS = {
    support: {
        type: 'support',
        label: 'Support',
        itemNumberKey: NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT,
        unitAttr: NDIS_SERVICEPLAN_ATTR.UNIT_SUPPORT,
        unitPriceAttr: NDIS_SERVICEPLAN_ATTR.PRICE_SUPPORT,
    },
    provider_travel_non_labour_cost: {
        type: 'provider_travel_non_labour_cost',
        label: 'Provider Travel Non Labour Cost',
        itemNumberKey: NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR,
        unitAttr: NDIS_SERVICEPLAN_ATTR.UNIT_PROVIDER_TRAVEL_NON_LABOUR,
        unitPriceAttr: NDIS_SERVICEPLAN_ATTR.PRICE_PROVIDER_TRAVEL_NON_LABOUR,
    },
    labour_travel_time_cost: {
        type: 'labour_travel_time_cost',
        label: 'Labour Travel Time Cost',
        itemNumberKey: NDIS_SERVICEPLAN_ATTR.ITEM_LABOUR_TRAVEL_TIME,
        unitAttr: NDIS_SERVICEPLAN_ATTR.UNIT_LABOUR_TRAVEL_TIME,
        unitPriceAttr: NDIS_SERVICEPLAN_ATTR.PRICE_LABOUR_TRAVEL_TIME,
    },
    cancellation_cost: {
        type: 'cancellation_cost',
        label: 'Cancellation Cost',
        itemNumberKey: NDIS_SERVICEPLAN_ATTR.ITEM_CANCELLATION,
        unitAttr: NDIS_SERVICEPLAN_ATTR.UNIT_CANCELLATION,
        unitPriceAttr: NDIS_SERVICEPLAN_ATTR.PRICE_CANCELLATION,
    },
    activity_based_transport: {
        type: 'activity_based_transport',
        label: 'Activity Based Transport',
        itemNumberKey: NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT,
        unitAttr: NDIS_SERVICEPLAN_ATTR.UNIT_ACTIVITY_TRANSPORT,
        unitPriceAttr: NDIS_SERVICEPLAN_ATTR.PRICE_ACTIVITY_TRANSPORT,
    },
};

async function resolveAllServicePlanPricing(workspaceId, boardId, itemId, itemsValues) {
    let [
        serviceAreaValues,
        supportValues,
        providerTravelValues,
        ,
        labourTravelTimeValues,
        cancellationValues,
        activityBasedTransportValues,
    ] = await getNDISParticipantsServicePlanNewPricingReferencedItems(workspaceId, boardId, itemId);

    if (serviceAreaValues == null || serviceAreaValues.serviceAreaType == null) {
        serviceAreaValues = { serviceAreaType: 'National($)' };
    }

    return {
        serviceAreaValues,
        supportValues: await resolvePricingValues(supportValues, workspaceId, boardId, itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT),
        providerTravelValues: await resolvePricingValues(providerTravelValues, workspaceId, boardId, itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR),
        labourTravelTimeValues: await resolvePricingValues(labourTravelTimeValues, workspaceId, boardId, itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_LABOUR_TRAVEL_TIME),
        cancellationValues: await resolvePricingValues(cancellationValues, workspaceId, boardId, itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_CANCELLATION),
        activityBasedTransportValues: await resolvePricingValues(activityBasedTransportValues, workspaceId, boardId, itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT),
    };
}

async function applyAllSelectedServicePlanPricing(workspaceId, boardId, itemId, itemsValues, webhookType = 'Participants-Service-Plan') {
    const pricing = await resolveAllServicePlanPricing(workspaceId, boardId, itemId, itemsValues);
    const selectedUpdates = [
        { mappingKey: 'support', values: pricing.supportValues, keys: [NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT] },
        { mappingKey: 'provider_travel_non_labour_cost', values: pricing.providerTravelValues, keys: [NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR] },
        { mappingKey: 'labour_travel_time_cost', values: pricing.labourTravelTimeValues, keys: [NDIS_SERVICEPLAN_ATTR.ITEM_LABOUR_TRAVEL_TIME] },
        { mappingKey: 'cancellation_cost', values: pricing.cancellationValues, keys: [NDIS_SERVICEPLAN_ATTR.ITEM_CANCELLATION] },
        { mappingKey: 'activity_based_transport', values: pricing.activityBasedTransportValues, keys: [NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT] },
    ];

    for (const entry of selectedUpdates) {
        const selectedKey = entry.keys.find((k) => safeGetRefId(itemsValues, k));
        if (!selectedKey || !entry.values) continue;
        const mapping = { ...NDIS_SERVICE_PLAN_PRICING_MAPPINGS[entry.mappingKey], itemNumberKey: selectedKey };
        await applyUnitAndPriceUpdate(
            workspaceId, boardId, itemId, itemsValues, pricing.serviceAreaValues, entry.values, mapping, webhookType
        );
    }

    return updateVariablesParticipantsServicePlanNew(workspaceId, boardId, itemId, itemsValues);
}

async function runServicePlanPricingUpdate(workspaceId, boardId, itemId, itemsValues, mappingKey, webhookType = 'Participants-Service-Plan') {
    const mapping = NDIS_SERVICE_PLAN_PRICING_MAPPINGS[mappingKey];
    const pricing = await resolveAllServicePlanPricing(workspaceId, boardId, itemId, itemsValues);
    const pricingValuesMap = {
        support: pricing.supportValues,
        provider_travel_non_labour_cost: pricing.providerTravelValues,
        labour_travel_time_cost: pricing.labourTravelTimeValues,
        cancellation_cost: pricing.cancellationValues,
        activity_based_transport: pricing.activityBasedTransportValues,
    };
    const pricingValues = pricingValuesMap[mappingKey];
    const itemNumberKey = mapping.itemNumberKey;
    if (!safeGetRefId(itemsValues, itemNumberKey)) {
        await updateVariablesParticipantsServicePlanNew(workspaceId, boardId, itemId, itemsValues);
        return { error: `${mapping.label} item not selected — Configuration Status updated.` };
    }
    const result = await applyUnitAndPriceUpdate(
        workspaceId,
        boardId,
        itemId,
        itemsValues,
        pricing.serviceAreaValues,
        pricingValues,
        { ...mapping, itemNumberKey },
        webhookType
    );
    const configResult = await updateVariablesParticipantsServicePlanNew(workspaceId, boardId, itemId, itemsValues);
    return { ...result, configuration: configResult };
}

const updateUnitAndUnitPrice = async (workspaceId, boardId, itemId, mappingValues, label) => {
    try {
        const itemData = await getItemValues(workspaceId, boardId, itemId);
        if (!itemData) {
            return { error: `${label} item not found` };
        }
        const unit = extractUnit(mappingValues.unit);
        const unitAttr = itemData.values.find(v => v.attribute.name === mappingValues.unitAttr)
            || itemData.values.find(v => v.attribute.name.includes(mappingValues.unitAttr));
        const priceAttr = itemData.values.find(v => v.attribute.name === mappingValues.unitPriceAttr)
            || itemData.values.find(v => v.attribute.name.includes(mappingValues.unitPriceAttr));
        if (!unitAttr || !priceAttr) {
            return { error: 'Unit or Unit Price attribute not found' };
        }
        const response = await axios.put(
            `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`,
            {
                values: [
                    { data: unit, attribute_id: unitAttr.attribute.id },
                    { data: mappingValues.unitPrice, attribute_id: priceAttr.attribute.id }
                ]
            },
            {
                headers: {
                    "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "X-API-Version": "2025-02-26.morava",
                }
            }
        );
        if (response.status === 200) {
            return { message: `${label} item updated successfully` };
        } else {
            return { error: `Failed to update ${label} item` };
        }
    } catch (err) {
        error('Xero-Service', `Failed to update ${label} item in ISO+`, { err, workspaceId, boardId, itemId, label }, { workspaceId, boardId, itemId });
        return { error: err.message };
    }
};

async function handleUpdate(workspaceId, boardId, itemId, mappingValues, type, label, webhookType = 'set-unit-and-unitprice') {
    const { error: validationError } = Item.validate('NDISPricing', mappingValues);
    if (validationError) {
        error('Xero-Service', `Validation error in ${webhookType} for ${type}`, { details: validationError.details, mappingValues }, { workspaceId, boardId, itemId, mappingValues, type });
        return { message: validationError.details, error: 'Validation error' };
    }
    info('Xero-Service', `${label} item updating is processing...`, { mappingValues }, { workspaceId, boardId, itemId, mappingValues, type });
    const result = await updateUnitAndUnitPrice(workspaceId, boardId, itemId, mappingValues, label);
    if (result.error) {
        warn('Xero-Service', `${label} update failed`, { result }, { workspaceId, boardId, itemId, mappingValues, type });
        return { message: `${label} update failed`, error: result.error };
    } else {
        info('Xero-Service', `${label} item updated successfully`, { result }, { workspaceId, boardId, itemId, mappingValues, type });
        return { message: `${label} item updated successfully` };
    }
}

function parseNumericValue(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
}

function hasNonZeroValue(value) {
    return Math.abs(parseNumericValue(value)) > 0;
}

function resolveConfigurationStatusLabelId(statusAttribute, desiredStatusText, fallbackColor) {
    const labels = statusAttribute?.attribute?.settings?.labels || [];
    if (!labels.length) return '';

    const normalizedDesiredText = desiredStatusText.toLowerCase();
    const exactMatch = labels.find(label => (label.name || '').toLowerCase() === normalizedDesiredText);
    if (exactMatch?.id) return exactMatch.id;

    const includesMatch = labels.find(label => (label.name || '').toLowerCase().includes(normalizedDesiredText));
    if (includesMatch?.id) return includesMatch.id;

    const colorMatch = labels.find(label => label.color === fallbackColor);
    return colorMatch?.id || '';
}

async function updateVariablesParticipantsServicePlan(workspaceId, boardId, itemId, itemsValues) {
    try {
        const responseItemValues = await getItemValues(workspaceId, boardId, itemId);
        const itemValuesWithAttributeId = responseItemValues?.values || [];
        const getAttributeIdByName = (attributeName) => {
            const attributeValue = itemValuesWithAttributeId.find(v => v.attribute?.name === attributeName);
            return attributeValue?.attribute?.id;
        };

        const [
            ,
            directSupportValues,
            providerTravelValues,
            activityBasedTransportValues,
            centreCapitalCostsValues,
            participantProfileValues
        ] = await getNDISParticipantsServicePlanReferencedItems(workspaceId, boardId, itemId);

        const prioritizedItems = [
            { key: 'Direct Support Item Number', itemValues: directSupportValues },
            { key: 'Activity Based Transport Item Number', itemValues: activityBasedTransportValues },
            { key: 'Centre Capital Costs Item', itemValues: centreCapitalCostsValues },
            { key: 'Provider Travel - Non-Labour Cost Item Number', itemValues: providerTravelValues },
        ];

        const selectedItem = prioritizedItems.find(item => hasSelectionValue(itemsValues, item.key));
        const selectedPricingItem = selectedItem?.itemValues || null;
        const selectedItemNumber = selectedPricingItem?.itemNumber || '';
        const prioritizedItemNumber = prioritizedItems
            .map(item => normalizeStringValue(item?.itemValues?.itemNumber))
            .find(itemNumber => itemNumber !== '') || '';

        const labourTravelTimePrice = itemsValues?.['Agreed Unit Price for Labour Travel Time ($)'];
        const allowancesType = normalizeStringValue(itemsValues?.['Allowances']);
        const allowancesPrice = itemsValues?.['Agreed Price for Allowances($)'];
        const nonFaceToFaceSupportPrice = itemsValues?.['Agreed Unit Price for Non-Face-to-Face Support($)'];

        const providerTravelClaimable = normalizeStringValue(selectedPricingItem?.providerTravel).toUpperCase() === 'Y';
        const ndiaReportsClaimable = normalizeStringValue(selectedPricingItem?.ndiaRequestedReports).toUpperCase() === 'Y';
        const nonFaceToFaceClaimable = normalizeStringValue(selectedPricingItem?.nonFaceToFaceSupportProvision).toUpperCase() === 'Y';

        let integrationMessage = 'Aligned and Correct Selection';
        let fallbackColor = '#388903';

        if (!selectedItem) {
            integrationMessage = 'Error: No Item Number Selected';
            fallbackColor = '#C60909';
        } else if (!providerTravelClaimable && hasNonZeroValue(labourTravelTimePrice)) {
            integrationMessage = 'Error: Labour Travel Time is not claimable from the NDIA.';
            fallbackColor = '#EE691E';
        } else if (!ndiaReportsClaimable && allowancesType === 'NDIA Requested Reports' && hasNonZeroValue(allowancesPrice)) {
            integrationMessage = 'Error: NDIA Requested Reports cost is not claimable from the NDIA.';
            fallbackColor = '#D99C05';
        } else if (!nonFaceToFaceClaimable && hasNonZeroValue(nonFaceToFaceSupportPrice)) {
            integrationMessage = 'Error: Non-face-to-face support provision is not claimable from the NDIA.';
            fallbackColor = '#CA56A8';
        }

        const updateValues = [];
        let participantNameValue = normalizeStringValue(participantProfileValues?.fullName);
        if (!participantNameValue) {
            const firstName = normalizeStringValue(participantProfileValues?.firstName);
            const lastName = normalizeStringValue(participantProfileValues?.lastName);
            participantNameValue = `${firstName ? firstName + (firstName && lastName ? ' ' : '') : ''}${lastName ? lastName : ''}`.trim();
        }
        const servicePlanIdAttributeId = getAttributeIdByName('Service Plan ID');
        if (servicePlanIdAttributeId) {
            let servicePlanIdValue = `${participantNameValue ? participantNameValue + (participantNameValue && prioritizedItemNumber ? ' - ' : '') : ''}${prioritizedItemNumber}`.trim();
            if (servicePlanIdValue && servicePlanIdValue.trim() !== '' && prioritizedItemNumber && prioritizedItemNumber.trim() !== '') {
                updateValues.push({
                    data: servicePlanIdValue.trim(),
                    attribute_id: servicePlanIdAttributeId
                });
            }
        }

        const participantNameAttributeId = getAttributeIdByName('Participant Full Name');
        if (participantNameAttributeId) {
            if (participantNameValue && participantNameValue.trim() !== '') {
                updateValues.push({ 
                    data: participantNameValue.trim(),
                    attribute_id: participantNameAttributeId
                });
            }
        }


        const statusAttribute = itemValuesWithAttributeId.find(v => v.attribute?.name === 'Configuration Status');
        if (statusAttribute) {
            const desiredStatusText = integrationMessage === 'Aligned and Correct Selection'
                ? 'Aligned and Correct Selection'
                : integrationMessage;
            const statusLabelId = resolveConfigurationStatusLabelId(statusAttribute, desiredStatusText, fallbackColor);
            if (statusLabelId) {
                updateValues.push({
                    data: [statusLabelId],
                    attribute_id: statusAttribute.attribute.id
                });
            }
        } else {
            await setIntegrationMessage(workspaceId, boardId, itemId, 'Configuration Status is required.');
            return { error: 'Configuration Status is required.' };
        }

        if (updateValues.length > 0) {
            await axios.put(
                `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`,
                { values: updateValues },
                {
                    headers: {
                        "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "X-API-Version": "2025-02-26.morava",
                    }
                }
            );
        }

        await setIntegrationMessage(workspaceId, boardId, itemId, integrationMessage);
        return { success: true, message: integrationMessage };
    } catch (err) {
        error('Xero-Service', 'Error in updateVariablesParticipantsServicePlan', { err, workspaceId, boardId, itemId }, { workspaceId, boardId, itemId });
        await setIntegrationMessage(workspaceId, boardId, itemId, "An unknown error occurred while updating Participants Service Plan variables. Please contact the ISO+ support team.");
        return { error: 'An unknown error occurred while updating Participants Service Plan variables. Please contact the ISO+ support team.' };
    }
}

async function updateVariablesParticipantsServicePlanNew(workspaceId, boardId, itemId, itemsValues) {
    try {
        const responseItemValues = await getItemValues(workspaceId, boardId, itemId);
        const itemValuesWithAttributeId = responseItemValues?.values || [];
        const getAttributeIdByName = (attributeName) => {
            const attributeValue = itemValuesWithAttributeId.find(v => v.attribute?.name === attributeName);
            return attributeValue?.attribute?.id;
        };

        const [
            serviceAreaValues,
            supportValues,
            providerTravelValues,
            participantProfileValues,
            labourTravelTimeValues,
            cancellationValues,
            activityBasedTransportValues,
        ] = await getNDISParticipantsServicePlanNewPricingReferencedItems(workspaceId, boardId, itemId);

        const resolvedProviderTravelValues = await resolvePricingValues(
            providerTravelValues, workspaceId, boardId, itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR
        );
        const resolvedLabourTravelValues = await resolvePricingValues(
            labourTravelTimeValues, workspaceId, boardId, itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_LABOUR_TRAVEL_TIME
        );
        const resolvedCancellationValues = await resolvePricingValues(
            cancellationValues, workspaceId, boardId, itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_CANCELLATION
        );
        const resolvedSupportValues = await resolvePricingValues(
            supportValues, workspaceId, boardId, itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT
        );
        const resolvedActivityBasedTransportValues = await resolvePricingValues(
            activityBasedTransportValues, workspaceId, boardId, itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT
        );

        const itemNumberFields = [
            { key: NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT, itemValues: resolvedSupportValues },
            { key: NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR, itemValues: resolvedProviderTravelValues },
            { key: NDIS_SERVICEPLAN_ATTR.ITEM_LABOUR_TRAVEL_TIME, itemValues: resolvedLabourTravelValues },
            { key: NDIS_SERVICEPLAN_ATTR.ITEM_CANCELLATION, itemValues: resolvedCancellationValues },
            { key: NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT, itemValues: resolvedActivityBasedTransportValues },
        ];

        const hasAnyItemNumber = itemNumberFields.some(item => hasSelectionValue(itemsValues, item.key));
        const prioritizedItemNumber = itemNumberFields
            .map(item => normalizeStringValue(item?.itemValues?.itemNumber))
            .find(itemNumber => itemNumber !== '') || '';

        const sdm = normalizeStringValue(itemsValues?.['Service Delivery Mode']);
        const supportItemNumber = hasSelectionValue(itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT)
            ? (resolvedSupportValues?.itemNumber || '')
            : '';
        const supportSuffix = getItemNumberSuffix(supportItemNumber);
        const expectedSuffix = getSdmExpectedSuffix(sdm);

        let integrationMessage = 'Aligned and Correct Selection';
        let fallbackColor = '#388903';

        const hasParticipantIntakeForm = hasSelectionValue(itemsValues, 'Participant Intake Form');

        if (!serviceAreaValues?.serviceArea && !serviceAreaValues?.serviceAreaType) {
            integrationMessage = 'Error: No Service Area selected';
            fallbackColor = '#FFB186';
        } else if (!sdm) {
            integrationMessage = 'Error: No Service Delivery Mode selected';
            fallbackColor = '#FFD3F2';
        } else if (!hasParticipantIntakeForm) {
            integrationMessage = 'Error: No Participant Intake Form Selected';
            fallbackColor = '#F36363';
        } else if (!hasAnyItemNumber) {
            integrationMessage = 'Error: No Item Number Selected';
            fallbackColor = '#C60909';
        } else if (
            hasSelectionValue(itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT) &&
            expectedSuffix !== null &&
            supportSuffix !== expectedSuffix
        ) {
            integrationMessage = 'Error: The selected Item Number does not match the selected Service Delivery Mode.';
            fallbackColor = '#EE691E';
        } else if (hasSelectionValue(itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR) && resolvedProviderTravelValues?.itemName && !resolvedProviderTravelValues.itemName.toLowerCase().includes('non-labour cost')) {
            integrationMessage = 'Error: The selected Item Number for Provider Travel - Non-Labour Cost is invalid.';
            fallbackColor = '#D99C05';
        } else if (hasSelectionValue(itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_LABOUR_TRAVEL_TIME) && resolvedLabourTravelValues?.itemNumber && getItemNumberSuffix(resolvedLabourTravelValues.itemNumber) !== 'PT') {
            integrationMessage = 'Error: The selected Item Number for Provider Travel - Labour Travel Time Costs is invalid.';
            fallbackColor = '#CA56A8';
        } else if (hasSelectionValue(itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_CANCELLATION) && resolvedCancellationValues?.itemName && !resolvedCancellationValues.itemName.toLowerCase().includes('cancellation')) {
            integrationMessage = 'Error: The selected Item Number for Cancellation Costs is invalid.';
            fallbackColor = '#FFA2A2';
        } else if (hasSelectionValue(itemsValues, NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT) && resolvedActivityBasedTransportValues?.itemName && !resolvedActivityBasedTransportValues.itemName.toLowerCase().includes('activity based transport')) {
            integrationMessage = 'Error: The selected Item Number for Activity Based Transport Cost is invalid.';
            fallbackColor = '#FFE197';
        }

        const updateValues = [];
        let participantNameValue = normalizeStringValue(participantProfileValues?.fullName);
        if (!participantNameValue) {
            const firstName = normalizeStringValue(participantProfileValues?.firstName);
            const lastName = normalizeStringValue(participantProfileValues?.lastName);
            participantNameValue = `${firstName ? firstName + (firstName && lastName ? ' ' : '') : ''}${lastName ? lastName : ''}`.trim();
        }
        const servicePlanIdAttributeId = getAttributeIdByName('Service Plan ID');
        if (servicePlanIdAttributeId) {
            const servicePlanIdValue = `${participantNameValue ? participantNameValue + (participantNameValue && prioritizedItemNumber ? ' - ' : '') : ''}${prioritizedItemNumber}`.trim();
            if (servicePlanIdValue && prioritizedItemNumber) {
                updateValues.push({ data: servicePlanIdValue.trim(), attribute_id: servicePlanIdAttributeId });
            }
        }

        const participantNameAttributeId = getAttributeIdByName('Participant Full Name');
        if (participantNameAttributeId && participantNameValue) {
            updateValues.push({ data: participantNameValue.trim(), attribute_id: participantNameAttributeId });
        }

        const statusAttribute = itemValuesWithAttributeId.find(v => v.attribute?.name === 'Configuration Status');
        if (statusAttribute) {
            const desiredStatusText = integrationMessage === 'Aligned and Correct Selection'
                ? 'Aligned and Correct Selection'
                : integrationMessage;
            const statusLabelId = resolveConfigurationStatusLabelId(statusAttribute, desiredStatusText, fallbackColor);
            if (statusLabelId) {
                updateValues.push({ data: [statusLabelId], attribute_id: statusAttribute.attribute.id });
            }
        } else {
            await setIntegrationMessage(workspaceId, boardId, itemId, 'Configuration Status is required.');
            return { error: 'Configuration Status is required.' };
        }

        if (updateValues.length > 0) {
            await axios.put(
                `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`,
                { values: updateValues },
                {
                    headers: {
                        "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "X-API-Version": "2025-02-26.morava",
                    }
                }
            );
        }

        await setIntegrationMessage(workspaceId, boardId, itemId, integrationMessage);
        return { success: true, message: integrationMessage };
    } catch (err) {
        error('Xero-Service', 'Error in updateVariablesParticipantsServicePlanNew', { err, workspaceId, boardId, itemId }, { workspaceId, boardId, itemId });
        await setIntegrationMessage(workspaceId, boardId, itemId, "An unknown error occurred while updating Participants Service Plan variables. Please contact the ISO+ support team.");
        return { error: 'An unknown error occurred while updating Participants Service Plan variables. Please contact the ISO+ support team.' };
    }
}

async function handleSetUnitAndUnitPriceNew(req, res) {
    const { workspaceId, boardId } = req.params;
    const { type } = req.query;
    const payload = req.body;
    const items = payload.items[0];
    const itemsValues = items.values;

    let [serviceAreaValues, supportValues, providerTravelValues] = await getQuoteNDISNewPricingReferencedItems(workspaceId, boardId, items.id);
    if (serviceAreaValues == null || serviceAreaValues.serviceAreaType == null) {
        serviceAreaValues = { serviceAreaType: 'National($)' };
    }
    const sat = serviceAreaValues.serviceAreaType;

    switch (type) {
        case 'service_area': {
            if (!serviceAreaValues) return res.status(200).json({ error: 'Service Area Item not found' });
            if (supportValues && safeGetRefId(itemsValues, 'Support Item Number')) {
                await handleUpdate(workspaceId, boardId, items.id, {
                    itemId: safeGetRefId(itemsValues, 'Support Item Number'),
                    serviceArea: sat,
                    unit: supportValues.unit,
                    unitAttr: 'Unit (Support)',
                    unitPrice: resolvePriceForArea(supportValues, sat),
                    unitPriceAttr: 'Agreed Unit Price for Support ($)',
                }, 'support', 'Support');
            }
            if (providerTravelValues && safeGetRefId(itemsValues, 'Provider Travel - Non-Labour Cost Item Number')) {
                await handleUpdate(workspaceId, boardId, items.id, {
                    itemId: safeGetRefId(itemsValues, 'Provider Travel - Non-Labour Cost Item Number'),
                    serviceArea: sat,
                    unit: providerTravelValues.unit,
                    unitAttr: 'Unit (Provider Travel - Non-Labour Cost)',
                    unitPrice: resolvePriceForArea(providerTravelValues, sat),
                    unitPriceAttr: 'Agreed Unit Price for Non-Labour Travel ($)',
                }, 'provider_travel_non_labour_cost', 'Provider Travel Non Labour Cost');
            }
            return res.status(200).json({ message: 'Service area processed' });
        }
        case 'support': {
            if (!supportValues) return res.status(200).json({ error: 'Support Item not found' });
            const result = await handleUpdate(workspaceId, boardId, items.id, {
                itemId: safeGetRefId(itemsValues, 'Support Item Number'),
                serviceArea: sat,
                unit: supportValues.unit,
                unitAttr: 'Unit (Support)',
                unitPrice: resolvePriceForArea(supportValues, sat),
                unitPriceAttr: 'Agreed Unit Price for Support ($)',
            }, 'support', 'Support');
            return res.status(200).json(result);
        }
        case 'provider_travel_non_labour_cost': {
            if (!providerTravelValues) return res.status(200).json({ error: 'Provider Travel Non Labour Cost Item not found' });
            const result = await handleUpdate(workspaceId, boardId, items.id, {
                itemId: safeGetRefId(itemsValues, 'Provider Travel - Non-Labour Cost Item Number'),
                serviceArea: sat,
                unit: providerTravelValues.unit,
                unitAttr: 'Unit (Provider Travel - Non-Labour Cost)',
                unitPrice: resolvePriceForArea(providerTravelValues, sat),
                unitPriceAttr: 'Agreed Unit Price for Non-Labour Travel ($)',
            }, 'provider_travel_non_labour_cost', 'Provider Travel Non Labour Cost');
            return res.status(200).json(result);
        }
        default:
            return res.status(200).json({ error: 'Invalid type', message: 'Invalid type in set-unit-and-unitprice' });
    }
}

async function handleParticipantsServicePlanNew(req, res) {
    const { workspaceId, boardId } = req.params;
    const { type } = req.query;
    const payload = req.body;
    const items = Array.isArray(payload?.items) ? payload.items[0] : null;
    const itemsValues = items?.values || {};

    if (!items?.id) {
        return res.status(200).json({ error: 'Invalid payload', message: 'Missing item id' });
    }

    const normalizedType = (type || '').toString().trim();
    switch (normalizedType) {
        case 'service_area': {
            const pricing = await resolveAllServicePlanPricing(workspaceId, boardId, items.id, itemsValues);
            if (!pricing.serviceAreaValues?.serviceArea && !pricing.serviceAreaValues?.serviceAreaType) {
                return res.status(200).json({ error: 'Service Area Item not found' });
            }
            const result = await applyAllSelectedServicePlanPricing(workspaceId, boardId, items.id, itemsValues);
            return res.status(200).json(result);
        }
        case 'support':
        case 'provider_travel_non_labour_cost':
        case 'labour_travel_time_cost':
        case 'cancellation_cost':
        case 'activity_based_transport': {
            const result = await runServicePlanPricingUpdate(workspaceId, boardId, items.id, itemsValues, normalizedType);
            return res.status(200).json(result);
        }
        case 'update_service_plan_variables':
        case '': {
            const result = await applyAllSelectedServicePlanPricing(workspaceId, boardId, items.id, itemsValues);
            return res.status(200).json(result);
        }
        default: {
            if (NDIS_SERVICE_PLAN_PRICING_MAPPINGS[normalizedType]) {
                const result = await runServicePlanPricingUpdate(workspaceId, boardId, items.id, itemsValues, normalizedType);
                return res.status(200).json(result);
            }
            return res.status(200).json({ error: 'Invalid type', message: 'Invalid type in participants-service-plan' });
        }
    }
}

async function handleMasterPlanNew(req, res) {
    const { workspaceId, boardId } = req.params;
    try {
    const payload = req.body;
    const items = payload.items[0];
    const itemsValues = items.values;

    const [servicePlanValues, , fundValues] = await getNDISMasterPlanNewPricingReferencedItems(workspaceId, boardId, items.id);

    if (!servicePlanValues) {
        setIntegrationMessage(workspaceId, boardId, items.id, "Service Plan Item not found");
        return res.status(200).json({ error: 'Service Plan Item not found' });
    }

    const updateValues = [];
    const responseItemValues = await getItemValues(workspaceId, boardId, items.id);
    const itemValuesWithAttributeId = responseItemValues.values;
    const groupSize = Number(itemsValues['Group Size']) || 1;
    const findAttrId = (name) => itemValuesWithAttributeId.find(v => v.attribute.name === name)?.attribute?.id;
    const cancelled = isShiftCancelled(itemsValues);

    await setIntegrationMessage(workspaceId, boardId, items.id, "Calculating values...");
    const resetValues = [];
    [
        NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE,
        NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_NON_LABOUR_AMOUNT,
        NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT,
        NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_AMOUNT,
        NDIS_MASTERPLAN_ATTR.ALLOWANCES_AMOUNT,
        NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE,
    ].forEach(name => {
        const id = findAttrId(name);
        if (id) resetValues.push({ data: 0, attribute_id: id });
    });
    if (resetValues.length > 0) {
        try {
            await putMasterPlanItemValues(workspaceId, boardId, items.id, resetValues);
        } catch (resetErr) {
            warn('Xero-Service', 'Master plan reset values failed (continuing with calculated values)', {
                workspaceId, boardId, itemId: items.id,
                status: resetErr?.response?.status,
                detail: extractIsoPlusErrorDetail(resetErr),
            }, req ?? null);
        }
    }

    let supportValueNum = 0;
    let providerTravelAmountNum = 0;
    let activityTransportAmountNum = 0;
    let labourTravelAmountNum = 0;
    let allowancesAmountNum = 0;
    let cancellationFeeNum = 0;

    if (!cancelled) {
        const supportAttrId = findAttrId(NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE);
        if (supportAttrId) {
            const duration = Number(itemsValues['Actual Shift Duration(Hr.)']);
            let supportValue;
            if (isHourUnit(servicePlanValues?.supportUnit)) {
                const qty = duration > 0 ? Number(duration.toFixed(1)) : 0;
                supportValue = formatValue((servicePlanValues?.supportUnitPrice || 0) * qty / groupSize);
            } else {
                const qty = Number(itemsValues['Quantity (Non-Time-Based Support)']) || 0;
                supportValue = formatValue((servicePlanValues?.supportUnitPrice || 0) * qty);
            }
            supportValueNum = toApiNumber(supportValue);
            updateValues.push({ data: supportValueNum, attribute_id: supportAttrId });
        }

        if (servicePlanValues?.nonLabourTravelUnitPrice) {
            const ptId = findAttrId(NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_NON_LABOUR_AMOUNT);
            if (ptId) {
                const mileage = Number(itemsValues[NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_MILEAGE]) || 0;
                const otherCosts = Number(itemsValues['Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied ($)'] || itemsValues[NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_OTHER_COSTS]) || 0;
                const amount = formatValue(computeProviderTravelNonLabourAmount(servicePlanValues.nonLabourTravelUnitPrice, mileage, otherCosts));
                providerTravelAmountNum = toApiNumber(amount);
                updateValues.push({ data: providerTravelAmountNum, attribute_id: ptId });
            }
        }

        if (servicePlanValues?.activityBasedTransportUnitPrice) {
            const abtId = findAttrId(NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT);
            if (abtId) {
                const mileage = Number(itemsValues[NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_MILEAGE]) || 0;
                const otherCosts = Number(itemsValues[NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_OTHER_COSTS]) || 0;
                const amount = formatValue(computeActivityBaseTransportAmount(servicePlanValues.activityBasedTransportUnitPrice, mileage, otherCosts));
                activityTransportAmountNum = toApiNumber(amount);
                updateValues.push({ data: activityTransportAmountNum, attribute_id: abtId });
            }
        }

        if (servicePlanValues?.labourTravelTimeUnitPrice) {
            const lttId = findAttrId(NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_AMOUNT);
            if (lttId) {
                const minutes = Number(itemsValues[NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_MIN]) || 0;
                const amount = formatValue(computeLabourTravelTimeAmount(servicePlanValues.labourTravelTimeUnitPrice, minutes));
                labourTravelAmountNum = toApiNumber(amount);
                updateValues.push({ data: labourTravelAmountNum, attribute_id: lttId });
            }
        }

        if (itemsValues['Used Allowance Amount($) as per the Service Plan']) {
            const allowId = findAttrId(NDIS_MASTERPLAN_ATTR.ALLOWANCES_AMOUNT);
            if (allowId) {
                const amount = formatValue(itemsValues[NDIS_MASTERPLAN_ATTR.USED_ALLOWANCE_AMOUNT] || 0);
                allowancesAmountNum = toApiNumber(amount);
                updateValues.push({ data: allowancesAmountNum, attribute_id: allowId });
            }
        }
    }

    if (cancelled) {
        const cancFeeId = findAttrId(NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE);
        if (cancFeeId) {
            const scheduledDuration = Number(itemsValues['Scheduled Shift Duration(Hr.)']) > 0
                ? Number(Number(itemsValues['Scheduled Shift Duration(Hr.)']).toFixed(1))
                : 0;
            const cancUnitPrice = Number(servicePlanValues?.cancellationUnitPrice) || 0;
            const amount = formatValue(scheduledDuration * cancUnitPrice);
            cancellationFeeNum = toApiNumber(amount);
            updateValues.push({ data: cancellationFeeNum, attribute_id: cancFeeId });
        }
    }

    if (fundValues) {
        const fundStatusAttr = itemValuesWithAttributeId.find(v => v.attribute?.name === 'Funding Budget Status');
        if (fundStatusAttr?.attribute?.id) {
            const statusLabelId = resolveConfigurationStatusLabelId(
                fundStatusAttr,
                fundValues.fundingBudgetStatus,
                '#388903'
            );
            if (statusLabelId) {
                updateValues.push({
                    data: [statusLabelId],
                    attribute_id: fundStatusAttr.attribute.id,
                });
            }
        }
    }

    if (updateValues.length === 0) {
        setIntegrationMessage(workspaceId, boardId, items.id, "No master plan values to update");
        return res.status(200).json({ message: 'No master plan values to update' });
    }

    const response = await putMasterPlanItemValues(workspaceId, boardId, items.id, updateValues);
    if (response.status === 200) {
        setIntegrationMessage(workspaceId, boardId, items.id, "Master plan processed successfully");
        return res.status(200).json({ message: 'Master plan processed' });
    }
    setIntegrationMessage(workspaceId, boardId, items.id, "Failed to update master plan");
    return res.status(200).json({ error: 'Failed to update master plan' });
    } catch (err) {
        const isoPlusDetail = extractIsoPlusErrorDetail(err);
        error('Xero-Service', 'Master plan new pricing automation failed', {
            workspaceId: req.params.workspaceId,
            boardId: req.params.boardId,
            status: err?.response?.status,
            detail: isoPlusDetail,
            message: err?.message,
            stack: err?.stack,
        }, req ?? null);
        setIntegrationMessage(
            workspaceId,
            boardId,
            items?.id,
            `Master plan update failed: ${isoPlusDetail}`
        );
        return res.status(200).json({ error: 'Master plan failed', message: isoPlusDetail || err?.message || 'Server error' });
    }
}

router.post('/:workspaceId/:boardId/set-unit-and-unitprice', async (req, res) => {
    const { workspaceId, boardId } = req.params;
    const { type } = req.query;
    const payload = req.body;
    const items = payload.items[0];
    const itemsValues = items.values;

    info('Xero-Service', `Incoming request to set-unit-and-unitprice`, { workspaceId, boardId, type, body: itemsValues }, req ?? null);

    if (await boardUsesNewNdisPricing(workspaceId, boardId)) {
        return handleSetUnitAndUnitPriceNew(req, res);
    }

    let [serviceAreaValues, directSupportValues, providerTravelValues, activityBasedTransportValues, centreCapitalCostsValues] = await getQuoteNDISReferencedItems(workspaceId, boardId, items.id);
    if (serviceAreaValues == null || serviceAreaValues.serviceAreaType == null) {
        serviceAreaValues = {
            serviceAreaType: 'ACT($)'
        }
    }
    const safeGet = (obj, key) => Array.isArray(obj[key]) && obj[key].length > 0 ? obj[key][0] : undefined;

    switch (type) {
        case 'service_area': {
            if (!serviceAreaValues)
                return res.status(200).json({ error: 'Service Area Item not found' });
            if (directSupportValues) {
                const directSupportMappingValues = {
                    itemId: safeGet(itemsValues, 'Direct Support Item Number'),
                    serviceArea: serviceAreaValues.serviceAreaType,
                    unit: directSupportValues.unit,
                    unitAttr: 'Unit (Direct Support)',
                    unitPrice: directSupportValues[serviceAreaValues.serviceAreaType],
                    unitPriceAttr: 'Unit Price for Direct Support($)'
                };
                await handleUpdate(workspaceId, boardId, items.id, directSupportMappingValues, 'direct_support', 'Direct Support');
            }
            if (activityBasedTransportValues) {
                const activityMappingValues = {
                    itemId: safeGet(itemsValues, 'Activity Based Transport Item Number'),
                    serviceArea: serviceAreaValues.serviceAreaType,
                    unit: activityBasedTransportValues.unit,
                    unitAttr: 'Unit (Activity Based Transport)',
                    unitPrice: activityBasedTransportValues[serviceAreaValues.serviceAreaType],
                    unitPriceAttr: 'Unit Price for Activity Based Transport($)'
                };
                await handleUpdate(workspaceId, boardId, items.id, activityMappingValues, 'activity_based_transport', 'Activity Based Transport');
            }
            if (providerTravelValues) {
                const providerTravelMappingValues = {
                    itemId: safeGet(itemsValues, 'Provider Travel - Non-Labour Cost Item Number'),
                    serviceArea: serviceAreaValues.serviceAreaType,
                    unit: providerTravelValues.unit,
                    unitAttr: 'Unit (Provider Travel - Non-Labour Cost)',
                    unitPrice: providerTravelValues[serviceAreaValues.serviceAreaType],
                    unitPriceAttr: 'Unit Price for Provider Travel($)'
                };
                await handleUpdate(workspaceId, boardId, items.id, providerTravelMappingValues, 'provider_travel_non_labour_cost', 'Provider Travel Non Labour Cost');
            }
            if (centreCapitalCostsValues) {
                const centreMappingValues = {
                    itemId: safeGet(itemsValues, 'Centre Capital Costs Item'),
                    serviceArea: serviceAreaValues.serviceAreaType,
                    unit: centreCapitalCostsValues.unit,
                    unitAttr: 'Unit (Centre Capital Costs)',
                    unitPrice: centreCapitalCostsValues[serviceAreaValues.serviceAreaType],
                    unitPriceAttr: 'Unit Price for Centre Capital Costs($)'
                };
                await handleUpdate(workspaceId, boardId, items.id, centreMappingValues, 'centre_capital_cost', 'Centre Capital Costs')
            }

            info('Xero-Service', 'Service area processed successfully', itemsValues, req ?? null);
            return res.status(200).json({ message: 'Service area processed' });
        }
        case 'direct_support': {
            if (!directSupportValues)
                return res.status(200).json({ error: 'Direct Support Item not found' });
            const mappingValues = {
                itemId: safeGet(itemsValues, 'Direct Support Item Number'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: directSupportValues.unit,
                unitAttr: 'Unit (Direct Support)',
                unitPrice: directSupportValues[serviceAreaValues.serviceAreaType],
                unitPriceAttr: 'Unit Price for Direct Support($)'
            };
            const result = await handleUpdate(workspaceId, boardId, items.id, mappingValues, 'direct_support', 'Direct Support');
            return res.status(200).json(result);
        }
        case 'activity_based_transport': {
            if (!activityBasedTransportValues)
                return res.status(200).json({ error: 'Activity Based Transport Item not found' });
            const mappingValues = {
                itemId: safeGet(itemsValues, 'Activity Based Transport Item Number'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: activityBasedTransportValues.unit,
                unitAttr: 'Unit (Activity Based Transport)',
                unitPrice: activityBasedTransportValues[serviceAreaValues.serviceAreaType],
                unitPriceAttr: 'Unit Price for Activity Based Transport($)'
            };
            const result = await handleUpdate(workspaceId, boardId, items.id, mappingValues, 'activity_based_transport', 'Activity Based Transport');
            return res.status(200).json(result);
        }
        case 'provider_travel_non_labour_cost': {
            if (!providerTravelValues)
                return res.status(200).json({ error: 'Provider Travel Non Labour Cost Item not found' });
            const mappingValues = {
                itemId: safeGet(itemsValues, 'Provider Travel - Non-Labour Cost Item Number'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: providerTravelValues.unit,
                unitAttr: 'Unit (Provider Travel - Non-Labour Cost)',
                unitPrice: providerTravelValues[serviceAreaValues.serviceAreaType],
                unitPriceAttr: 'Unit Price for Provider Travel($)'
            };
            const result = await handleUpdate(workspaceId, boardId, items.id, mappingValues, 'provider_travel_non_labour_cost', 'Provider Travel Non Labour Cost');
            return res.status(200).json(result);
        }
        case 'centre_capital_cost': {
            if (!centreCapitalCostsValues)
                return res.status(200).json({ error: 'Centre Capital Cost Item not found' });
            const mappingValues = {
                itemId: safeGet(itemsValues, 'Centre Capital Costs Item'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: centreCapitalCostsValues.unit,
                unitAttr: 'Unit (Centre Capital Costs)',
                unitPrice: centreCapitalCostsValues[serviceAreaValues.serviceAreaType],
                unitPriceAttr: 'Unit Price for Centre Capital Costs($)'
            };
            const result = await handleUpdate(workspaceId, boardId, items.id, mappingValues, 'centre_capital_cost', 'Centre Capital Costs');
            return res.status(200).json(result);
        }
        default:
            warn('Xero-Service', 'Invalid type in set-unit-and-unitprice', { type }, req ?? null);
            return res.status(200).json({ error: 'Invalid type', message: 'Invalid type in set-unit-and-unitprice' });
    }
});

router.post('/:workspaceId/:boardId/participants-service-plan', async (req, res) => {
    const { workspaceId, boardId } = req.params;
    const { type } = req.query;
    try {
        const payload = req.body;
        const items = Array.isArray(payload?.items) ? payload.items[0] : null;
        const itemsValues = items?.values || {};

        info('Xero-Service', `Incoming request to Participants Service Plan`, { workspaceId, boardId, type, itemId: items?.id }, req ?? null);

        if (!items?.id) {
            warn('Xero-Service', 'Missing item in Participants Service Plan payload', { workspaceId, boardId, type }, req ?? null);
            return res.status(200).json({ error: 'Invalid payload', message: 'Missing item id' });
        }

        if (await boardUsesNewNdisPricing(workspaceId, boardId)) {
            return handleParticipantsServicePlanNew(req, res);
        }

        let [serviceAreaValues, directSupportValues, providerTravelValues, activityBasedTransportValues, centreCapitalCostsValues] =
            await getNDISParticipantsServicePlanReferencedItems(workspaceId, boardId, items.id);

        if (serviceAreaValues == null || serviceAreaValues.serviceAreaType == null) {
            serviceAreaValues = { serviceAreaType: 'ACT($)' };
        }

        const safeGet = (obj, key) => Array.isArray(obj?.[key]) && obj[key].length > 0 ? obj[key][0] : undefined;
        const normalizedType = (type || '').toString().trim();
        switch (normalizedType) {
        case 'service_area': {
            if (!serviceAreaValues)
                return res.status(200).json({ error: 'Service Area Item not found' });
            if (directSupportValues) {
                const directSupportMappingValues = {
                    itemId: safeGet(itemsValues, 'Direct Support Item Number'),
                    serviceArea: serviceAreaValues.serviceAreaType,
                    unit: directSupportValues.unit,
                    unitAttr: 'Unit (Direct Support)',
                    unitPrice: directSupportValues[serviceAreaValues.serviceAreaType],
                    unitPriceAttr: 'Agreed Unit Price for Direct Support ($)'
                };
                await handleUpdate(workspaceId, boardId, items.id, directSupportMappingValues, 'direct_support', 'Direct Support', 'Participants-Service-Plan');
            }
            if (activityBasedTransportValues) {
                const activityMappingValues = {
                    itemId: safeGet(itemsValues, 'Activity Based Transport Item Number'),
                    serviceArea: serviceAreaValues.serviceAreaType,
                    unit: activityBasedTransportValues.unit,
                    unitAttr: 'Unit (Activity Based Transport)',
                    unitPrice: activityBasedTransportValues[serviceAreaValues.serviceAreaType],
                    unitPriceAttr: 'Agreed Price for Activity Based Transport ($)'
                };
                await handleUpdate(workspaceId, boardId, items.id, activityMappingValues, 'activity_based_transport', 'Activity Based Transport', 'Participants-Service-Plan');
            }
            if (providerTravelValues) {
                const providerTravelMappingValues = {
                    itemId: safeGet(itemsValues, 'Provider Travel - Non-Labour Cost Item Number'),
                    serviceArea: serviceAreaValues.serviceAreaType,
                    unit: providerTravelValues.unit,
                    unitAttr: 'Unit (Provider Travel - Non-Labour Cost)',
                    unitPrice: providerTravelValues[serviceAreaValues.serviceAreaType],
                    unitPriceAttr: 'Agreed Unit Price for Non-Labour Travel ($)'
                };
                await handleUpdate(workspaceId, boardId, items.id, providerTravelMappingValues, 'provider_travel_non_labour_cost', 'Provider Travel Non Labour Cost', 'Participants-Service-Plan');
            }
            if (centreCapitalCostsValues) {
                const centreMappingValues = {
                    itemId: safeGet(itemsValues, 'Centre Capital Costs Item'),
                    serviceArea: serviceAreaValues.serviceAreaType,
                    unit: centreCapitalCostsValues.unit,
                    unitAttr: 'Unit (Centre Capital Costs)',
                    unitPrice: centreCapitalCostsValues[serviceAreaValues.serviceAreaType],
                    unitPriceAttr: 'Agreed Unit Price for Centre Capital Costs($)'
                };
                await handleUpdate(workspaceId, boardId, items.id, centreMappingValues, 'centre_capital_cost', 'Centre Capital Costs', 'Participants-Service-Plan');
            }

            await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
            info('Xero-Service', 'Service area processed successfully', itemsValues, req ?? null);
            return res.status(200).json({ message: 'Service area processed' });
        }
        case 'direct_support': {
            if (!directSupportValues)
                return res.status(200).json({ error: 'Direct Support Item not found' });
            const mappingValues = {
                itemId: safeGet(itemsValues, 'Direct Support Item Number'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: directSupportValues.unit,
                unitAttr: 'Unit (Direct Support)',
                unitPrice: directSupportValues[serviceAreaValues.serviceAreaType],
                unitPriceAttr: 'Agreed Unit Price for Direct Support ($)'
            };
            const result = await handleUpdate(workspaceId, boardId, items.id, mappingValues, 'direct_support', 'Direct Support', 'Participants-Service-Plan');
            await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
            return res.status(200).json(result);
        }
        case 'activity_based_transport': {
            if (!activityBasedTransportValues)
                return res.status(200).json({ error: 'Activity Based Transport Item not found' });
            const mappingValues = {
                itemId: safeGet(itemsValues, 'Activity Based Transport Item Number'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: activityBasedTransportValues.unit,
                unitAttr: 'Unit (Activity Based Transport)',
                unitPrice: activityBasedTransportValues[serviceAreaValues.serviceAreaType],
                unitPriceAttr: 'Agreed Price for Activity Based Transport ($)'
            };
            const result = await handleUpdate(workspaceId, boardId, items.id, mappingValues, 'activity_based_transport', 'Activity Based Transport', 'Participants-Service-Plan');
            await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
            return res.status(200).json(result);
        }
        case 'provider_travel_non_labour_cost': {
            if (!providerTravelValues)
                return res.status(200).json({ error: 'Provider Travel Non Labour Cost Item not found' });
            const mappingValues = {
                itemId: safeGet(itemsValues, 'Provider Travel - Non-Labour Cost Item Number'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: providerTravelValues.unit,
                unitAttr: 'Unit (Provider Travel - Non-Labour Cost)',
                unitPrice: providerTravelValues[serviceAreaValues.serviceAreaType],
                unitPriceAttr: 'Agreed Unit Price for Non-Labour Travel ($)'
            };
            const result = await handleUpdate(workspaceId, boardId, items.id, mappingValues, 'provider_travel_non_labour_cost', 'Provider Travel Non Labour Cost');
            await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
            return res.status(200).json(result);
        }
        case 'centre_capital_cost': {
            if (!centreCapitalCostsValues)
                return res.status(200).json({ error: 'Centre Capital Cost Item not found' });
            const mappingValues = {
                itemId: safeGet(itemsValues, 'Centre Capital Costs Item'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: centreCapitalCostsValues.unit,
                unitAttr: 'Unit (Centre Capital Costs)',
                unitPrice: centreCapitalCostsValues[serviceAreaValues.serviceAreaType],
                unitPriceAttr: 'Agreed Unit Price for Centre Capital Costs($)'
            };
            const result = await handleUpdate(workspaceId, boardId, items.id, mappingValues, 'centre_capital_cost', 'Centre Capital Costs', 'Participants-Service-Plan');
            await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
            return res.status(200).json(result);
        }
        case 'update_service_plan_variables': {
            const result = await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
            return res.status(200).json(result);
        }
        default: {
            // Some automations trigger this endpoint without query type.
            // In that case, we should still run the variable checks instead of warning.
            if (!normalizedType) {
                const result = await updateVariablesParticipantsServicePlan(workspaceId, boardId, items.id, itemsValues);
                return res.status(200).json(result);
            }
            warn('Xero-Service', 'Invalid type in set-unit', { type }, req ?? null);
            return res.status(200).json({ error: 'Invalid type', message: 'Invalid type in set-unit' });
        }
        }
    } catch (err) {
        error('Xero-Service', 'Participants Service Plan automation failed', {
            workspaceId,
            boardId,
            type,
            message: err?.message,
            stack: err?.stack
        }, req ?? null);
        return res.status(200).json({ error: 'Participants Service Plan failed', message: err?.message || 'Server error' });
    }
});

router.post('/:workspaceId/:boardId/masterplan', async (req, res) => {
    const { workspaceId, boardId } = req.params;
    const payload = req.body;
    const items = payload.items[0];
    const itemsValues = items.values;

    info('Xero-Service', `Incoming request to Master plan`, { workspaceId, boardId, body: itemsValues }, req ?? null);

    if (await masterPlanBoardUsesNewNdisPricing(workspaceId, boardId, items.id)) {
        return handleMasterPlanNew(req, res);
    }

    const [servicePlanValues, cancellationTypeValues, fundValues, participantProfileValues, participationTypeValues] = await getNDISMasterPlanReferencedItems(workspaceId, boardId, items.id);

    if (!servicePlanValues) {
        setIntegrationMessage(workspaceId, boardId, items.id, "Service Plan Item not found");
        return res.status(200).json({ error: 'Service Plan Item not found' });
    }

    let updateValues = [];
    const responseItemValues = await getItemValues(workspaceId, boardId, items.id);
    const itemValuesWithAttributeId = responseItemValues.values;
    const groupSize = Number(itemsValues['Group Size']) || 1;
    const cancelled = isShiftCancelled(itemsValues);

    await setIntegrationMessage(workspaceId, boardId, items.id, "Calculating values...");
    await axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${items.id}`,
        { values: [
            {
                data: 0,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Direct Support Value($) - Time Based Support').attribute.id
            },
            {
                data: 0,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Direct Support Value($) - Non Time Based Support').attribute.id
            },
            {
                data: 0,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Provider Travel - Non-Labour Cost Amount($)').attribute.id
            },
            {
                data: 0,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Activity Base Transport Amount($)').attribute.id
            },
            {
                data: 0,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Centre Capital Costs Amount($)').attribute.id
            },
            {
                data: 0,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Labour Travel Time Amount($)').attribute.id
            },
            {
                data: 0,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Allowances Amount($)').attribute.id
            },
            {
                data: 0,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Non-Face-to-Face Amount($)').attribute.id
            },
            {
                data: 0,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Cancellation Fee($)').attribute.id
            }
        ] },
        {
            headers: {
                "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-API-Version": "2025-02-26.morava",
            }
        }
    );
    if (!cancelled) {
    if (servicePlanValues?.directSupportUnit == 'Hour(H)') {
        updateValues.push({
            data: (() => {
                const duration = Number(itemsValues['Actual Shift Duration(Hr.)']);
                let qty = 0;
                if (duration > 0) {
                    qty = Number(duration.toFixed(1));
                } else {
                    qty = 0;
                }
                return formatValue(servicePlanValues.directSupportUnitPrice * qty / groupSize);
            })(),
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Direct Support Value($) - Time Based Support').attribute.id
        });
        updateValues.push({
            data: 0,
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Direct Support Value($) - Non Time Based Support').attribute.id
        });
    } else {
        updateValues.push({
            data: formatValue(servicePlanValues?.directSupportUnitPrice * (itemsValues['Quantity (Direct Support - Non Time Based Support)'] || 0)),
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Direct Support Value($) - Non Time Based Support').attribute.id
        });
        updateValues.push({
            data: 0,
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Direct Support Value($) - Time Based Support').attribute.id
        });
    }
    if (servicePlanValues?.nonLabourTravelUnitPrice) {
        updateValues.push({
            data: formatValue(servicePlanValues.nonLabourTravelUnitPrice * ((itemsValues['Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a vehicle is used.'] || 0) + (itemsValues['Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied.'] || 0))),
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Provider Travel - Non-Labour Cost Amount($)').attribute.id
        });
    }
    if (servicePlanValues?.activityBasedTransportUnitPrice) {
        updateValues.push({
            data: formatValue(computeActivityBaseTransportAmount(
                servicePlanValues.activityBasedTransportUnitPrice,
                itemsValues[NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_MILEAGE] || 0,
                itemsValues[NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_OTHER_COSTS] || 0,
            )),
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT).attribute.id
        });
    }
    if (servicePlanValues?.centreCapitalCostsUnitPrice) {
        updateValues.push({
            data: (() => {
                const duration = Number(itemsValues['Actual Shift Duration(Hr.)']);
                let qty = 0;
                if (duration > 0) {
                    qty = Number(duration.toFixed(1));
                } else {
                    qty = 0;
                }
                return formatValue(servicePlanValues.centreCapitalCostsUnitPrice * qty);
            })(),
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Centre Capital Costs Amount($)').attribute.id
        });
    } else {
        updateValues.push({
            data: 0,
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Centre Capital Costs Amount($)').attribute.id
        });
    }
    if (servicePlanValues?.labourTravelTimeUnitPrice) {
        updateValues.push({
            data: formatValue(servicePlanValues.labourTravelTimeUnitPrice * (itemsValues['Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable.'] || 0)),
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Labour Travel Time Amount($)').attribute.id
        });
    }
    if (itemsValues['Used Allowance Amount($) as per the Service Plan']) {
        updateValues.push({
            data: formatValue((itemsValues['Used Allowance Amount($) as per the Service Plan'] || 0)),
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Allowances Amount($)').attribute.id
        });
    }
    if (servicePlanValues?.nonFaceToFaceSupportUnitPrice) {
        updateValues.push({
            data: formatValue(servicePlanValues.nonFaceToFaceSupportUnitPrice * (itemsValues['Time spent in the Non-Face-to-Face Amount as per the Service Plan (Hr.)'] || 0)),
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Non-Face-to-Face Amount($)').attribute.id
        });
    }
    }
    if (cancelled) {
        if (!cancellationTypeValues) {
            setIntegrationMessage(workspaceId, boardId, items.id, "A cancellation type is required.");
            return res.status(200).json({ error: 'A cancellation type is required.' });
        }
        const cancellationPercentage = Number(cancellationTypeValues?.billableToClient) || 0;
        const scheduledShiftDuration = (itemsValues['Scheduled Shift Duration(Hr.)'] > 0)
            ? Number(itemsValues['Scheduled Shift Duration(Hr.)']).toFixed(1)
            : 0;
        let cancellationFee = 0;
        if (servicePlanValues?.directSupportShortNoticeCancellations === 'Y') {
            if (servicePlanValues?.directSupportUnit === 'Hour(H)') {
                const baseUnitPrice = groupSize > 0 ? Number(servicePlanValues.directSupportUnitPrice) / groupSize : 0;
                const unitPrice = Number(formatValue(baseUnitPrice * (cancellationPercentage / 100)));
                const amount = formatValue(scheduledShiftDuration * unitPrice);
                cancellationFee += Number(amount);
            } else {
                const nonTimeBasedValue = Number(servicePlanValues.directSupportUnitPrice) || 0;
                const unitPrice = Number(formatValue(nonTimeBasedValue * (cancellationPercentage / 100)));
                const qty = Number(itemsValues['Quantity (Direct Support - Non Time Based Support)']) || 0;
                const amount = formatValue(qty * unitPrice);
                cancellationFee += Number(amount);
            }
        }
        if (servicePlanValues?.providerTravelShortNoticeCancellations === 'Y') {
            const baseUnitPrice = Number(servicePlanValues?.nonLabourTravelUnitPrice) || 0;
            const unitPrice = Number(formatValue(baseUnitPrice * (cancellationPercentage / 100)));
            const amount = formatValue(scheduledShiftDuration * unitPrice);
            cancellationFee += Number(amount);
        }
        if (servicePlanValues?.activityBasedTransportShortNoticeCancellations === 'Y') {
            const baseUnitPrice = Number(servicePlanValues?.activityBasedTransportUnitPrice) || 0;
            const unitPrice = Number(formatValue(baseUnitPrice * (cancellationPercentage / 100)));
            const amount = formatValue(scheduledShiftDuration * unitPrice);
            cancellationFee += Number(amount);
        }
        if (servicePlanValues?.centreCapitalCostsShortNoticeCancellations === 'Y') {
            const baseUnitPrice = Number(servicePlanValues?.centreCapitalCostsUnitPrice) || 0;
            const unitPrice = Number(formatValue(baseUnitPrice * (cancellationPercentage / 100)));
            const amount = formatValue(scheduledShiftDuration * unitPrice);
            cancellationFee += Number(amount);
        }
        updateValues.push({
            data: formatValue(cancellationFee),
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Cancellation Fee($)').attribute.id
        });
    }
    if (fundValues) {
        updateValues.push({
            data: fundValues.fundingBudgetStatus,
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Funding Budget Status').attribute.id
        });
    }

    const response = await axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${items.id}`,
        { values: updateValues },
        {
            headers: {
                "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-API-Version": "2025-02-26.morava",
            }
        }
    );
    if (response.status === 200) {
        setIntegrationMessage(workspaceId, boardId, items.id, "Master plan processed successfully");
        info('Xero-Service', 'Master plan processed successfully', { updateValues }, req ?? null);
        return res.status(200).json({ message: 'Master plan processed' });
    } else {
        setIntegrationMessage(workspaceId, boardId, items.id, "Failed to update master plan");
        warn('Xero-Service', 'Failed to update master plan', { updateValues }, req ?? null);
        return res.status(200).json({ error: 'Failed to update master plan' });
    }
});

async function runParticipantsServicePlanItemAutomation(req, res, mappingKey, webhookType, routeName) {
    const { workspaceId, boardId } = req.params;
    try {
        const items = Array.isArray(req.body?.items) ? req.body.items[0] : null;
        const itemsValues = items?.values || {};
        if (!items?.id) return res.status(200).json({ error: 'Invalid payload', message: 'Missing item id' });
        if (await boardUsesLegacyNdisPricing(workspaceId, boardId)) {
            return res.status(200).json({ error: 'Legacy pricing rule applies for this service plan board.' });
        }
        const result = await runServicePlanPricingUpdate(workspaceId, boardId, items.id, itemsValues, mappingKey, webhookType);
        return res.status(200).json(result);
    } catch (err) {
        return res.status(200).json({ error: `${routeName} failed`, message: err?.message || 'Server error' });
    }
}

router.post('/:workspaceId/:boardId/participants-support-item', async (req, res) => {
    return runParticipantsServicePlanItemAutomation(req, res, 'support', 'Participants-Support-Item', 'participants-support-item');
});

router.post('/:workspaceId/:boardId/participants-provider-travel-item', async (req, res) => {
    const { workspaceId, boardId } = req.params;
    try {
        const items = Array.isArray(req.body?.items) ? req.body.items[0] : null;
        const itemsValues = items?.values || {};
        if (!items?.id) return res.status(200).json({ error: 'Invalid payload', message: 'Missing item id' });
        if (await boardUsesLegacyNdisPricing(workspaceId, boardId)) {
            return res.status(200).json({ error: 'Legacy pricing rule applies for this service plan board.' });
        }
        const result = await runServicePlanPricingUpdate(workspaceId, boardId, items.id, itemsValues, 'provider_travel_non_labour_cost', 'Participants-Provider-Travel-Item');
        return res.status(200).json(result);
    } catch (err) {
        return res.status(200).json({ error: 'participants-provider-travel-item failed', message: err?.message || 'Server error' });
    }
});

router.post('/:workspaceId/:boardId/participants-labour-travel-item', async (req, res) => {
    const { workspaceId, boardId } = req.params;
    try {
        const items = Array.isArray(req.body?.items) ? req.body.items[0] : null;
        const itemsValues = items?.values || {};
        if (!items?.id) return res.status(200).json({ error: 'Invalid payload', message: 'Missing item id' });
        if (await boardUsesLegacyNdisPricing(workspaceId, boardId)) {
            return res.status(200).json({ error: 'Legacy pricing rule applies for this service plan board.' });
        }
        const result = await runServicePlanPricingUpdate(workspaceId, boardId, items.id, itemsValues, 'labour_travel_time_cost', 'Participants-Labour-Travel-Item');
        return res.status(200).json(result);
    } catch (err) {
        return res.status(200).json({ error: 'participants-labour-travel-item failed', message: err?.message || 'Server error' });
    }
});

router.post('/:workspaceId/:boardId/participants-cancellation-item', async (req, res) => {
    const { workspaceId, boardId } = req.params;
    try {
        const items = Array.isArray(req.body?.items) ? req.body.items[0] : null;
        const itemsValues = items?.values || {};
        if (!items?.id) return res.status(200).json({ error: 'Invalid payload', message: 'Missing item id' });
        if (await boardUsesLegacyNdisPricing(workspaceId, boardId)) {
            return res.status(200).json({ error: 'Legacy pricing rule applies for this service plan board.' });
        }
        const result = await runServicePlanPricingUpdate(workspaceId, boardId, items.id, itemsValues, 'cancellation_cost', 'Participants-Cancellation-Item');
        return res.status(200).json(result);
    } catch (err) {
        return res.status(200).json({ error: 'participants-cancellation-item failed', message: err?.message || 'Server error' });
    }
});

router.post('/:workspaceId/:boardId/participants-activity-transport-item', async (req, res) => {
    return runParticipantsServicePlanItemAutomation(req, res, 'activity_based_transport', 'Participants-Activity-Transport-Item', 'participants-activity-transport-item');
});

router.post('/:workspaceId/:boardId/participants-activity-based-transport-item', async (req, res) => {
    return runParticipantsServicePlanItemAutomation(req, res, 'activity_based_transport', 'Participants-Activity-Based-Transport-Item', 'participants-activity-based-transport-item');
});

export default router;