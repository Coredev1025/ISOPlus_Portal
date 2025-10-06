import express from 'express';
import dotenv from 'dotenv';
import { info, warn, error } from '../utils/logger.js';
import { getItemValues, getAgeCareParticipantsServicePlanReferencedItems, setIntegrationMessage, getAgeCareMasterPlanReferencedItems } from '../services/isoplus.js';
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

const checkServiceClaimingConditions = async (workspaceId, boardId, itemId, itemsValues, servicePlanValues) => {
    try {
        const actualShiftEndDate = itemsValues['Actual Shift End Date'];
        const transactionStatus = itemsValues['Transaction Status'];
        const committedATHM = itemsValues['Committed AT-HM for Delivery'];
        const unit = servicePlanValues.unit;

        const isBlank = (value) => !value || value.toString().trim() === '';

        if (!isBlank(actualShiftEndDate) &&
            transactionStatus?.includes('Delivered - To be claimed and Invoiced')) {
            return { success: true };
        }

        if (isBlank(actualShiftEndDate) &&
            transactionStatus?.includes('Delivered - To be claimed and Invoiced')) {
            return { success: true };
        }

        if (isBlank(actualShiftEndDate) &&
            transactionStatus?.includes('Cancelled - To be claimed and Invoiced if applicable')) {
            return { success: true };
        }

        if (transactionStatus?.includes('Adjustment (Charge)') ||
            transactionStatus?.includes('Adjustment (Refund)')) {
            return { success: true };
        }

        if (committedATHM && isBlank(transactionStatus)) {
            return { success: true };
        }

        let errorMessage = 'ERROR: Invalid transaction status or missing required fields. ';

        if (transactionStatus?.includes('Delivered - To be claimed and Invoiced')) {
            if (!isBlank(actualShiftEndDate)) {
                errorMessage += 'For Delivered status with Actual Shift End Date: ';
                if (unit && unit.toLowerCase().includes('item')) {
                    errorMessage += 'Non-time-based item should ignore date and actual duration for quantity calculation.';
                } else {
                    errorMessage += 'Time-based item should use shift end date to calculate quantity.';
                }
            } else {
                errorMessage += 'For Delivered status without Actual Shift End Date: Non-time-based case requires quantity data.';
            }
        } else if (transactionStatus?.includes('Cancelled - To be claimed and Invoiced if applicable')) {
            errorMessage += 'For Cancelled status: Actual Shift End Date should be blank. Cancellation percentage should be applied.';
        } else if (!committedATHM || !isBlank(transactionStatus)) {
            errorMessage += 'For Committed AT-HM: Transaction Status should be blank. Item will be shown in Monthly Statement for Scheduled Start Date.';
        } else {
            errorMessage += 'Please ensure the transaction status and related fields are correctly filled according to the service claiming conditions.';
        }

        await setIntegrationMessage(workspaceId, boardId, itemId, errorMessage);
        return { success: false, error: errorMessage };
    } catch (error) {
        console.error('Error in checkServiceClaimingConditions:', error);
        await setIntegrationMessage(workspaceId, boardId, itemId,
            `An error occurred while checking service claiming conditions: ${error.message}. Please contact support.`);
        return { success: false, error: `An error occurred while checking service claiming conditions: ${error.message}. Please contact support.` };
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
                    // {
                    //     data: "",
                    //     attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Unit").attribute.id
                    // },
                    {
                        data: 0,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                    },
                    {
                        data: 0,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Participant Contribution (%)").attribute.id
                    },
                    // {
                    //     data: "",
                    //     attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Service Plan ID").attribute.id
                    // },
                    // {
                    //     data: [],
                    //     attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Configuration Status").attribute.id
                    // }
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
        switch (serviceCategory.attribute.settings.labels.find(l => l.id === serviceCategory.data.toString())?.name) {
            case '🧑‍⚕️ Home Support (HS)': {
                if (homeSupportValues) {
                    updatevariables.push({
                        data: homeSupportValues.unit,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Unit").attribute.id
                    });
                    if (Number(homeSupportValues.unitPrice) >= 0) {
                        updatevariables.push({
                            data: Number(homeSupportValues.unitPrice),
                            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                        });
                    }
                    const firstPercentageValue = homeSupportValues.participantContributionGuideline && homeSupportValues.participantContributionGuideline.includes('-')
                        ? parseFloat(homeSupportValues.participantContributionGuideline.split('-')[0])
                        : 0;
                    if (firstPercentageValue >= 0) {
                        updatevariables.push({
                            data: firstPercentageValue,
                            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Participant Contribution (%)").attribute.id
                        });
                    }
                    updatevariables.push({
                        data: fullName + homeSupportValues.service,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Service Plan ID").attribute.id
                    });
                }
                break;
            }
            case '🦽 Assistive Technology (AT) - Short-term': {
                if (assistiveTechnologyShortTermValues) {
                    updatevariables.push({
                        data: assistiveTechnologyShortTermValues.unit,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Unit").attribute.id
                    });
                    if (Number(assistiveTechnologyShortTermValues.unitPrice) >= 0) {
                        updatevariables.push({
                            data: Number(assistiveTechnologyShortTermValues.unitPrice),
                            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                        });
                    }
                    const firstPercentageValue = assistiveTechnologyShortTermValues.participantContributionGuideline && assistiveTechnologyShortTermValues.participantContributionGuideline.includes('-')
                        ? parseFloat(assistiveTechnologyShortTermValues.participantContributionGuideline.split('-')[0])
                        : 0;
                    if (firstPercentageValue >= 0) {
                        updatevariables.push({
                            data: firstPercentageValue,
                            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Participant Contribution (%)").attribute.id
                        });
                    }
                    let servicePlanId = '';
                    if (wraparoundValues && wraparoundValues.wraparoundDescription) {
                        servicePlanId = `${fullName}${wraparoundValues.wraparoundDescription} for ${assistiveTechnologyShortTermValues.service}`;
                    } else {
                        servicePlanId = fullName + assistiveTechnologyShortTermValues.service;
                    }
                    updatevariables.push({
                        data: servicePlanId,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Service Plan ID").attribute.id
                    });
                }
                break;
            }
            case '🦼 Assistive Technology (AT) - Ongoing': {
                if (assistiveTechnologyOngoingValues) {
                    updatevariables.push({
                        data: assistiveTechnologyOngoingValues.unit,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Unit").attribute.id
                    });
                    if (Number(assistiveTechnologyOngoingValues.unitPrice) >= 0) {
                        updatevariables.push({
                            data: Number(assistiveTechnologyOngoingValues.unitPrice),
                            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                        });
                    }
                    const firstPercentageValue = assistiveTechnologyOngoingValues.participantContributionGuideline && assistiveTechnologyOngoingValues.participantContributionGuideline.includes('-')
                        ? parseFloat(assistiveTechnologyOngoingValues.participantContributionGuideline.split('-')[0])
                        : 0;
                    if (firstPercentageValue >= 0) {
                        updatevariables.push({
                            data: firstPercentageValue,
                            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Participant Contribution (%)").attribute.id
                        });
                    }
                    let servicePlanId = '';
                    if (wraparoundValues && wraparoundValues.wraparoundDescription) {
                        servicePlanId = `${fullName}${wraparoundValues.wraparoundDescription} for ${assistiveTechnologyOngoingValues.service}`;
                    } else {
                        servicePlanId = fullName + assistiveTechnologyOngoingValues.service;
                    }
                    updatevariables.push({
                        data: servicePlanId,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Service Plan ID").attribute.id
                    });
                }
                break;
            }
            case '🛠️ Home Modification (HM)': {
                if (homeModificationValues) {
                    updatevariables.push({
                        data: homeModificationValues.unit,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Unit").attribute.id
                    });
                    if (Number(homeModificationValues.unitPrice) >= 0) {
                        updatevariables.push({
                            data: Number(homeModificationValues.unitPrice),
                            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                        });
                    }
                    const firstPercentageValue = homeModificationValues.participantContributionGuideline && homeModificationValues.participantContributionGuideline.includes('-')
                        ? parseFloat(homeModificationValues.participantContributionGuideline.split('-')[0])
                        : 0;
                    if (firstPercentageValue >= 0) {
                        updatevariables.push({
                            data: firstPercentageValue,
                            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Participant Contribution (%)").attribute.id
                        });
                    }
                    let servicePlanId = '';
                    if (wraparoundValues && wraparoundValues.wraparoundDescription) {
                        servicePlanId = `${fullName}${wraparoundValues.wraparoundDescription} for ${homeModificationValues.service}`;
                    } else {
                        servicePlanId = fullName + homeModificationValues.service;
                    }
                    updatevariables.push({
                        data: servicePlanId,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Service Plan ID").attribute.id
                    });
                }
                break;
            }
            case '🩺 AT Health Professional': { }
            case '🩺 HM Health Professional': {
                if (healthProfessionalValues) {
                    updatevariables.push({
                        data: healthProfessionalValues.unit,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Unit").attribute.id
                    });
                    if (Number(healthProfessionalValues.unitPrice) >= 0) {
                        updatevariables.push({
                            data: Number(healthProfessionalValues.unitPrice),
                            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                        });
                    }
                    const firstPercentageValue = healthProfessionalValues.participantContributionGuideline && healthProfessionalValues.participantContributionGuideline.includes('-')
                        ? parseFloat(healthProfessionalValues.participantContributionGuideline.split('-')[0])
                        : 0;
                    if (firstPercentageValue >= 0) {
                        updatevariables.push({
                            data: firstPercentageValue,
                            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Participant Contribution (%)").attribute.id
                        });
                    }
                    let servicePlanId = '';
                    if (wraparoundValues && wraparoundValues.wraparoundDescription) {
                        servicePlanId = `${fullName}${wraparoundValues.wraparoundDescription} for ${healthProfessionalValues.service}`;
                    } else {
                        servicePlanId = fullName + healthProfessionalValues.service;
                    }
                    updatevariables.push({
                        data: servicePlanId,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Service Plan ID").attribute.id
                    });
                }
                break;
            }
            case '📌 AT Wraparound': { }
            case '📌 HM Wraparound': {
                if (wraparoundValues) {
                    updatevariables.push({
                        data: wraparoundValues.unit,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Unit").attribute.id
                    });
                    if (Number(wraparoundValues.unitPrice) >= 0) {
                        updatevariables.push({
                            data: Number(wraparoundValues.unitPrice),
                            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                        });
                    }
                    const firstPercentageValue = wraparoundValues.participantContributionGuideline && wraparoundValues.participantContributionGuideline.includes('-')
                        ? parseFloat(wraparoundValues.participantContributionGuideline.split('-')[0])
                        : 0;
                    if (firstPercentageValue >= 0) {
                        updatevariables.push({
                            data: firstPercentageValue,
                            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Participant Contribution (%)").attribute.id
                        });
                    }
                    let servicePlanId = fullName + wraparoundValues.wraparoundDescription;

                    const companionService = assistiveTechnologyShortTermValues?.service ||
                        assistiveTechnologyOngoingValues?.service ||
                        homeModificationValues?.service ||
                        healthProfessionalValues?.service;

                    if (companionService) {
                        servicePlanId = `${fullName}${wraparoundValues.wraparoundDescription} for ${companionService}`;
                    }

                    updatevariables.push({
                        data: servicePlanId,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Service Plan ID").attribute.id
                    });
                }
                break;
            }
        }

        const statusAttribute = itemValuesWithAttributeId.find(v => v.attribute.name === "Configuration Status");
        const categoryAttribute = itemValuesWithAttributeId.find(v => v.attribute.name === "Service Category");
        const wraparoundAttribute = itemValuesWithAttributeId.find(v => v.attribute.name === "Wraparound Category");

        if (statusAttribute) {
            const categoryLabelId = categoryAttribute.data?.toString();
            const categoryLabelName = categoryAttribute.attribute.settings.labels.find(l => l.id === categoryLabelId)?.name || '';

            const wraparoundCategoryLabelId = wraparoundAttribute?.data?.toString();
            const wraparoundCategoryLabelName = wraparoundAttribute
                ? wraparoundAttribute.attribute.settings.labels.find(l => l.id === wraparoundCategoryLabelId)?.name || ''
                : '';

            const selectedMap = {
                homeSupport: !!homeSupportValues,
                assistiveTechnologyShortTerm: !!assistiveTechnologyShortTermValues,
                assistiveTechnologyOngoing: !!assistiveTechnologyOngoingValues,
                homeModification: !!homeModificationValues,
                healthProfessional: !!healthProfessionalValues,
                wraparound: !!wraparoundValues,
            };
            const selectedKeys = Object.keys(selectedMap).filter(k => selectedMap[k]);
            const selectedKeysExcludingWraparound = selectedKeys.filter(k => k !== 'wraparound');
            const selectedCount = selectedKeys.length - (selectedMap.wraparound ? 1 : 0);
            const selectedCountExcludingWraparound = selectedKeysExcludingWraparound.length;
            const countExcludingWraparound = (itemsValues["Home Support (HS)"]?.length || 0) +
                (itemsValues["Assistive Technology (AT) - Short Term"]?.length || 0) +
                (itemsValues["Assistive Technology (AT) - Ongoing"]?.length || 0) +
                (itemsValues["Home Modification (HM)"]?.length || 0) +
                (itemsValues["Health Professional"]?.length || 0);
            const countWraparound = (itemsValues["Wraparound"]?.length || 0);

            let expectedKey = '';
            if (categoryLabelName.includes('Home Support')) expectedKey = 'homeSupport';
            else if (categoryLabelName.includes('Short') || categoryLabelName.includes('Short-term')) expectedKey = 'assistiveTechnologyShortTerm';
            else if (categoryLabelName.includes('Ongoing')) expectedKey = 'assistiveTechnologyOngoing';
            else if (categoryLabelName.includes('Home Modification')) expectedKey = 'homeModification';
            else if (categoryLabelName.includes('Health Professional')) expectedKey = 'healthProfessional';
            else if (categoryLabelName.includes('Wraparound')) expectedKey = 'wraparound';

            let statusColor = '';
            let integrationMsg = '';

            if (selectedMap.wraparound && selectedCountExcludingWraparound === 0 && !selectedMap.homeSupport) {
                statusColor = '#08B7AB';
                integrationMsg = 'Error: Wraparound cannot be chosen as a Standalone Service. Please select a service category (except Home Support).';
            }
            else if (selectedMap.wraparound && wraparoundCategoryLabelName) {
                let wraparoundPrefix = '';
                if (typeof wraparoundCategoryLabelName === 'string') {
                    if (wraparoundCategoryLabelName.includes('AT')) {
                        wraparoundPrefix = 'AT';
                    } else if (wraparoundCategoryLabelName.includes('HM')) {
                        wraparoundPrefix = 'HM';
                    }
                }
                let wraparoundDescPrefix = '';
                if (wraparoundValues?.wraparoundDescription && typeof wraparoundValues.wraparoundDescription === 'string') {
                    if (wraparoundValues.wraparoundDescription.includes('AT')) {
                        wraparoundDescPrefix = 'AT';
                    } else if (wraparoundValues.wraparoundDescription.includes('HM')) {
                        wraparoundDescPrefix = 'HM';
                    }
                }

                if (wraparoundPrefix !== wraparoundDescPrefix) {
                    statusColor = '#D99C05';
                    integrationMsg = 'Error: Misalignment of Wraparound Category. The starting letters of the selected Wraparound do not match the Wraparound Category.';
                }
            }
            if (!statusColor && selectedMap.homeSupport && selectedMap.wraparound) {
                statusColor = '#6D30EA';
                integrationMsg = 'Error: Misalignment of Service and Wraparound Category. Wraparound should not be chosen for Home Support (HS).';
            }
            if (!statusColor && selectedMap.wraparound && wraparoundCategoryLabelName) {
                const hasATService = selectedMap.assistiveTechnologyShortTerm ||
                    selectedMap.assistiveTechnologyOngoing ||
                    (selectedMap.healthProfessional && categoryLabelName.includes('AT'));
                const hasHMService = selectedMap.homeModification ||
                    (selectedMap.healthProfessional && categoryLabelName.includes('HM'));

                const isHMWraparound = wraparoundCategoryLabelName.includes('HM');
                const isATWraparound = wraparoundCategoryLabelName.includes('AT');

                if (hasATService && isHMWraparound) {
                    statusColor = '#6D30EA';
                    integrationMsg = 'Error: Misalignment of Service and Wraparound Category. HM Wraparound cannot be selected with AT service categories.';
                } else if (hasHMService && isATWraparound) {
                    statusColor = '#6D30EA';
                    integrationMsg = 'Error: Misalignment of Service and Wraparound Category. AT Wraparound cannot be selected with HM service categories.';
                }
            }
            if (!statusColor && selectedMap.homeModification && selectedMap.wraparound) {
                statusColor = '#3578D1';
                integrationMsg = 'Error: Wraparound is NOT Applicable. Both Home Modification (HM) and Wraparound Attributes cannot be selected together.';
            }
            if (!statusColor) {
                if (countExcludingWraparound > 1 || countWraparound > 1) {
                    statusColor = '#F665E2';
                    integrationMsg = 'Error: Multiple Services within a Group. Please select only one service per column.';
                }
            }
            if (!statusColor && selectedCountExcludingWraparound > 1) {
                statusColor = '#EE691E';
                integrationMsg = 'Error: Multiple Service Groups. Please select only one service group (Wraparound can be combined with other categories except Home Support).';
            }
            if (!statusColor && selectedCountExcludingWraparound === 1) {
                const selectedKey = selectedKeysExcludingWraparound[0];
                if (expectedKey && expectedKey !== 'wraparound' && selectedKey !== expectedKey) {
                    statusColor = '#C60909';
                    integrationMsg = 'Error: Misalignment of Service Category. The selected service does not match the assigned service category.';
                }
            }
            if (!statusColor && selectedCount >= 1) {
                statusColor = '#388903';
                integrationMsg = 'Aligned and Correct Selection.';
            }

            if (statusColor) {
                updatevariables.push({
                    data: [statusAttribute.attribute.settings.labels.find(l => l.color === statusColor).id || ''],
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
    } catch (error) {
        console.error('Error in updateVariablesParticipantsService:', error);
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

        const actualDuration = formatValue(itemsValues["Actual Shift Duration(Hr.)"] || 0);
        const scheduledDuration = formatValue(itemsValues["Scheduled Shift Duration(Hr.)"] || 0);
        const quantityNonTimeBased = formatValue(itemsValues["Quantity (Non-Time-Based Service)"] || 0);
        const transactionStatus = itemsValues["Transaction Status"];
        let quantity = 0;

        if (transactionStatus?.includes('Adjustment (Refund)') || transactionStatus?.includes('Adjustment (Charge)')) {
            quantity = 0;
        } else {
            if (transactionStatus?.includes('Cancelled')) {
                quantity = servicePlanValues.unit.includes('Hour') ? Number(scheduledDuration) : Number(quantityNonTimeBased);
            } else {
                quantity = servicePlanValues.unit.includes('Hour') ? Number(actualDuration) : Number(quantityNonTimeBased);
            }
        }

        let totalAmount = 0;
        if (transactionStatus?.includes('Cancelled')) {
            if (cancellationTypeValues?.billableToClient) {
                totalAmount = Number(formatValue(servicePlanValues.unitPrice * quantity * (cancellationTypeValues.billableToClient / 100)));
            } else {
                await setIntegrationMessage(workspaceId, boardId, itemId, "Cancellation Type item not found.");
                return { error: 'Cancellation Type item not found.' };
            }
        } else {
            totalAmount = Number(formatValue(servicePlanValues.unitPrice * quantity));
        }
        let participantContribution = Number(formatValue((servicePlanValues.participantContribution / 100) * totalAmount));
        let governmentSubsidy = Number(formatValue(totalAmount - participantContribution));
        const checkServiceClaimingConditionsResult = await checkServiceClaimingConditions(workspaceId, boardId, itemId, itemsValues, servicePlanValues);
        if (checkServiceClaimingConditionsResult.success === false) {
            return { error: checkServiceClaimingConditionsResult.error };
        }

        if (servicePlanValues.unit != ' ' && servicePlanValues.unit != null && servicePlanValues.unit != undefined) {
            updatevariables.push({
                data: servicePlanValues.unit,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Unit").attribute.id
            });
        }
        if (quantity >= 0) {
            updatevariables.push({
                data: quantity,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Quantity").attribute.id
            });
        }
        if (servicePlanValues.unitPrice >= 0) {
            updatevariables.push({
                data: servicePlanValues.unitPrice,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Unit Price ($)").attribute.id
            });
        }
        updatevariables.push({
            data: totalAmount,
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Total Amount ($)").attribute.id
        });
        updatevariables.push({
            data: governmentSubsidy,
            attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Government Subsidy ($)").attribute.id
        });
        if (participantContribution > 0) {
            updatevariables.push({
                data: participantContribution,
                attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Participant Contribution ($)").attribute.id
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
    } catch (error) {
        console.error('Error in updateVariablesMasterplan:', error);
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

        console.log('itemValuesWithAttributeId', itemValuesWithAttributeId);
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
    } catch (error) {
        console.error('Error in updateParticipantsServiceplan:', error);
        return { error: 'While updating Participants ServicePlan, an unknown error occurred. Please contact ISO+ Portal Support team.' };
    }
}

router.post('/:workspaceId/:boardId/update-variables-participants-service', async (req, res) => {
    const { workspaceId, boardId } = req.params;
    const items = req.body.items[0];
    const itemId = items.id;
    const itemsValues = items.values;

    info('AgeCare-Service', `Incoming request to update variables participants service`, { workspaceId, boardId, itemId, itemsValues }, req);
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

    info('AgeCare-Service', `Incoming request to update variables MasterPlan`, { workspaceId, boardId, itemId, itemsValues }, req);
    const result = await updateVariablesMasterplan(workspaceId, boardId, itemId, itemsValues);

    if (result.error) {
        return res.status(200).json({ error: result.error });
    }
    res.status(200).json({ success: result.success, message: 'Variables MasterPlan updated' });
});

export default router;