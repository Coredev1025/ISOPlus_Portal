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
            if (unit && unit.toLowerCase().includes('item')) {
                await setIntegrationMessage(workspaceId, boardId, itemId,
                    "Normal case - Service will be claimed and invoiced in the month of actual end date. " +
                    "Non-time-based item: Ignore date and actual duration for quantity calculation.");
            } else {
                await setIntegrationMessage(workspaceId, boardId, itemId,
                    "Normal case - Service will be claimed and invoiced in the month of actual end date. " +
                    "Time-based item: Use shift end date to calculate quantity.");
            }
            return { success: true };
        }

        if (isBlank(actualShiftEndDate) &&
            transactionStatus?.includes('Delivered - To be claimed and Invoiced')) {
            await setIntegrationMessage(workspaceId, boardId, itemId,
                "Non-time-based case - Service will be claimed and invoiced based on quantity. " +
                "Actual start and end dates not required for calculation.");
            return { success: true };
        }

        if (isBlank(actualShiftEndDate) &&
            transactionStatus?.includes('Cancelled - To be claimed and Invoiced if applicable')) {
            await setIntegrationMessage(workspaceId, boardId, itemId,
                "Cancelled service - Will be claimed and invoiced in the month of actual end date. " +
                "Cancellation percentage will be applied and included in description.");
            return { success: true };
        }

        if (transactionStatus?.includes('Adjustment (Charge)') ||
            transactionStatus?.includes('Adjustment (Refund)')) {
            const adjustmentType = transactionStatus.includes('Charge') ? 'Charge' : 'Refund';
            const amountNote = adjustmentType === 'Refund' ?
                " Total Amount Charged, Government Subsidy and Participant Contribution will be negative." : "";

            await setIntegrationMessage(workspaceId, boardId, itemId,
                `Adjustment (${adjustmentType}) - Unit, Quantity, Unit Price, Total Price, ` +
                `Government Contribution and Participant Contribution will be added manually.${amountNote}`);
            return { success: true };
        }

        if (committedATHM && isBlank(transactionStatus)) {
            const quantityNote = unit && unit.toLowerCase().includes('time') ?
                "Duration will be considered as 'Scheduled Duration' for quantity." :
                "Quantity will be 'Quantity (Non-Time-Based Service)'.";

            await setIntegrationMessage(workspaceId, boardId, itemId,
                "Committed AT-HM for Delivery - Not considered for claiming and invoicing, " +
                "but will be shown in Monthly Statement and Individualised Plan for the month of Scheduled Start Date. " +
                quantityNote + " " +
                "Committed items will be claimed and invoiced once delivered or cancelled.");
            return { success: true };
        }
        return { success: true };
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
        switch (serviceCategory.attribute.settings.labels.find(l => l.id === serviceCategory.data.toString()).name) {
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
                    updatevariables.push({
                        data: fullName + assistiveTechnologyShortTermValues.service,
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
                    updatevariables.push({
                        data: assistiveTechnologyOngoingValues.service,
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
                    updatevariables.push({
                        data: fullName + homeModificationValues.service,
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
                    updatevariables.push({
                        data: fullName + healthProfessionalValues.service,
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
                    updatevariables.push({
                        data: fullName + wraparoundValues.wraparoundDescription,
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Service Plan ID").attribute.id
                    });
                }
                break;
            }
        }

        const statusAttribute = itemValuesWithAttributeId.find(v => v.attribute.name === "Configuration Status");
        const categoryAttribute = itemValuesWithAttributeId.find(v => v.attribute.name === "Service Category");
        if (statusAttribute && categoryAttribute) {
            const categoryLabelId = categoryAttribute.data?.toString();
            const categoryLabelName = categoryAttribute.attribute.settings.labels.find(l => l.id === categoryLabelId)?.name || '';

            const selectedMap = {
                homeSupport: !!homeSupportValues,
                assistiveTechnologyShortTerm: !!assistiveTechnologyShortTermValues,
                assistiveTechnologyOngoing: !!assistiveTechnologyOngoingValues,
                homeModification: !!homeModificationValues,
                healthProfessional: !!healthProfessionalValues,
                wraparound: !!wraparoundValues,
            };
            const selectedKeys = Object.keys(selectedMap).filter(k => selectedMap[k]);
            const selectedCount = selectedKeys.length;

            let expectedKey = '';
            if (categoryLabelName.includes('Home Support')) expectedKey = 'homeSupport';
            else if (categoryLabelName.includes('Short') || categoryLabelName.includes('Short-term')) expectedKey = 'assistiveTechnologyShortTerm';
            else if (categoryLabelName.includes('Ongoing')) expectedKey = 'assistiveTechnologyOngoing';
            else if (categoryLabelName.includes('Home Modification')) expectedKey = 'homeModification';
            else if (categoryLabelName.includes('Health Professional')) expectedKey = 'healthProfessional';
            else if (categoryLabelName.includes('Wraparound')) expectedKey = 'wraparound';

            let statusColor = '';
            let integrationMsg = '';
            if (selectedCount > 1) {
                statusColor = '#EE691E';
                integrationMsg = 'Multiple Groups selected. Please select only one Group per row.';
            } else if (selectedCount === 1) {
                const selectedKey = selectedKeys[0];
                if (expectedKey && selectedKey !== expectedKey) {
                    statusColor = '#C60909';
                    integrationMsg = 'Selected service does not match the assigned Service Category.';
                } else {
                    const count = (itemsValues["Home Support (HS)"]?.length || 0) + 
                                  (itemsValues["Assistive Technology (AT) - Short Term"]?.length || 0) + 
                                  (itemsValues["Assistive Technology (AT) - Ongoing"]?.length || 0) + 
                                  (itemsValues["Home Modification (HM)"]?.length || 0) + 
                                  (itemsValues["Health Professional"]?.length || 0) + 
                                  (itemsValues["Wraparound"]?.length || 0);
                    if (count > 1) {
                        statusColor = '#F665E2';
                        integrationMsg = 'Multiple services selected. Please select only one service type per group.';
                    } else if (count == 1) {
                        statusColor = '#388903';
                    }
                }
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
                await setIntegrationMessage(workspaceId, boardId, itemId, "Participants Service Plan Variables updated successfully.");
                info('Xero-Service', 'Participants Service Plan Variables updated successfully.', { updatevariables });
                return { success: true };
            } else {
                await setIntegrationMessage(workspaceId, boardId, itemId, "Failed to update Participants Service Plan Variables.");
                warn('Xero-Service', 'Failed to update Participants Service Plan Variables.', { updatevariables });
                return { error: 'Failed to update Participants Service Plan Variables.' };
            }
        } else {
            return { success: true };
        }
    } catch (error) {
        console.error('Error in updateVariablesParticipantsService:', error);
        await setIntegrationMessage(workspaceId, boardId, itemId, "While updating Participants Service Plan Variables, an unknown error occurred. Please contact ISO+ Portal Support team.");
        return { error: 'While updating Participants Service Plan Variables, an unknown error occurred. Please contact ISO+ Portal Support team.' };
    }
}

const updateVariablesMasterplan = async (workspaceId, boardId, itemId, itemsValues) => {
    try {
        const [servicePlanValues, cancellationTypeValues, participantProfileValues] = await getAgeCareMasterPlanReferencedItems(workspaceId, boardId, itemId);
        if (!servicePlanValues) {
            await setIntegrationMessage(workspaceId, boardId, itemId, "Service Plan Item not found.");
            return { error: 'Service Plan Item not found.' };
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
                await setIntegrationMessage(workspaceId, boardId, itemId, "Cancellation Type Item not found.");
                return { error: 'Cancellation Type Item not found.' };
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
                await setIntegrationMessage(workspaceId, boardId, itemId, "Master Plan Variables updated successfully.");
                info('Xero-Service', 'Master Plan Variables updated successfully.', { updatevariables });
                return { success: true };
            } else {
                await setIntegrationMessage(workspaceId, boardId, itemId, "Failed to update Master Plan Variables.");
                warn('Xero-Service', 'Failed to update Master Plan Variables.', { updatevariables });
                return { error: 'Failed to update Master Plan Variables.' };
            }
        } else {
            return { success: true };
        }
    } catch (error) {
        console.error('Error in updateVariablesMasterplan:', error);
        await setIntegrationMessage(workspaceId, boardId, itemId, "While updating Master Plan Variables, an unknown error occurred. Please contact ISO+ Portal Support team.");
        return { error: 'While updating Master Plan Variables, an unknown error occurred. Please contact ISO+ Portal Support team.' };
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