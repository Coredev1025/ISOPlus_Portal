import express from 'express';
import dotenv from 'dotenv';
import { info, warn, error } from '../utils/logger.js';
import { Item } from '../dto/itemsPayload.js';
import { getQuoteNDISReferencedItems, getItemValues } from '../services/isoplus.js';
import axios from 'axios';

dotenv.config();
const router = express.Router();

function extractUnit(unitString) {
    if (!unitString) return '';
    const match = unitString.match(/\(([^)]+)\)/);
    return match ? match[1] : unitString;
}

const updateUnitAndUnitPrice = async (workspaceId, boardId, itemId, mappingValues, label) => {
    try {
        const itemData = await getItemValues(workspaceId, boardId, itemId);
        if (!itemData) {
            return { error: `${label} item not found` };
        }
        const unit = extractUnit(mappingValues.unit);
        const unitAttr = itemData.values.find(v => v.attribute.name === 'Unit');
        const priceAttrname = mappingValues.serviceArea;
        const priceAttr = itemData.values.find(v => v.attribute.name.includes(priceAttrname));
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

async function handleUpdate(type, mappingValues, itemId, req, label) {
    const { workspaceId, boardId } = req.params;

    const { error: validationError } = Item.validate('NDISPricing', mappingValues);
    if (validationError) {
        error('Xero-Service', `Validation error in set-unit-and-unitprice for ${type}`, { details: validationError.details, mappingValues }, req);
        return { message: validationError.details, error: 'Validation error' };
    }
    const result = await updateUnitAndUnitPrice(workspaceId, boardId, itemId, mappingValues, label);
    if (result.error) {
        warn('Xero-Service', `${label} update failed`, { result }, req);
        return { message: `${label} update failed`, error: result.error };
    } else {
        info('Xero-Service', `${label} item updated successfully`, { result }, req);
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
            const directSupportMappingValues = {
                itemId: safeGet(itemsValues, 'Direct Support Item Number'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: itemsValues['Unit (Direct Support)'],
                unitPrice: itemsValues['Unit Price for Direct Support($)']
            };
            const activityMappingValues = {
                itemId: safeGet(itemsValues, 'Activity Based Transport Item Number'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: itemsValues['Unit (Activity Based Transport)'],
                unitPrice: itemsValues['Unit Price for Activity Based Transport($)']
            };
            const providerTravelMappingValues = {
                itemId: safeGet(itemsValues, 'Provider Travel - Non-Labour Cost Item Number'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: itemsValues['Unit (Provider Travel - Non-Labour Cost)'],
                unitPrice: itemsValues['Unit Price for Provider Travel($)']
            };
            const centreMappingValues = {
                itemId: safeGet(itemsValues, 'Centre Capital Costs Item'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: itemsValues['Unit (Centre Capital Costs)'],
                unitPrice: itemsValues['Unit Price for Centre Capital Costs($)']
            };

            info('Xero-Service', 'Processing service type', { DirectSupport: directSupportMappingValues, Activity: activityMappingValues, ProviderTravel: providerTravelMappingValues, Centre: centreMappingValues }, req);

            const result = await Promise.all([
                handleUpdate('direct_support', directSupportMappingValues, directSupportValues?.id, req, 'Direct Support'),
                handleUpdate('activity_based_transport', activityMappingValues, activityBasedTransportValues?.id, req, 'Activity Based Transport'),
                handleUpdate('provider_travel_non_labour_cost', providerTravelMappingValues, providerTravelValues?.id, req, 'Provider Travel Non Labour Cost'),
                handleUpdate('centre_capital_cost', centreMappingValues, centreCapitalCostsValues?.id, req, 'Centre Capital Costs')
            ]);

            info('Xero-Service', 'Service area processed successfully', { DirectSupport: directSupportMappingValues, Activity: activityMappingValues, ProviderTravel: providerTravelMappingValues, Centre: centreMappingValues }, req);
            return res.status(200).json({ message: 'Service area processed', result });
        }
        case 'direct_support': {
            const mappingValues = {
                itemId: safeGet(itemsValues, 'Direct Support Item Number'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: itemsValues['Unit (Direct Support)'],
                unitPrice: itemsValues['Unit Price for Direct Support($)']
            };
            const result = await handleUpdate('direct_support', mappingValues, directSupportValues?.id, req, 'Direct Support');
            return res.status(200).json(result);
        }
        case 'activity_based_transport': {
            const mappingValues = {
                itemId: safeGet(itemsValues, 'Activity Based Transport Item Number'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: itemsValues['Unit (Activity Based Transport)'],
                unitPrice: itemsValues['Unit Price for Activity Based Transport($)']
            };
            const result = await handleUpdate('activity_based_transport', mappingValues, activityBasedTransportValues?.id, req, 'Activity Based Transport');
            return res.status(200).json(result);
        }
        case 'provider_travel_non_labour_cost': {
            const mappingValues = {
                itemId: safeGet(itemsValues, 'Provider Travel - Non-Labour Cost Item Number'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: itemsValues['Unit (Provider Travel - Non-Labour Cost)'],
                unitPrice: itemsValues['Unit Price for Provider Travel($)']
            };
            const result = await handleUpdate('provider_travel_non_labour_cost', mappingValues, providerTravelValues?.id, req, 'Provider Travel Non Labour Cost');
            return res.status(200).json(result);
        }
        case 'centre_capital_cost': {
            const mappingValues = {
                itemId: safeGet(itemsValues, 'Centre Capital Costs Item'),
                serviceArea: serviceAreaValues.serviceAreaType,
                unit: itemsValues['Unit (Centre Capital Costs)'],
                unitPrice: itemsValues['Unit Price for Centre Capital Costs($)']
            };
            const result = await handleUpdate('centre_capital_cost', mappingValues, centreCapitalCostsValues?.id, req, 'Centre Capital Costs');
            return res.status(200).json(result);
        }
        default:
            warn('Xero-Service', 'Invalid type in set-unit-and-unitprice', { type }, req);
            return res.status(200).json({ error: 'Invalid type', message: 'Invalid type in set-unit-and-unitprice' });
    }
});

export default router;