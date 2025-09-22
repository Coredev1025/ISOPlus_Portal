import express from 'express';
import dotenv from 'dotenv';
import { info, warn, error } from '../utils/logger.js';
import { getItemValues, getAgeCareParticipantsServicePlanReferencedItems, setIntegrationMessage } from '../services/isoplus.js';
import axios from 'axios';

dotenv.config();
const router = express.Router();

const updateVariablesParticipantsService = async (workspaceId, boardId, itemId) => {
    const responseItemValues = await getItemValues(workspaceId, boardId, itemId);
    const itemValuesWithAttributeId = responseItemValues.values;

    let updatevariables = [];
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
                if (Number(homeSupportValues.unitPrice) > 0) {
                    updatevariables.push({
                        data: Number(homeSupportValues.unitPrice),
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                    });
                }
                if (Number(homeSupportValues.participantContributionGuideline) > 0) {
                    updatevariables.push({
                        data: Number(homeSupportValues.participantContributionGuideline),
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
                if (Number(assistiveTechnologyShortTermValues.unitPrice) > 0) {
                    updatevariables.push({
                        data: Number(assistiveTechnologyShortTermValues.unitPrice),
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                    });
                }
                if (Number(assistiveTechnologyShortTermValues.participantContributionGuideline) > 0) {
                    updatevariables.push({
                        data: Number(assistiveTechnologyShortTermValues.participantContributionGuideline),
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
        case '🦼 Assistive Technology (AT) - Ongoing': {
            if (assistiveTechnologyOngoingValues) {
                updatevariables.push({
                    data: assistiveTechnologyOngoingValues.unit,
                    attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Unit").attribute.id
                });
                if (Number(assistiveTechnologyOngoingValues.unitPrice) > 0) {
                    updatevariables.push({
                        data: Number(assistiveTechnologyOngoingValues.unitPrice),
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                    });
                }
                if (Number(assistiveTechnologyOngoingValues.participantContributionGuideline) > 0) {
                    updatevariables.push({
                        data: Number(assistiveTechnologyOngoingValues.participantContributionGuideline),
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Participant Contribution (%)").attribute.id
                    });
                }
                updatevariables.push({
                    data: homeSupportValues.service,
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
                if (Number(homeModificationValues.unitPrice) > 0) {
                    updatevariables.push({
                        data: Number(homeModificationValues.unitPrice),
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                    });
                }
                if (Number(homeModificationValues.participantContributionGuideline) > 0) {
                    updatevariables.push({
                        data: Number(homeModificationValues.participantContributionGuideline),
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
        case '🩺 AT Health Professional': { }
        case '🩺 HM Health Professional': {
            if (healthProfessionalValues) {
                updatevariables.push({
                    data: healthProfessionalValues.unit,
                    attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Unit").attribute.id
                });
                if (Number(healthProfessionalValues.unitPrice) > 0) {
                    updatevariables.push({
                        data: Number(healthProfessionalValues.unitPrice),
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                    });
                }
                if (Number(healthProfessionalValues.participantContributionGuideline) > 0) {
                    updatevariables.push({
                        data: Number(healthProfessionalValues.participantContributionGuideline),
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
        case '📌 AT Wraparound': { }
        case '📌 HM Wraparound': {
            if (wraparoundValues) {
                updatevariables.push({
                    data: wraparoundValues.unit,
                    attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Unit").attribute.id
                });
                if (Number(wraparoundValues.unitPrice) > 0) {
                    updatevariables.push({
                        data: Number(wraparoundValues.unitPrice),
                        attribute_id: itemValuesWithAttributeId.find(v => v.attribute.name === "Agreed Unit Price ($)").attribute.id
                    });
                }
                if (Number(wraparoundValues.participantContributionGuideline) > 0) {
                    updatevariables.push({
                        data: Number(wraparoundValues.participantContributionGuideline),
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
    }
    console.log("Update variables", updatevariables);
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
            return true;
        } else {
            setIntegrationMessage(workspaceId, boardId, itemId, "Failed to update variables participants service");
            warn('Xero-Service', 'Failed to update variables participants service', { updatevariables });
            return false;
        }
    } else {
        return true;
    }
}


router.post('/:workspaceId/:boardId/update-variables-participants-service', async (req, res) => {
    const { workspaceId, boardId } = req.params;
    const items = req.body.items[0];
    const itemId = items.id;
    const itemsValues = items.values;

    info('AgeCare-Service', `Incoming request to update variables participants service`, { workspaceId, boardId, itemId, itemsValues }, req);
    const result = await updateVariablesParticipantsService(workspaceId, boardId, itemId);
    if (result.error) {
        return res.status(200).json({ error: 'Failed to update variables participants service' });
    }
    res.status(200).json({ message: 'Variables participants service updated' });
});

export default router;