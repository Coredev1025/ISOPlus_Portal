import express from 'express';
import dotenv from 'dotenv';
import { info, warn, error } from '../utils/logger.js';
import { getItemValues, getAgeCareParticipantsServicePlanReferencedItems, setIntegrationMessage, getAgeCareMasterPlanReferencedItems } from '../services/isoplus.js';
import axios from 'axios';
import {
    categorizeTransaction,
    computeMasterPlanContributions,
    computeMasterPlanQuantity,
    computeMasterPlanTotalAmount,
    isBlank,
    isTimeBasedUnit,
    parseNumber,
} from '../utils/ageCareMasterPlanCalc.js';
import { buildMasterPlanVariableUpdates } from '../utils/ageCareMasterPlanHelpers.js';
import {
    buildAgeCareParticipantServiceUpdates,
    getIsoPlusItemUpdateHeaders,
    resetAgreedUnitPriceFields,
} from '../utils/ageCareParticipantServiceHelpers.js';
import { sanitizeApiPathSegment } from '../utils/securityHelpers.js';

dotenv.config();
const router = express.Router();

function buildSafeIsoPlusItemUrl(workspaceId, boardId, itemId) {
    const safeWorkspaceId = encodeURIComponent(sanitizeApiPathSegment(workspaceId, 'workspaceId'));
    const safeBoardId = encodeURIComponent(sanitizeApiPathSegment(boardId, 'boardId'));
    const safeItemId = encodeURIComponent(sanitizeApiPathSegment(itemId, 'itemId'));
    return `https://app.isoplus.online/api/v2/workspaces/${safeWorkspaceId}/boards/${safeBoardId}/items/${safeItemId}`;
}

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

const checkServiceClaimingConditions = async (workspaceId, boardId, itemId, itemsValues, servicePlanValues) => {
    try {
        const actualShiftEndDate = itemsValues['Actual Shift End Date & Time'];
        const transactionStatus = itemsValues['Transaction Status'];
        const committedATHM = itemsValues['Committed AT-HM for Delivery'];
        const tx = categorizeTransaction({ transactionStatus, committedATHM });

        let errorMessage = 'ERROR: Invalid transaction status or missing required fields. ';

        if (tx.isDelivered && isBlank(actualShiftEndDate)) {
            errorMessage += 'For Delivered status without Actual Shift End Date: Actual Shift End Date cannot be left blank.';
            await setIntegrationMessage(workspaceId, boardId, itemId, errorMessage);
            return { success: false, error: errorMessage };
        }

        // For Cancelled status, Actual Shift End Date should be blank
        if (tx.isCancelled && !isBlank(actualShiftEndDate)) {
            errorMessage += 'For Cancelled status: Actual Shift End Date should be blank. Cancellation percentage should be applied.';
            await setIntegrationMessage(workspaceId, boardId, itemId, errorMessage);
            return { success: false, error: errorMessage };
        }

        // For Committed AT-HM: Transaction Status should be blank
        if (committedATHM && !isBlank(transactionStatus)) {
            errorMessage += 'For Committed AT-HM: Transaction Status should be blank. Item will be shown in Monthly Statement for Scheduled Start Date.';
            await setIntegrationMessage(workspaceId, boardId, itemId, errorMessage);
            return { success: false, error: errorMessage };
        }

        // For Committed AT-HM: Actual Shift End Date should also be blank
        if (committedATHM && !isBlank(actualShiftEndDate)) {
            errorMessage += 'For Committed AT-HM: Actual Shift End Date should be blank. Item will be shown in Monthly Statement for Scheduled Start Date.';
            await setIntegrationMessage(workspaceId, boardId, itemId, errorMessage);
            return { success: false, error: errorMessage };
        }

        if (!committedATHM && isBlank(transactionStatus)) {
            errorMessage += 'Transaction Status is required when Committed AT-HM for Delivery is not ticked.';
            await setIntegrationMessage(workspaceId, boardId, itemId, errorMessage);
            return { success: false, error: errorMessage };
        }

        return { success: true };
    } catch (err) {
        error('AgeCare-Service', 'Error in checkServiceClaimingConditions', { err, workspaceId, boardId, itemId }, { workspaceId, boardId, itemId });
        await setIntegrationMessage(workspaceId, boardId, itemId,
            `An error occurred while checking service claiming conditions: ${err.message}. Please contact support.`);
        return { success: false, error: `An error occurred while checking service claiming conditions: ${err.message}. Please contact support.` };
    }
};

const updateVariablesParticipantsService = async (workspaceId, boardId, itemId, itemsValues) => {
    try {
        const responseItemValues = await getItemValues(workspaceId, boardId, itemId);
        const itemValuesWithAttributeId = responseItemValues.values;

        await resetAgreedUnitPriceFields(axios, workspaceId, boardId, itemId, itemValuesWithAttributeId);

        const referencedItems = await getAgeCareParticipantsServicePlanReferencedItems(workspaceId, boardId, itemId);
        const { updatevariables, integrationMsg, earlyError } = buildAgeCareParticipantServiceUpdates({
            itemValuesWithAttributeId,
            itemsValues,
            referencedItems,
        });

        if (earlyError) {
            await setIntegrationMessage(workspaceId, boardId, itemId, earlyError);
            return { error: earlyError };
        }

        if (integrationMsg) {
            await setIntegrationMessage(workspaceId, boardId, itemId, integrationMsg);
        }

        if (updatevariables.length > 0) {
            const response = await axios.put(
                buildSafeIsoPlusItemUrl(workspaceId, boardId, itemId),
                { values: updatevariables },
                { headers: getIsoPlusItemUpdateHeaders() },
            );
            if (response.status === 200) {
                await setIntegrationMessage(workspaceId, boardId, itemId, "Participants Service Plan variables were updated successfully.");
                info('Xero-Service', 'Participants Service Plan variables were updated successfully.', { updatevariables });
                return { success: true };
            }

            await setIntegrationMessage(workspaceId, boardId, itemId, "Failed to update Participants Service Plan variables. ");
            warn('Xero-Service', 'Failed to update Participants Service Plan variables. ', { updatevariables });
            return { error: 'Failed to update Participants Service Plan variables. ' };
        }

        return { success: true };
    } catch (err) {
        error('AgeCare-Service', 'Error in updateVariablesParticipantsService', { err, workspaceId, boardId, itemId }, { workspaceId, boardId, itemId });
        await setIntegrationMessage(workspaceId, boardId, itemId, "An unknown error occurred while updating Participants Service Plan variables. Please contact the ISO+™ support team.");
        return { error: 'An unknown error occurred while updating Participants Service Plan variables. Please contact the ISO+™ support team.' };
    }
}


const updateVariablesMasterplan = async (workspaceId, boardId, itemId, itemsValues) => {
    try {
        const [servicePlanValues, cancellationTypeValues, participantProfileValues] = await getAgeCareMasterPlanReferencedItems(workspaceId, boardId, itemId);
        if (!servicePlanValues) {
            await setIntegrationMessage(workspaceId, boardId, itemId, "Service Plan item not found.");
            return { error: 'Service Plan item not found.' };
        }

        const responseItemValues = await getItemValues(workspaceId, boardId, itemId);
        const itemValuesWithAttributeId = responseItemValues.values;

        const transactionStatus = itemsValues["Transaction Status"];
        const committedATHM = itemsValues['Committed AT-HM for Delivery'];
        const tx = categorizeTransaction({ transactionStatus, committedATHM });

        const checkServiceClaimingConditionsResult = await checkServiceClaimingConditions(workspaceId, boardId, itemId, itemsValues, servicePlanValues);
        if (checkServiceClaimingConditionsResult.success === false) {
            return { error: checkServiceClaimingConditionsResult.error };
        }

        if (tx.isAdjustment) {
            await setIntegrationMessage(workspaceId, boardId, itemId, "Adjustment transaction detected. Master Plan variables are managed manually and were not overwritten.");
            return { success: true };
        }

        const actualDuration = parseNumber(itemsValues["Actual Shift Duration(Hr.)"] || 0);
        const scheduledDuration = parseNumber(itemsValues["Scheduled Shift Duration(Hr.)"] || 0);
        const quantityNonTimeBased = parseNumber(itemsValues["Quantity (Non-Time-Based Service)"] || 0);

        const unit = servicePlanValues.unit;
        const isTimeBased = isTimeBasedUnit(unit);

        const quantity = computeMasterPlanQuantity({
            isTimeBased,
            tx,
            actualDuration,
            scheduledDuration,
            quantityNonTimeBased,
        });

        const unitPrice = parseNumber(servicePlanValues.unitPrice);
        const totalAmount = computeMasterPlanTotalAmount({
            unitPrice,
            quantity,
            tx,
            billableToClientPct: cancellationTypeValues?.billableToClient,
        });

        if (tx.isCancelled && (!cancellationTypeValues || isBlank(cancellationTypeValues?.billableToClient))) {
            await setIntegrationMessage(workspaceId, boardId, itemId, "Cancellation Type item not found.");
            return { error: 'Cancellation Type item not found.' };
        }

        const contributions = computeMasterPlanContributions({
            totalAmount,
            participantContributionPct: servicePlanValues.participantContribution,
            tx,
        });

        const participantContribution = contributions.participantContribution;
        const governmentSubsidy = contributions.governmentSubsidy;

        const getAttributeId = (attributeName) => {
            const attribute = itemValuesWithAttributeId.find(v => v.attribute?.name === attributeName);
            return attribute?.attribute?.id;
        };

        const updatevariables = buildMasterPlanVariableUpdates({
            getAttributeId,
            servicePlanValues,
            quantity,
            unitPrice,
            totalAmount,
            governmentSubsidy,
            participantContribution,
        });

        if (updatevariables.length > 0) {
            const response = await axios.put(
                buildSafeIsoPlusItemUrl(workspaceId, boardId, itemId),
                { values: updatevariables },
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
                await setIntegrationMessage(workspaceId, boardId, itemId, "Master Plan variables were updated successfully.");
                info('Xero-Service', 'Master Plan variables were updated successfully.', { updatevariables });
                return { success: true };
            } else {
                await setIntegrationMessage(workspaceId, boardId, itemId, "Failed to update Master Plan variables.");
                warn('Xero-Service', 'Failed to update Master Plan variables.', { updatevariables });
                return { error: 'Failed to update Master Plan variables.' };
            }
        } else {
            return { success: true };
        }
    } catch (err) {
        error('AgeCare-Service', 'Error in updateVariablesMasterplan', { err, workspaceId, boardId, itemId }, { workspaceId, boardId, itemId });
        await setIntegrationMessage(workspaceId, boardId, itemId, "An unknown error occurred while updating Master Plan variables. Please contact the ISO+™ support team.");
        return { error: 'An unknown error occurred while updating Master Plan variables. Please contact the ISO+™ support team.' };
    }
}

const updateParticipantsServiceplan = async (workspaceId, boardId, itemId, itemsValues) => {
    try {
        const [servicePlanValues, cancellationTypeValues, participantProfileValues] = await getAgeCareMasterPlanReferencedItems(workspaceId, boardId, itemId);
        if (!servicePlanValues) {
            await setIntegrationMessage(workspaceId, boardId, itemId, "Service Plan Item not found");
            return { error: 'Service Plan Item not found' };
        }

        const responseMasteplanValues = await getItemValues(workspaceId, boardId, itemId);
        const masterplanValuesWithAttributeId = responseMasteplanValues.values;

        const responseItemValues = await getItemValues(workspaceId, boardId, masterplanValuesWithAttributeId.find(v => v.attribute.name === "Service Plan").data.toString());
        const itemValuesWithAttributeId = responseItemValues.values;

        const unit = itemsValues["Unit"];
        const unitPrice = itemsValues["Unit Price ($)"];
        let updatevariables = [];

        if (unit != ' ' && unit != null && unit != undefined) {
            updatevariables.push({
                data: unit,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Unit").attribute.id
            });
        }

        if (unitPrice != ' ' && unitPrice != null && unitPrice != undefined) {
            updatevariables.push({
                data: unitPrice,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
            });
        }
        if (updatevariables.length > 0) {
            const servicePlanRef = masterplanValuesWithAttributeId.find((v) => v.attribute.name === 'Service Plan');
            const servicePlanItemId = sanitizeApiPathSegment(servicePlanRef.data.toString(), 'itemId');
            const response = await axios.put(
                buildSafeIsoPlusItemUrl(workspaceId, boardId, servicePlanItemId),
                { values: updatevariables },
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
                await setIntegrationMessage(workspaceId, boardId, itemId, "Participants ServicePlan updated successfully");
                info('Xero-Service', 'Participants ServicePlan updated successfully', { updatevariables });
                const result = await updateVariablesMasterplan(workspaceId, boardId, itemId, itemsValues);
                if (result.error) {
                    return { error: result.error };
                } else {
                    return { success: true };
                }
            } else {
                await setIntegrationMessage(workspaceId, boardId, itemId, "Failed to update Participants ServicePlan");
                warn('Xero-Service', 'Failed to update Participants ServicePlan', { updatevariables });
                return { error: 'Failed to update Participants ServicePlan' };
            }
        }
        return { success: true };
    } catch (err) {
        error('AgeCare-Service', 'Error in updateParticipantsServiceplan', { err, workspaceId, boardId, itemId }, { workspaceId, boardId, itemId });
        return { error: 'While updating Participants ServicePlan, an unknown error occurred. Please contact ISO+ Portal Support team.' };
    }
}

router.post('/:workspaceId/:boardId/update-variables-participants-service', async (req, res) => {
    const workspaceId = sanitizeApiPathSegment(req.params.workspaceId, 'workspaceId');
    const boardId = sanitizeApiPathSegment(req.params.boardId, 'boardId');
    const items = req.body.items[0];
    const itemId = sanitizeApiPathSegment(items.id, 'itemId');
    const itemsValues = items.values;

    info('AgeCare-Service', `Incoming request to update variables participants service`, { workspaceId, boardId, itemId, itemsValues }, req ?? null);
    const result = await updateVariablesParticipantsService(workspaceId, boardId, itemId, itemsValues);
    if (result.error) {
        return res.status(200).json({ error: result.error });
    }
    res.status(200).json({ message: 'Variables participants service updated' });
});

router.post('/:workspaceId/:boardId/update-variables-masterplan', async (req, res) => {
    const workspaceId = sanitizeApiPathSegment(req.params.workspaceId, 'workspaceId');
    const boardId = sanitizeApiPathSegment(req.params.boardId, 'boardId');
    const items = req.body.items[0];
    const itemId = sanitizeApiPathSegment(items.id, 'itemId');
    const itemsValues = items.values;

    info('AgeCare-Service', `Incoming request to update variables MasterPlan`, { workspaceId, boardId, itemId, itemsValues }, req ?? null);
    const result = await updateVariablesMasterplan(workspaceId, boardId, itemId, itemsValues);

    if (result.error) {
        return res.status(200).json({ error: result.error });
    }
    res.status(200).json({ success: result.success, message: 'Variables MasterPlan updated' });
});

export default router;