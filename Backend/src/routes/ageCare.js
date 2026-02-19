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

        let updatevariables = [];
        await axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`,
            {
                values: [
                    {
                        data: 0,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                    },
                    {
                        data: 0,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Participant Contribution (%)").attribute.id
                    }
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

        const [participantsProfileValues, homeSupportValues, assistiveTechnologyShortTermValues, assistiveTechnologyOngoingValues, homeModificationValues, healthProfessionalValues, wraparoundValues] = await getAgeCareParticipantsServicePlanReferencedItems(workspaceId, boardId, itemId);
        const serviceCategory = itemValuesWithAttributeId.find(v => v.attribute.name === "Service Category")
        let fullName = '';
        if (participantsProfileValues) {
            fullName = participantsProfileValues?.fullName;
            if (fullName == '' || fullName == null || fullName == undefined) {
                if (participantsProfileValues?.firstName != '' && participantsProfileValues?.firstName != null && participantsProfileValues?.firstName != undefined) {
                    fullName = participantsProfileValues?.firstName;
                }
                if (participantsProfileValues?.lastName != '' && participantsProfileValues?.lastName != null && participantsProfileValues?.lastName != undefined) {
                    fullName = (fullName ? fullName + " " : "") + participantsProfileValues?.lastName;
                }
            }
        }
        if (fullName != '') {
            fullName += ' - ';
        }
        const getAttributeIdByName = (attributeName) => {
            const attributeValue = itemValuesWithAttributeId.find(v => v.attribute?.name === attributeName);
            return attributeValue?.attribute?.id;
        };

        const unitAttributeId = getAttributeIdByName("Unit");
        const agreedUnitPriceAttributeId = getAttributeIdByName("Agreed Unit Price ($)");
        const participantContributionAttributeId = getAttributeIdByName("Participant Contribution (%)");
        const servicePlanIdAttributeId = getAttributeIdByName("Service Plan ID");

        const serviceCategoryLabelId = serviceCategory?.data?.toString();
        const serviceCategoryLabelName = serviceCategoryLabelId
            ? serviceCategory?.attribute?.settings?.labels?.find(l => l.id === serviceCategoryLabelId)?.name || ''
            : '';

        let selectedMainService = null;
        let servicePlanIdValue = '';

        switch (serviceCategoryLabelName) {
            case '🧑‍⚕️ Home Support (HS)': {
                if (homeSupportValues) {
                    selectedMainService = homeSupportValues;
                    servicePlanIdValue = fullName + homeSupportValues.service;
                }
                break;
            }
            case '🦽 Assistive Technology (AT) - Short-term': {
                if (assistiveTechnologyShortTermValues) {
                    selectedMainService = assistiveTechnologyShortTermValues;
                    if (wraparoundValues && wraparoundValues.wraparoundDescription) {
                        servicePlanIdValue = `${fullName}${wraparoundValues.wraparoundDescription} for ${assistiveTechnologyShortTermValues.service}`;
                    } else {
                        servicePlanIdValue = fullName + assistiveTechnologyShortTermValues.service;
                    }
                }
                break;
            }
            case '🦼 Assistive Technology (AT) - Ongoing': {
                if (assistiveTechnologyOngoingValues) {
                    selectedMainService = assistiveTechnologyOngoingValues;
                    if (wraparoundValues && wraparoundValues.wraparoundDescription) {
                        servicePlanIdValue = `${fullName}${wraparoundValues.wraparoundDescription} for ${assistiveTechnologyOngoingValues.service}`;
                    } else {
                        servicePlanIdValue = fullName + assistiveTechnologyOngoingValues.service;
                    }
                }
                break;
            }
            case '🛠️ Home Modification (HM)': {
                if (homeModificationValues) {
                    selectedMainService = homeModificationValues;
                    if (wraparoundValues && wraparoundValues.wraparoundDescription) {
                        servicePlanIdValue = `${fullName}${wraparoundValues.wraparoundDescription} for ${homeModificationValues.service}`;
                    } else {
                        servicePlanIdValue = fullName + homeModificationValues.service;
                    }
                }
                break;
            }
            case '🩺 AT Health Professional': { }
            case '🩺 HM Health Professional': {
                if (healthProfessionalValues) {
                    selectedMainService = healthProfessionalValues;
                    if (wraparoundValues && wraparoundValues.wraparoundDescription) {
                        servicePlanIdValue = `${fullName}${wraparoundValues.wraparoundDescription} for ${healthProfessionalValues.service}`;
                    } else {
                        servicePlanIdValue = fullName + healthProfessionalValues.service;
                    }
                }
                break;
            }
            case '📌 AT Wraparound': { }
            case '📌 HM Wraparound': {
                selectedMainService = assistiveTechnologyShortTermValues ||
                    assistiveTechnologyOngoingValues ||
                    homeModificationValues ||
                    healthProfessionalValues ||
                    homeSupportValues ||
                    null;

                if (wraparoundValues?.wraparoundDescription) {
                    let nextServicePlanIdValue = `${fullName}${wraparoundValues.wraparoundDescription}`;

                    const companionService = assistiveTechnologyShortTermValues?.service ||
                        assistiveTechnologyOngoingValues?.service ||
                        homeModificationValues?.service ||
                        healthProfessionalValues?.service;

                    if (companionService) {
                        nextServicePlanIdValue = `${fullName}${wraparoundValues.wraparoundDescription} for ${companionService}`;
                    }

                    servicePlanIdValue = nextServicePlanIdValue;
                }
                break;
            }
        }

        if (servicePlanIdValue && servicePlanIdAttributeId) {
            updatevariables.push({
                data: servicePlanIdValue,
                attribute_id: servicePlanIdAttributeId
            });
        }

        const parseContributionPctFromGuideline = (guideline) => {
            if (!guideline) return 0;
            const text = guideline.toString();
            const first = text.includes('-') ? text.split('-')[0] : text;
            const parsed = parseFloat(first);
            return Number.isFinite(parsed) ? parsed : 0;
        };

        const wraparoundSelected = !!wraparoundValues;
        const mainServiceWraparoundText = (selectedMainService?.wraparound || '').toString().toLowerCase();
        const wraparoundNotApplicable = wraparoundSelected && (
            !!homeSupportValues ||
            (mainServiceWraparoundText && (mainServiceWraparoundText.includes('not applicable') || mainServiceWraparoundText.includes('n/a')))
        );

        const pricingSource = wraparoundSelected ? wraparoundValues : selectedMainService;
        if (pricingSource || wraparoundNotApplicable) {
            const unitToSet = wraparoundNotApplicable ? '0' : (pricingSource?.unit ?? null);
            const unitPriceToSet = wraparoundNotApplicable ? 0 : Number(pricingSource?.unitPrice);
            const contributionPctToSet = wraparoundNotApplicable
                ? 0
                : parseContributionPctFromGuideline(pricingSource?.participantContributionGuideline);

            if (unitAttributeId && unitToSet !== null && unitToSet !== undefined) {
                updatevariables.push({
                    data: unitToSet,
                    attribute_id: unitAttributeId
                });
            }
            if (agreedUnitPriceAttributeId && Number(unitPriceToSet) >= 0) {
                updatevariables.push({
                    data: Number(unitPriceToSet),
                    attribute_id: agreedUnitPriceAttributeId
                });
            }
            if (participantContributionAttributeId && Number(contributionPctToSet) >= 0) {
                updatevariables.push({
                    data: Number(contributionPctToSet),
                    attribute_id: participantContributionAttributeId
                });
            }
        }

        const statusAttribute = itemValuesWithAttributeId.find(v => v.attribute.name === "Configuration Status");
        const categoryAttribute = itemValuesWithAttributeId.find(v => v.attribute.name === "Service Category");
        const wraparoundAttribute = itemValuesWithAttributeId.find(v => v.attribute.name === "Wraparound Category");

        if (statusAttribute) {
            const categoryLabelId = categoryAttribute?.data?.toString();
            const categoryLabelName = categoryAttribute?.attribute?.settings?.labels?.find(l => l.id === categoryLabelId)?.name || '';

            const wraparoundCategoryLabelId = wraparoundAttribute?.data?.toString();
            const wraparoundCategoryLabelName = wraparoundAttribute
                ? wraparoundAttribute.attribute.settings.labels.find(l => l.id === wraparoundCategoryLabelId)?.name || ''
                : '';

            const countHS = (itemsValues["Home Support (HS)"]?.length || 0);
            const countATShort = (itemsValues["Assistive Technology (AT) - Short Term"]?.length || 0);
            const countATOngoing = (itemsValues["Assistive Technology (AT) - Ongoing"]?.length || 0);
            const countHM = (itemsValues["Home Modification (HM)"]?.length || 0);
            const countHP = (itemsValues["Health Professional"]?.length || 0);
            const countWraparound = (itemsValues["Wraparound"]?.length || 0);

            const nonWrapCounts = [countHS, countATShort, countATOngoing, countHM, countHP];
            const numGroupsSelectedExclWrap = nonWrapCounts.filter(c => c > 0).length;
            const hasMultipleInAnyGroup = [...nonWrapCounts, countWraparound].some(c => c > 1);
            const wraparoundSelected = countWraparound > 0;

            const selectedMap = {
                homeSupport: !!homeSupportValues,
                assistiveTechnologyShortTerm: !!assistiveTechnologyShortTermValues,
                assistiveTechnologyOngoing: !!assistiveTechnologyOngoingValues,
                homeModification: !!homeModificationValues,
                healthProfessional: !!healthProfessionalValues,
                wraparound: !!wraparoundValues,
            };

            let expectedKey = '';
            if (categoryLabelName.includes('Home Support')) expectedKey = 'homeSupport';
            else if (categoryLabelName.includes('Short') || categoryLabelName.includes('Short-term')) expectedKey = 'assistiveTechnologyShortTerm';
            else if (categoryLabelName.includes('Ongoing')) expectedKey = 'assistiveTechnologyOngoing';
            else if (categoryLabelName.includes('Home Modification')) expectedKey = 'homeModification';
            else if (categoryLabelName.includes('Health Professional')) expectedKey = 'healthProfessional';
            else if (categoryLabelName.includes('Wraparound')) expectedKey = 'wraparound';

            let statusColor = '';
            let integrationMsg = '';

            if (!statusColor && numGroupsSelectedExclWrap === 0 && countWraparound === 0 && expectedKey) {
                statusColor = '#C60909';
                integrationMsg = 'Error: Misalignment of Service Category. The selected service does not match the assigned service category.';
            }

            if (!statusColor && hasMultipleInAnyGroup) {
                statusColor = '#EE691E';
                integrationMsg = 'Error: Multiple Services within a Group. Please select only one service in each group.';
            }

            if (!statusColor && numGroupsSelectedExclWrap > 1) {
                statusColor = '#EE691E';
                integrationMsg = 'Error: Multiple Service Groups. Please select only one service group (Wraparound can be combined with other categories except Home Support).';
            }

            if (!statusColor && wraparoundSelected && numGroupsSelectedExclWrap === 0) {
                statusColor = '#CA56A8';
                integrationMsg = 'Error: Wraparound cannot be chosen as a Standalone Service. Please select a service category (except Home Support).';
            }

            if (!statusColor && wraparoundSelected && countHS > 0) {
                statusColor = '#3578D1';
                integrationMsg = 'Error: Wraparound is NOT Applicable. The selected service does not support Wraparound according to Aged Care Pricing guidelines.';
            }

            if (!statusColor && wraparoundSelected) {
                const selectedService = homeSupportValues || assistiveTechnologyShortTermValues ||
                    assistiveTechnologyOngoingValues || homeModificationValues || healthProfessionalValues;

                if (selectedService && selectedService.wraparound) {
                    const wraparoundValue = selectedService.wraparound.toLowerCase();
                    if (wraparoundValue.includes('not applicable') || wraparoundValue.includes('n/a')) {
                        statusColor = '#3578D1';
                        integrationMsg = 'Error: Wraparound is NOT Applicable. The selected service does not support Wraparound according to Aged Care Pricing guidelines.';
                    }
                }
            }

            if (!statusColor && wraparoundSelected && wraparoundCategoryLabelName) {
                let wraparoundPrefix = '';
                if (typeof wraparoundCategoryLabelName === 'string') {
                    if (wraparoundCategoryLabelName.includes('AT')) {
                        wraparoundPrefix = 'AT';
                    } else if (wraparoundCategoryLabelName.includes('HM')) {
                        wraparoundPrefix = 'HM';
                    }
                }

                const inferSelectedMainPrefix = () => {
                    if (categoryLabelName.includes('Home Modification') || categoryLabelName.includes('(HM)') || categoryLabelName.includes('HM Health Professional')) {
                        return 'HM';
                    }
                    if (categoryLabelName.includes('Assistive Technology') || categoryLabelName.includes('(AT)') || categoryLabelName.includes('AT Health Professional')) {
                        return 'AT';
                    }
                    if (categoryLabelName.includes('Wraparound')) {
                        if (countHM > 0) return 'HM';
                        if (countATShort > 0 || countATOngoing > 0) return 'AT';
                    }
                    return '';
                };

                const selectedMainPrefix = inferSelectedMainPrefix();

                let wraparoundDescPrefix = '';
                if (wraparoundValues?.wraparoundDescription && typeof wraparoundValues.wraparoundDescription === 'string') {
                    if (wraparoundValues.wraparoundDescription.includes('AT')) {
                        wraparoundDescPrefix = 'AT';
                    } else if (wraparoundValues.wraparoundDescription.includes('HM')) {
                        wraparoundDescPrefix = 'HM';
                    }
                }

                if (!statusColor && wraparoundPrefix && selectedMainPrefix && wraparoundPrefix !== selectedMainPrefix) {
                    statusColor = '#D99C05';
                    integrationMsg = 'Error: Misalignment of Wraparound Category. The starting letters of the selected Wraparound do not match the Wraparound Category.';
                }

                if (!statusColor && wraparoundPrefix && wraparoundDescPrefix && wraparoundPrefix !== wraparoundDescPrefix) {
                    statusColor = '#D99C05';
                    integrationMsg = 'Error: Misalignment of Wraparound Category. The starting letters of the selected Wraparound do not match the Wraparound Category.';
                }
            }

            if (!statusColor && numGroupsSelectedExclWrap === 1) {
                const selectedKey = ['homeSupport','assistiveTechnologyShortTerm','assistiveTechnologyOngoing','homeModification','healthProfessional']
                    .filter((k, idx) => nonWrapCounts[idx] > 0)[0];
                if (expectedKey && expectedKey !== 'wraparound' && selectedKey !== expectedKey) {
                    statusColor = '#C60909';
                    integrationMsg = 'Error: Misalignment of Service Category. The selected service does not match the assigned service category.';
                }
            }
            const anySelected = (numGroupsSelectedExclWrap + countWraparound) > 0;
            if (!statusColor && anySelected) {
                statusColor = '#388903';
                integrationMsg = 'Aligned and Correct Selection.';
            }

            if (statusColor) {
                updatevariables.push({
                    data: [statusAttribute.attribute.settings.labels.find(l => l.color === statusColor)?.id || ''],
                    attribute_id: statusAttribute.attribute.id
                });
            }

            if (integrationMsg) {
                await setIntegrationMessage(workspaceId, boardId, itemId, integrationMsg);
            }
        } else {
            await setIntegrationMessage(workspaceId, boardId, itemId, "Configuration Status is required.");
            return { error: 'Configuration Status is required.' };
        }

        if (updatevariables.length > 0) {
            const response = await axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`,
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
                await setIntegrationMessage(workspaceId, boardId, itemId, "Participants Service Plan variables were updated successfully.");
                info('Xero-Service', 'Participants Service Plan variables were updated successfully.', { updatevariables });
                return { success: true };
            } else {
                await setIntegrationMessage(workspaceId, boardId, itemId, "Failed to update Participants Service Plan variables. ");
                warn('Xero-Service', 'Failed to update Participants Service Plan variables. ', { updatevariables });
                return { error: 'Failed to update Participants Service Plan variables. ' };
            }
        } else {
            return { success: true };
        }
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

        let updatevariables = [];

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

        if (servicePlanValues.unit != ' ' && servicePlanValues.unit != null && servicePlanValues.unit != undefined) {
            const unitAttributeId = getAttributeId("Unit");
            if (unitAttributeId) {
                updatevariables.push({
                    data: servicePlanValues.unit,
                    attribute_id: unitAttributeId
                });
            }
        }
        if (quantity !== null) {
            const quantityAttributeId = getAttributeId("Quantity");
            if (quantityAttributeId) {
                updatevariables.push({
                    data: quantity,
                    attribute_id: quantityAttributeId
                });
            }
        }
        if (unitPrice >= 0) {
            const unitPriceAttributeId = getAttributeId("Unit Price ($)");
            if (unitPriceAttributeId) {
                updatevariables.push({
                    data: unitPrice,
                    attribute_id: unitPriceAttributeId
                });
            }
        }
        const totalAmountAttributeId = getAttributeId("Total Amount ($)");
        if (totalAmountAttributeId && totalAmount !== null) {
            updatevariables.push({
                data: totalAmount,
                attribute_id: totalAmountAttributeId
            });
        }
        const governmentSubsidyAttributeId = getAttributeId("Government Subsidy ($)");
        if (governmentSubsidyAttributeId) {
            updatevariables.push({
                data: governmentSubsidy,
                attribute_id: governmentSubsidyAttributeId
            });
        }
        const participantContributionAttributeId = getAttributeId("Participant Contribution ($)");
        if (participantContributionAttributeId) {
            updatevariables.push({
                data: participantContribution,
                attribute_id: participantContributionAttributeId
            });
        }

        if (updatevariables.length > 0) {
            const response = await axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`,
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
            const response = await axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${masterplanValuesWithAttributeId.find(v => v.attribute.name === "Service Plan").data.toString()}`,
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
    const { workspaceId, boardId } = req.params;
    const items = req.body.items[0];
    const itemId = items.id;
    const itemsValues = items.values;

    info('AgeCare-Service', `Incoming request to update variables participants service`, { workspaceId, boardId, itemId, itemsValues }, req ?? null);
    const result = await updateVariablesParticipantsService(workspaceId, boardId, itemId, itemsValues);
    if (result.error) {
        return res.status(200).json({ error: result.error });
    }
    res.status(200).json({ message: 'Variables participants service updated' });
});

router.post('/:workspaceId/:boardId/update-variables-masterplan', async (req, res) => {
    const { workspaceId, boardId } = req.params;
    const items = req.body.items[0];
    const itemId = items.id;
    const itemsValues = items.values;

    info('AgeCare-Service', `Incoming request to update variables MasterPlan`, { workspaceId, boardId, itemId, itemsValues }, req ?? null);
    const result = await updateVariablesMasterplan(workspaceId, boardId, itemId, itemsValues);

    if (result.error) {
        return res.status(200).json({ error: result.error });
    }
    res.status(200).json({ success: result.success, message: 'Variables MasterPlan updated' });
});

export default router;