import express from 'express';
import dotenv from 'dotenv';
import { info, warn, error } from '../utils/logger.js';
import { Item } from '../dto/itemsPayload.js';
import { getQuoteNDISReferencedItems, getItemValues, getParticipantsServicePlanReferencedItems } from '../services/isoplus.js';
import axios from 'axios';

dotenv.config();
const router = express.Router();

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

router.post('/:workspaceId/:boardId/set-unit-and-unitprice', async (req, res) => {
    const { workspaceId, boardId } = req.params;
    const { type } = req.query;
    const payload = req.body;
    const items = payload.items[0];
    const itemsValues = items.values;

    info('Xero-Service', `Incoming request to set-unit-and-unitprice`, { workspaceId, boardId, type, body: itemsValues }, req);
    const [serviceAreaValues, directSupportValues, providerTravelValues, activityBasedTransportValues, centreCapitalCostsValues] = await getQuoteNDISReferencedItems(workspaceId, boardId, items.id);

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

            info('Xero-Service', 'Service area processed successfully', itemsValues, req);
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
            warn('Xero-Service', 'Invalid type in set-unit-and-unitprice', { type }, req);
            return res.status(200).json({ error: 'Invalid type', message: 'Invalid type in set-unit-and-unitprice' });
    }
});

router.post('/:workspaceId/:boardId/participants-service-plan', async (req, res) => {
    const { workspaceId, boardId } = req.params;
    const { type } = req.query;
    const payload = req.body;
    const items = payload.items[0];
    const itemsValues = items.values;

    info('Xero-Service', `Incoming request to Participants Service Plan`, { workspaceId, boardId, type, body: itemsValues }, req);
    const [serviceAreaValues, directSupportValues, centreCapitalCostsValues] = await getParticipantsServicePlanReferencedItems(workspaceId, boardId, items.id);
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
                    unitPriceAttr: 'Agreed Unit Price for Direct Support ($)'
                };
                await handleUpdate(workspaceId, boardId, items.id, directSupportMappingValues, 'direct_support', 'Direct Support', 'Participants-Service-Plan');
            } else if (centreCapitalCostsValues) {
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

            info('Xero-Service', 'Service area processed successfully', itemsValues, req);
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
            return res.status(200).json(result);
        }
        default:
            warn('Xero-Service', 'Invalid type in set-unit', { type }, req);
            return res.status(200).json({ error: 'Invalid type', message: 'Invalid type in set-unit' });
    }
});

export default router;