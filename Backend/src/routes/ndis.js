import express from 'express';
import dotenv from 'dotenv';
import { info, warn, error } from '../utils/logger.js';
import { Item } from '../dto/itemsPayload.js';
import { getQuoteNDISReferencedItems, getItemValues, getNDISParticipantsServicePlanReferencedItems, getNDISMasterPlanReferencedItems, setIntegrationMessage } from '../services/isoplus.js';
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
    }
}

const updateUnitAndUnitPrice = async (workspaceId, boardId, itemId, mappingValues, label) => {
    try {
        const itemData = await getItemValues(workspaceId, boardId, itemId);
        if (!itemData) {
            return { error: `${label} item not found` };
        }
        const unit = extractUnit(mappingValues.unit);
        const unitAttr = itemData.values.find(v => v.attribute.name.includes(mappingValues.unitAttr));
        const priceAttr = itemData.values.find(v => v.attribute.name.includes(mappingValues.unitPriceAttr));
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

function hasSelectionValue(itemsValues, key) {
    const raw = itemsValues?.[key];
    if (Array.isArray(raw)) return raw.length > 0;
    return raw !== undefined && raw !== null && raw !== '';
}

function parseNumericValue(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
}

function hasNonZeroValue(value) {
    return Math.abs(parseNumericValue(value)) > 0;
}

function normalizeStringValue(value) {
    if (Array.isArray(value)) {
        return value[0]?.toString().trim() || '';
    }
    return value?.toString().trim() || '';
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
            integrationMessage = 'Error: No Item Number Selected.';
            fallbackColor = '#C60909';
        } else if (!providerTravelClaimable && hasNonZeroValue(labourTravelTimePrice)) {
            integrationMessage = 'Error: Labour Travel Time is not claimable from the NDIA.';
            fallbackColor = '#C60909';
        } else if (!ndiaReportsClaimable && allowancesType === 'NDIA Requested Reports' && hasNonZeroValue(allowancesPrice)) {
            integrationMessage = 'Error: NDIA Requested Reports cost is not claimable from the NDIA.';
            fallbackColor = '#C60909';
        } else if (!nonFaceToFaceClaimable && hasNonZeroValue(nonFaceToFaceSupportPrice)) {
            integrationMessage = 'Error: Non-face-to-face support provision is not claimable from the NDIA.';
            fallbackColor = '#C60909';
        }

        const updateValues = [];
        const servicePlanIdAttributeId = getAttributeIdByName('Service Plan ID');
        if (servicePlanIdAttributeId) {
            let servicePlanIdValue = prioritizedItemNumber;
            if (servicePlanIdValue) {
                updateValues.push({
                    data: servicePlanIdValue,
                    attribute_id: servicePlanIdAttributeId
                });
            }
        }

        const participantNameAttributeId = getAttributeIdByName('Participant Full Name');
        if (participantNameAttributeId) {
            let participantNameValue = normalizeStringValue(participantProfileValues?.fullName);
            if (!participantNameValue) {
                const firstName = normalizeStringValue(participantProfileValues?.firstName);
                const lastName = normalizeStringValue(participantProfileValues?.lastName);
                participantNameValue = `${firstName}${firstName && lastName ? ' ' : ''}${lastName}`.trim();
            }
            updateValues.push({
                data: `${participantNameValue ? participantNameValue + (participantNameValue && prioritizedItemNumber ? ' - ' : '') : ''}${prioritizedItemNumber}`.trim(),
                attribute_id: participantNameAttributeId
            });
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

router.post('/:workspaceId/:boardId/set-unit-and-unitprice', async (req, res) => {
    const { workspaceId, boardId } = req.params;
    const { type } = req.query;
    const payload = req.body;
    const items = payload.items[0];
    const itemsValues = items.values;

    info('Xero-Service', `Incoming request to set-unit-and-unitprice`, { workspaceId, boardId, type, body: itemsValues }, req ?? null);
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
    const payload = req.body;
    const items = payload.items[0];
    const itemsValues = items.values;

    info('Xero-Service', `Incoming request to Participants Service Plan`, { workspaceId, boardId, type, body: itemsValues }, req ?? null);
    let [serviceAreaValues, directSupportValues, providerTravelValues, activityBasedTransportValues, centreCapitalCostsValues] = await getNDISParticipantsServicePlanReferencedItems(workspaceId, boardId, items.id);
    if (serviceAreaValues == null || serviceAreaValues.serviceAreaType == null) {
        serviceAreaValues = {
            serviceAreaType: 'ACT($)'
        }
    }
    const safeGet = (obj, key) => Array.isArray(obj[key]) && obj[key].length > 0 ? obj[key][0] : undefined;
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
});

router.post('/:workspaceId/:boardId/masterplan', async (req, res) => {
    const { workspaceId, boardId } = req.params;
    const payload = req.body;
    const items = payload.items[0];
    const itemsValues = items.values;

    const [servicePlanValues, cancellationTypeValues, fundValues, participantProfileValues, participationTypeValues] = await getNDISMasterPlanReferencedItems(workspaceId, boardId, items.id);

    info('Xero-Service', `Incoming request to Master plan`, { workspaceId, boardId, body: itemsValues }, req ?? null);

    if (!servicePlanValues) {
        setIntegrationMessage(workspaceId, boardId, items.id, "Service Plan Item not found");
        return res.status(200).json({ error: 'Service Plan Item not found' });
    }

    let updateValues = [];
    const responseItemValues = await getItemValues(workspaceId, boardId, items.id);
    const itemValuesWithAttributeId = responseItemValues.values;
    const groupSize = Number(itemsValues['Group Size']) || 1;

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
            data: formatValue(servicePlanValues.activityBasedTransportUnitPrice * ((itemsValues['Activity Base Transport Mileage(Kms) as per the Service Plan, if a vehicle is used.'] || 0) + (itemsValues['Activity Base Transport Costs as per the Service Plan, if other costs are applied.'] || 0))),
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === 'Activity Base Transport Amount($)').attribute.id
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
    if (itemsValues['Job Status'] === 'Cancelled') {
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

export default router;