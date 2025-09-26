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

const updateVariablesParticipantsService = async (workspaceId, boardId, itemId, itemsValues) => {
    try {
        const responseItemValues = await getItemValues(workspaceId, boardId, itemId);
        const itemValuesWithAttributeId = responseItemValues.values;

        let updatevariables = [];
        await axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`,
            { values: [
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
                    const firstPercentageValue = parseFloat(homeSupportValues.participantContributionGuideline.split('-')[0]);
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
                    const firstPercentageValue = parseFloat(assistiveTechnologyShortTermValues.participantContributionGuideline.split('-')[0]);
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
                    const firstPercentageValue = parseFloat(assistiveTechnologyOngoingValues.participantContributionGuideline.split('-')[0]);
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
                    const firstPercentageValue = parseFloat(homeModificationValues.participantContributionGuideline.split('-')[0]);
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
                    const firstPercentageValue = parseFloat(healthProfessionalValues.participantContributionGuideline.split('-')[0]);
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
                    const firstPercentageValue = parseFloat(wraparoundValues.participantContributionGuideline.split('-')[0]);
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
                    const count = itemsValues["Home Support (HS)"].length + itemsValues["Assistive Technology (AT) - Short Term"].length + itemsValues["Assistive Technology (AT) - Ongoing"].length + itemsValues["Home Modification (HM)"].length + itemsValues["Health Professional"].length + itemsValues["Wraparound"].length;
                    if(count > 1) {
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
                setIntegrationMessage(workspaceId, boardId, itemId, "Variables participants service updated successfully");
                info('Xero-Service', 'Variables participants service updated successfully', { updatevariables });
                return { success: true };
            } else {
                setIntegrationMessage(workspaceId, boardId, itemId, "Failed to update variables participants service");
                warn('Xero-Service', 'Failed to update variables participants service', { updatevariables });
                return { error: 'Failed to update variables participants service' };
            }
        } else {
            return { success: true };
        }
    } catch {
        setIntegrationMessage(workspaceId, boardId, itemId, "While updating PartiService Plan variables, unknown error occur. Please contact ISO+ Portal Support team.")
        return { error: 'While updating PartiService Plan variables, unknown error occur. Please contact ISO+ Portal Support team.' };
    }
}

const updateVariablesMasterplan = async (workspaceId, boardId, itemId, itemsValues) => {
    try {
        const [servicePlanValues, cancellationTypeValues, participantProfileValues] = await getAgeCareMasterPlanReferencedItems(workspaceId, boardId, itemId);
        if (!servicePlanValues) {
            setIntegrationMessage(workspaceId, boardId, itemId, "Service Plan Item not found");
            return { error: 'Service Plan Item not found' };
        }

        let updatevariables = [];
        const responseItemValues = await getItemValues(workspaceId, boardId, itemId);
        const itemValuesWithAttributeId = responseItemValues.values;

        const actualDuration = formatValue(itemsValues["Actual Shift Duration(Hr.)"]);
        const scheduledDuration = formatValue(itemsValues["Scheduled Shift Duration(Hr.)"]);
        const quantityNonTimeBased = formatValue(itemsValues["Quantity (Non-Time-Based Service"]);
        const transactionStatus = itemsValues["Transaction Status"];
        let quantity = 0;

        if (transactionStatus?.includes('Adjustment (Refund)') || transactionStatus?.includes('Adjustment (Charge)')) {
            quantity = 0;
        } else {
            quantity = servicePlanValues.unit.includes('Hour') ? Number(actualDuration) : Number(quantityNonTimeBased);
        }

        let totalAmount = Number(formatValue(servicePlanValues.unitPrice * quantity));
        let participantContribution = Number(formatValue((servicePlanValues.participantContribution / 100) * servicePlanValues.unitPrice));
        let governmentSubsidy = Number(formatValue(totalAmount - participantContribution));

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
        if (servicePlanValues.unitPrice > 0) {
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
                setIntegrationMessage(workspaceId, boardId, itemId, "Variables MasterPlan updated successfully");
                info('Xero-Service', 'Variables MasterPlan updated successfully', { updatevariables });
                return { success: true };
            } else {
                setIntegrationMessage(workspaceId, boardId, itemId, "Failed to update variables MasterPlan");
                warn('Xero-Service', 'Failed to update variables MasterPlan', { updatevariables });
                return { error: 'Failed to update variables MasterPlan' };
            }
        }
    } catch {
        setIntegrationMessage(workspaceId, boardId, itemId, "While updating MasterPlan variables, unknown error occur. Please contact ISO+ Portal Support team.")
        return { error: 'While updating MasterPlan variables, unknown error occur. Please contact ISO+ Portal Support team.' };
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