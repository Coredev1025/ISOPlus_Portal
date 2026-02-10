import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Item from '../models/Item.js';
import InvoiceNumber from '../models/InvoiceNumber.js';
import Business from '../models/Business.js';
import { info, error, warn, extractContextFromReq } from '../utils/logger.js';
import { getFolder } from '../services/isoplus.js';

const router = express.Router();

const ATTRIBUTE_NAMES = {
    SCHEDULED_START: 'Scheduled Shift Start Date & Time',
    ACTUAL_START: 'Actual Shift Start Date & Time',
    ACTUAL_END: 'Actual Shift End Date & Time',
    PARTICIPANT_FULL_NAME: 'Participant Full Name',
    PARTICIPANT_PROFILE: 'Participant Profile',
    SERVICE_PLAN: 'Service Plan',
    SERVICE_PLAN_ID: 'Service Plan ID',
    UNIT: 'Unit',
    QUANTITY: 'Quantity',
    UNIT_PRICE: 'Unit Price ($)',
    TOTAL_AMOUNT: 'Total Amount ($)',
    GOV_SUBSIDY: 'Government Subsidy ($)',
    PARTICIPANT_CONTRIBUTION: 'Participant Contribution ($)',
    ADDITIONAL_NOTES: 'Additional Notes',
    TRANSACTION_STATUS: 'Transaction Status',
    FUNDING_SOURCE: 'Funding Source',
    PAYMENT_STATUS: 'Payment Status',
    DELIVERED_BY: 'Delivered by',
    MY_AGED_CARE_ID: 'My Aged Care ID Number',
    MY_AGED_CARE_ID_ALT: 'My Aged Care ID',
    FULL_NAME: 'Full Name/Preferred Name',
    ITEM_OR_WRAPAROUND: 'Item or Wraparound',
    ITEM_DESCRIPTION_CODE: 'Item Description Code',
    ITEM_DESCRIPTION: 'Item Description',
    WRAPAROUND_DESCRIPTION_CODE: 'Wraparound Description Code',
    WRAPAROUND_DESCRIPTION: 'Wraparound Description',
    HEALTH_PROFESSIONAL_TYPE_CODE: 'Health Professional Type Code',
    HEALTH_PROFESSIONAL_TYPE_OTHER: 'Health Professional Type Other',
    SERVICE_ID_ITEM_ID: 'Service ID /  Item ID',
    ASSOCIATED_PROVIDER: 'Associated Provider (If Applicable)',
    COMMITTED_AT_HM: 'Committed AT-HM for Delivery'
};

const getFolderIds = async (folderName, workspaceId, boardId, providedFolders = null) => {
    let folders = providedFolders;
    if (!Array.isArray(folders)) {
        try {
            const { folder } = await getFolder(workspaceId, boardId);
            folders = folder || [];
        } catch (err) {
            return [];
        }
    }

    const folderNames = folderName.toLowerCase().split(',').map(n => n.trim());
    return folders
        .filter(f => f.name && folderNames.some(name => f.name.toLowerCase().includes(name)))
        .map(f => f.id);
};

const parseNumber = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
        const normalized = value.replace(/[^0-9.-]/g, '');
        const parsed = parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
};

const parseDate = (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) {
        return isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === 'string' || typeof value === 'number') {
        const date = new Date(value);
        return isNaN(date.getTime()) ? null : date;
    }
    return null;
};

const isUuidLike = (value) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const getReferenceDisplayName = (refItem) => {
    if (!refItem || !refItem.data) return '';
    const fundingStream = refItem.data['Funding Stream'];
    if (fundingStream) {
        if (typeof fundingStream === 'object' && fundingStream.name) return fundingStream.name;
        return String(fundingStream);
    }
    const definition = refItem.data['Definition'];
    if (definition) {
        if (typeof definition === 'object' && definition.name) return definition.name;
        return String(definition);
    }
    const fullName = refItem.data['Full Name/Preferred Name'];
    if (fullName) {
        if (typeof fullName === 'object' && fullName.name) return fullName.name;
        return String(fullName);
    }
    const name = refItem.data['Name'];
    if (name) {
        if (typeof name === 'object' && name.name) return name.name;
        return String(name);
    }
    return '';
};

const resolveReferenceValue = (value, refMap) => {
    if (!value) return '';
    if (Array.isArray(value)) {
        return value.map(v => resolveReferenceValue(v, refMap)).filter(Boolean).join(', ');
    }
    if (typeof value === 'object') {
        if (value.name) return value.name;
        if (value.id) return resolveReferenceValue(value.id, refMap);
        return value.toString ? value.toString() : '';
    }
    const valueStr = String(value);
    if (isUuidLike(valueStr) && refMap?.has(valueStr)) {
        return getReferenceDisplayName(refMap.get(valueStr)) || valueStr;
    }
    return valueStr;
};

const formatStatus = (value) => {
    if (!value) return undefined;
    if (Array.isArray(value) && value.length > 0) {
        return value.map(item => {
            if (typeof item === 'object' && item.name) return item.name;
            return String(item);
        }).filter(Boolean).join(', ');
    }
    if (typeof value === 'object' && value.name) return value.name;
    if (typeof value === 'string') return value;
    return String(value);
};

// Match items.js: use Actual End for date filter only when status is "Delivered - To be claimed and invoiced."
const TRANSACTION_STATUS_USE_ACTUAL_END = 'Delivered - To be claimed and invoiced.';
const normalizeString = (value) => (value || '').toString().trim().toLowerCase().replace(/\.+$/, '');

const getValue = (item, attributeName) => {
    if (!item?.data) return null;
    return item.data[attributeName] ?? null;
};

const extractRefId = (value) => {
    if (!value) return null;
    if (Array.isArray(value) && value.length > 0) {
        const first = value[0];
        if (typeof first === 'object' && first.id) return first.id.toString();
        if (typeof first === 'string') return first;
        return first?.toString();
    }
    if (typeof value === 'object' && value.id) return value.id.toString();
    if (typeof value === 'string') return value;
    return value?.toString();
};

const extractAllRefIds = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.map(v => {
            if (typeof v === 'object' && v.id) return v.id.toString();
            if (typeof v === 'string') return v;
            return v?.toString();
        }).filter(Boolean);
    }
    if (typeof value === 'object' && value.id) return [value.id.toString()];
    if (typeof value === 'string') return [value];
    return value ? [value.toString()] : [];
};

const REF_ATTR = {
    // Participant Profile attributes
    PROFILE_FULL_NAME: 'Full Name/Preferred Name',
    PROFILE_PREFERRED_NAME: 'Preferred Name',
    PROFILE_MY_AGED_CARE_ID: 'My Aged Care ID Number',
    PROFILE_MY_AGED_CARE_ID_ALT: 'My Aged Care ID',

    // Service Plan attributes
    SERVICE_PLAN_ID: 'Service Plan ID',
    SERVICE_ID_ITEM_ID: 'Service ID/  Item ID',
    SERVICE_ID_ITEM_ID_ALT: 'Service ID/Item ID',

    // Funding Source attributes
    FS_NAME: 'Funding Stream',
    FS_DEFINITION: 'Definition'
};

const bulkFetchItemsFromDB = async (workspaceId, boardId, itemIds) => {
    if (!itemIds || itemIds.length === 0) return new Map();

    const uniqueIds = [...new Set(itemIds.filter(Boolean))];
    if (uniqueIds.length === 0) return new Map();

    let items = await Item.find({
        workspaceId,
        boardId,
        itemId: { $in: uniqueIds }
    }).lean();

    const itemMap = new Map();
    for (const item of items) {
        itemMap.set(item.itemId, item);
    }

    const foundIds = new Set(items.map(i => i.itemId));
    const missingIds = uniqueIds.filter(id => !foundIds.has(id));

    if (missingIds.length > 0) {
        const crossBoardItems = await Item.find({
            workspaceId,
            itemId: { $in: missingIds }
        }).lean();

        for (const item of crossBoardItems) {
            if (!itemMap.has(item.itemId)) {
                itemMap.set(item.itemId, item);
            }
        }

        const stillMissingIds = missingIds.filter(id => !itemMap.has(id));
        if (stillMissingIds.length > 0) {
            warn('Export-Service', 'Reference items not found in database', {
                missingCount: stillMissingIds.length,
                sampleMissingIds: stillMissingIds.slice(0, 3)
            });
        }
    }

    info('Export-Service', 'Bulk fetch reference items', {
        requested: uniqueIds.length,
        found: itemMap.size
    });

    return itemMap;
};

const getValueMulti = (item, attributeNames) => {
    if (!item?.data) return null;
    const names = Array.isArray(attributeNames) ? attributeNames : [attributeNames];
    for (const name of names) {
        if (item.data[name] !== undefined && item.data[name] !== null) {
            return item.data[name];
        }
    }
    return null;
};

const getParticipantNameFromProfile = (profileItem) => {
    if (!profileItem) return null;
    const name = getValueMulti(profileItem, [
        REF_ATTR.PROFILE_PREFERRED_NAME,
        REF_ATTR.PROFILE_FULL_NAME,
        'Full Name',
        'Preferred Name',
        'Name'
    ]);
    if (!name) return null;
    if (typeof name === 'object' && name !== null) {
        return name.name ? String(name.name) : String(name);
    }
    return String(name);
};

const getMyAgedCareIdFromProfile = (profileItem) => {
    if (!profileItem) return null;
    const id = getValueMulti(profileItem, [
        REF_ATTR.PROFILE_MY_AGED_CARE_ID,
        REF_ATTR.PROFILE_MY_AGED_CARE_ID_ALT
    ]);
    if (!id) return null;
    return String(id);
};

const getServiceFromServicePlan = (servicePlanItem) => {
    if (!servicePlanItem) return null;
    const servicePlanIdValue = getValueMulti(servicePlanItem, [
        REF_ATTR.SERVICE_PLAN_ID,
        ATTRIBUTE_NAMES.SERVICE_PLAN_ID
    ]);
    if (!servicePlanIdValue) return null;

    const servicePlanIdStr = String(servicePlanIdValue).trim();
    if (servicePlanIdStr.includes('-')) {
        const parts = servicePlanIdStr.split('-');
        return parts.length >= 2 ? parts.slice(1).join('-').trim() : servicePlanIdStr;
    }
    return servicePlanIdStr;
};

const getServiceIdentifierFromServicePlan = (servicePlanItem, refItemsMap) => {
    if (!servicePlanItem) return null;

    const idAttrs = [
        REF_ATTR.SERVICE_ID_ITEM_ID,
        REF_ATTR.SERVICE_ID_ITEM_ID_ALT,
        ATTRIBUTE_NAMES.SERVICE_ID_ITEM_ID,
        'Service ID /  Item ID',
        'Service ID/Item ID'
    ];

    const serviceId = getValueMulti(servicePlanItem, idAttrs);
    if (serviceId) {
        let idStr = String(serviceId);
        if (idStr.includes('/')) {
            idStr = idStr.split('/')[0].trim();
        }
        return idStr;
    }

    if (refItemsMap) {
        const serviceRefAttrs = [
            'Home Support (HS)',
            'Assistive Technology (AT) - Short Term',
            'Assistive Technology (AT) - Ongoing',
            'Home Modification (HM)',
            'Health Professional'
        ];

        for (const refAttr of serviceRefAttrs) {
            const refValue = getValue(servicePlanItem, refAttr);
            const refId = extractRefId(refValue);
            if (refId) {
                const refItem = refItemsMap.get(refId);
                if (refItem) {
                    const refServiceId = getValueMulti(refItem, idAttrs);
                    if (refServiceId) {
                        let idStr = String(refServiceId);
                        if (idStr.includes('/')) {
                            idStr = idStr.split('/')[0].trim();
                        }
                        return idStr;
                    }
                }
            }
        }
    }

    return null;
};

const getItemDescriptionFromServicePlan = (servicePlanItem, refItemsMap) => {
    if (!servicePlanItem) return { code: '', description: '' };

    const codeAttrs = [
        ATTRIBUTE_NAMES.ITEM_DESCRIPTION_CODE,
        'Item ID',
        'Item Description Code'
    ];
    const descAttrs = [
        ATTRIBUTE_NAMES.ITEM_DESCRIPTION,
        'Item',
        'Item Description'
    ];

    const directCode = getValueMulti(servicePlanItem, codeAttrs);
    const directDesc = getValueMulti(servicePlanItem, descAttrs);

    if (directCode || directDesc) {
        return {
            code: directCode || '',
            description: directDesc || ''
        };
    }

    if (refItemsMap) {
        const serviceRefAttrs = [
            'Home Support (HS)',
            'Assistive Technology (AT) - Short Term',
            'Assistive Technology (AT) - Ongoing',
            'Home Modification (HM)',
            'Health Professional'
        ];

        for (const refAttr of serviceRefAttrs) {
            const refValue = getValue(servicePlanItem, refAttr);
            const refId = extractRefId(refValue);
            if (refId) {
                const refItem = refItemsMap.get(refId);
                if (refItem) {
                    const refCode = getValueMulti(refItem, codeAttrs);
                    const refDesc = getValueMulti(refItem, descAttrs);
                    if (refCode || refDesc) {
                        return {
                            code: refCode || '',
                            description: refDesc || ''
                        };
                    }
                }
            }
        }
    }

    return { code: '', description: '' };
};

const getWraparoundDescriptionFromServicePlan = (servicePlanItem, refItemsMap) => {
    if (!servicePlanItem) return { code: '', description: '' };

    const codeAttrs = [
        ATTRIBUTE_NAMES.WRAPAROUND_DESCRIPTION_CODE,
        'Wraparound Item ID',
        'Wraparound Description Code'
    ];
    const descAttrs = [
        ATTRIBUTE_NAMES.WRAPAROUND_DESCRIPTION,
        'Wraparound Description'
    ];

    const directCode = getValueMulti(servicePlanItem, codeAttrs);
    const directDesc = getValueMulti(servicePlanItem, descAttrs);

    if (directCode || directDesc) {
        return {
            code: directCode || '',
            description: directDesc || ''
        };
    }

    if (refItemsMap) {
        const wraparoundRefValue = getValue(servicePlanItem, 'Wraparound');
        const wraparoundRefId = extractRefId(wraparoundRefValue);

        if (wraparoundRefId) {
            const wraparoundItem = refItemsMap.get(wraparoundRefId);
            if (wraparoundItem) {
                const refCode = getValueMulti(wraparoundItem, codeAttrs);
                const refDesc = getValueMulti(wraparoundItem, descAttrs);
                return {
                    code: refCode || '',
                    description: refDesc || ''
                };
            }
        }
    }

    return { code: '', description: '' };
};

const getHealthProfessionalFromServicePlan = (servicePlanItem, refItemsMap) => {
    if (!servicePlanItem) return { typeCode: '', typeOther: '' };

    const typeCodeAttrs = [
        ATTRIBUTE_NAMES.HEALTH_PROFESSIONAL_TYPE_CODE,
        'Health Professional Type Code'
    ];
    const typeOtherAttrs = [
        ATTRIBUTE_NAMES.HEALTH_PROFESSIONAL_TYPE_OTHER,
        'Health Professional Type'
    ];

    let typeCode = getValueMulti(servicePlanItem, typeCodeAttrs) || '';
    let typeOther = getValueMulti(servicePlanItem, typeOtherAttrs) || '';

    if (typeCode || typeOther) {
        if (typeOther) {
            const typeOtherStr = String(typeOther);
            if (typeOtherStr.includes(' - Other')) {
                typeOther = typeOtherStr.split(' - Other')[0];
            }
        }
        return { typeCode, typeOther };
    }

    if (refItemsMap) {
        const healthProfRefValue = getValue(servicePlanItem, 'Health Professional');
        const healthProfRefId = extractRefId(healthProfRefValue);

        if (healthProfRefId) {
            const healthProfItem = refItemsMap.get(healthProfRefId);
            if (healthProfItem) {
                typeCode = getValueMulti(healthProfItem, typeCodeAttrs) || '';
                typeOther = getValueMulti(healthProfItem, typeOtherAttrs) || '';

                if (typeOther) {
                    const typeOtherStr = String(typeOther);
                    if (typeOtherStr.includes(' - Other')) {
                        typeOther = typeOtherStr.split(' - Other')[0];
                    }
                }
                return { typeCode, typeOther };
            }
        }
    }

    return { typeCode: '', typeOther: '' };
};

const stripEmojiFromFundingSource = (str) => (str || '').replace(/[\u{1F300}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();

const getFundingSourceNameFromItem = (fsItem) => {
    if (!fsItem) return null;
    const name = getValueMulti(fsItem, [
        REF_ATTR.FS_NAME,
        REF_ATTR.FS_TITLE,
        REF_ATTR.FS_FUNDING_SOURCE_NAME,
        REF_ATTR.FS_FULL_NAME,
        ATTRIBUTE_NAMES.FULL_NAME
    ]);
    if (!name) return null;

    let raw;
    if (typeof name === 'object' && name !== null) {
        raw = name.name ? String(name.name).trim() : String(name).trim();
    } else {
        raw = String(name).trim();
    }
    return stripEmojiFromFundingSource(raw) || null;
};

router.get('/:workspaceId/:boardId/invoice-csv', authenticateToken, async (req, res) => {
    const startTime = Date.now();
    try {
        const { workspaceId, boardId } = req.params;
        const {
            participant = '',
            startDate,
            endDate,
            serviceDeliveryStart,
            serviceDeliveryEnd,
            transactionStatus: transactionStatusFilter = '',
            paymentStatus: paymentStatusFilter = '',
            sortBy = 'scheduledServiceDate',
            sortOrder = 'asc',
            limit = 'all',
            fundingSource: fundingSourceFilter = ''
        } = req.query;

        if (!workspaceId || !boardId) {
            return res.status(400).json({ message: 'WorkspaceId and boardId are required' });
        }

        info('Export-Service', 'Starting optimized CSV export (DB only)', {
            workspaceId, boardId, participant
        }, extractContextFromReq(req));

        const folderIds = await getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
        const baseQuery = { workspaceId, boardId };
        if (folderIds.length > 0) {
            baseQuery.folderId = { $in: folderIds };
        }

        const allItems = await Item.find(baseQuery).lean();

        info('Export-Service', 'Fetched items from database', {
            count: allItems.length
        }, extractContextFromReq(req));

        let processedItems = allItems.map(item => {
            const scheduledStart = getValue(item, ATTRIBUTE_NAMES.SCHEDULED_START);
            const actualEnd = getValue(item, ATTRIBUTE_NAMES.ACTUAL_END);

            const transactionStatusValue = getValue(item, ATTRIBUTE_NAMES.TRANSACTION_STATUS);
            const paymentStatusValue = getValue(item, ATTRIBUTE_NAMES.PAYMENT_STATUS);

            return {
                item,
                scheduledStartDate: parseDate(scheduledStart),
                actualEndDate: parseDate(actualEnd),
                participantName: '', // Will be populated after bulk fetching participant profiles
                totalAmountNum: parseNumber(getValue(item, ATTRIBUTE_NAMES.TOTAL_AMOUNT)),
                govSubsidyNum: parseNumber(getValue(item, ATTRIBUTE_NAMES.GOV_SUBSIDY)),
                participantContributionNum: parseNumber(getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)),
                transactionStatus: formatStatus(transactionStatusValue),
                paymentStatus: formatStatus(paymentStatusValue),
                servicePlanId: extractRefId(getValue(item, ATTRIBUTE_NAMES.SERVICE_PLAN)),
                participantProfileId: extractRefId(getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE)),
                fundingSourceIds: extractAllRefIds(getValue(item, ATTRIBUTE_NAMES.FUNDING_SOURCE))
            };
        });

        if (startDate) {
            const startDateObj = new Date(startDate);
            processedItems = processedItems.filter(p => p.scheduledStartDate && p.scheduledStartDate >= startDateObj);
        }
        if (endDate) {
            const endDateObj = new Date(endDate);
            processedItems = processedItems.filter(p => p.scheduledStartDate && p.scheduledStartDate <= endDateObj);
        }
        if (serviceDeliveryStart) {
            const serviceDeliveryStartObj = new Date(serviceDeliveryStart);
            processedItems = processedItems.filter(p => p.actualEndDate && p.actualEndDate >= serviceDeliveryStartObj);
        }
        if (serviceDeliveryEnd) {
            const serviceDeliveryEndObj = new Date(serviceDeliveryEnd);
            processedItems = processedItems.filter(p => p.actualEndDate && p.actualEndDate <= serviceDeliveryEndObj);
        }
        // Note: Participant filter will be applied after participant names are populated from profiles
        if (transactionStatusFilter && transactionStatusFilter !== 'all') {
            processedItems = processedItems.filter(p => p.transactionStatus === transactionStatusFilter);
        }
        if (paymentStatusFilter && paymentStatusFilter !== 'all') {
            processedItems = processedItems.filter(p => p.paymentStatus === paymentStatusFilter);
        }


        let totals = processedItems.reduce((acc, p) => ({
            totalAmount: acc.totalAmount + p.totalAmountNum,
            totalGovSubsidy: acc.totalGovSubsidy + p.govSubsidyNum,
            totalParticipantContribution: acc.totalParticipantContribution + p.participantContributionNum,
            total: acc.total + 1
        }), { totalAmount: 0, totalGovSubsidy: 0, totalParticipantContribution: 0, total: 0 });

        const sortFieldMap = {
            scheduledServiceDate: 'scheduledStartDate',
            serviceDeliveryDate: 'actualEndDate'
        };
        const selectedSortField = sortFieldMap[sortBy] || 'scheduledStartDate';
        const sortMultiplier = sortOrder === 'desc' ? -1 : 1;

        processedItems.sort((a, b) => {
            const aVal = a[selectedSortField];
            const bVal = b[selectedSortField];
            if (aVal === null && bVal === null) return 0;
            if (aVal === null) return 1;
            if (bVal === null) return -1;
            // Use getTime() for reliable Date comparison
            const aTime = aVal instanceof Date ? aVal.getTime() : aVal;
            const bTime = bVal instanceof Date ? bVal.getTime() : bVal;
            return (aTime < bTime ? -1 : aTime > bTime ? 1 : 0) * sortMultiplier;
        });

        const servicePlanIds = new Set();
        const participantProfileIds = new Set();
        const fundingSourceIds = new Set();

        for (const p of processedItems) {
            if (p.servicePlanId) servicePlanIds.add(p.servicePlanId);
            if (p.participantProfileId) participantProfileIds.add(p.participantProfileId);
            for (const fsId of p.fundingSourceIds) {
                if (fsId) fundingSourceIds.add(fsId);
            }
        }

        info('Export-Service', 'Bulk fetching reference data from DB', {
            servicePlans: servicePlanIds.size,
            participantProfiles: participantProfileIds.size,
            fundingSources: fundingSourceIds.size
        }, extractContextFromReq(req));

        const allRefIds = [...servicePlanIds, ...participantProfileIds, ...fundingSourceIds];
        const refItemsMap = await bulkFetchItemsFromDB(workspaceId, boardId, allRefIds);

        // Populate participant names from bulk-fetched participant profiles
        for (const p of processedItems) {
            if (p.participantProfileId) {
                const participantProfileItem = refItemsMap.get(p.participantProfileId);
                const profileName = getParticipantNameFromProfile(participantProfileItem);
                if (profileName) {
                    p.participantName = profileName;
                } else {
                    // Fallback to direct attribute if profile lookup fails
                    const fallbackName = getValue(p.item, ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
                    p.participantName = String(fallbackName);
                }
            } else {
                // Fallback to direct attribute if no profile ID
                const fallbackName = getValue(p.item, ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
                p.participantName = String(fallbackName);
            }
        }

        // Apply participant filter now that participant names are populated
        if (participant && participant !== 'all') {
            const participantRegex = new RegExp(participant, 'i');
            processedItems = processedItems.filter(p => participantRegex.test(p.participantName));
        }

        // Apply Funding Source filter (now that refItemsMap is populated)
        if (fundingSourceFilter && fundingSourceFilter !== 'all') {
            processedItems = processedItems.filter((item) => {
                const fundingSource = item.fundingSourceIds
                    .map((fsId) => getFundingSourceNameFromItem(refItemsMap.get(fsId)))
                    .join(', ');
                return fundingSource && fundingSource.includes(fundingSourceFilter);
            });
        }

        // Recalculate totals after participant and funding source filtering
        totals = processedItems.reduce((acc, p) => ({
            totalAmount: acc.totalAmount + p.totalAmountNum,
            totalGovSubsidy: acc.totalGovSubsidy + p.govSubsidyNum,
            totalParticipantContribution: acc.totalParticipantContribution + p.participantContributionNum,
            total: acc.total + 1
        }), { totalAmount: 0, totalGovSubsidy: 0, totalParticipantContribution: 0, total: 0 });

        const nestedRefIds = new Set();
        const serviceRefAttrs = [
            'Home Support (HS)',
            'Assistive Technology (AT) - Short Term',
            'Assistive Technology (AT) - Ongoing',
            'Home Modification (HM)',
            'Health Professional',
            'Wraparound'
        ];

        for (const servicePlanId of servicePlanIds) {
            const servicePlanItem = refItemsMap.get(servicePlanId);
            if (servicePlanItem && servicePlanItem.data) {
                for (const refAttr of serviceRefAttrs) {
                    const refValue = getValue(servicePlanItem, refAttr);
                    const refIds = extractAllRefIds(refValue);
                    refIds.forEach(id => nestedRefIds.add(id));
                }
            }
        }

        if (nestedRefIds.size > 0) {
            const nestedRefItemsMap = await bulkFetchItemsFromDB(workspaceId, boardId, [...nestedRefIds]);
            for (const [key, value] of nestedRefItemsMap) {
                refItemsMap.set(key, value);
            }
        }

        const itemIdsForInvoice = processedItems.map(p => p.item.itemId);
        const invoiceNumbers = await InvoiceNumber.find({
            workspaceId,
            boardId,
            itemId: { $in: itemIdsForInvoice }
        }).lean();
        const invoiceNumberMap = new Map(invoiceNumbers.map(inv => [inv.itemId, inv.invoiceNumber]));

        const transformedItems = processedItems.map((p) => {
            const item = p.item;
            const itemId = item.itemId;

            // Use participant name from processedItem (already resolved from participant profile)
            const participant = p.participantName || '';
            const scheduledStart = getValue(item, ATTRIBUTE_NAMES.SCHEDULED_START);
            const actualEnd = getValue(item, ATTRIBUTE_NAMES.ACTUAL_END);
            const unit = getValue(item, ATTRIBUTE_NAMES.UNIT) || '';
            const quantity = parseNumber(getValue(item, ATTRIBUTE_NAMES.QUANTITY));
            const unitPrice = parseNumber(getValue(item, ATTRIBUTE_NAMES.UNIT_PRICE));
            const totalAmount = parseNumber(getValue(item, ATTRIBUTE_NAMES.TOTAL_AMOUNT));
            const govSubsidy = parseNumber(getValue(item, ATTRIBUTE_NAMES.GOV_SUBSIDY));
            const participantContribution = parseNumber(getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION));
            const notes = getValue(item, ATTRIBUTE_NAMES.ADDITIONAL_NOTES) || '';

            let service = '';
            let serviceIdentifier = '';
            let itemDescriptionCode = '';
            let itemDescription = '';
            let wraparoundDescriptionCode = '';
            let wraparoundDescription = '';
            let healthProfessionalTypeCode = '';
            let healthProfessionalTypeOther = '';

            if (p.servicePlanId) {
                const servicePlanItem = refItemsMap.get(p.servicePlanId);
                if (servicePlanItem) {
                    service = getServiceFromServicePlan(servicePlanItem) || '';
                    serviceIdentifier = getServiceIdentifierFromServicePlan(servicePlanItem, refItemsMap) || '';

                    const itemDesc = getItemDescriptionFromServicePlan(servicePlanItem, refItemsMap);
                    itemDescriptionCode = itemDesc.code;
                    itemDescription = itemDesc.description;

                    const wraparound = getWraparoundDescriptionFromServicePlan(servicePlanItem, refItemsMap);
                    wraparoundDescriptionCode = wraparound.code;
                    wraparoundDescription = wraparound.description;

                    const healthProf = getHealthProfessionalFromServicePlan(servicePlanItem, refItemsMap);
                    healthProfessionalTypeCode = healthProf.typeCode;
                    healthProfessionalTypeOther = healthProf.typeOther;
                }
            }

            let careRecipientIdentifier = '';
            if (p.participantProfileId) {
                const participantProfileItem = refItemsMap.get(p.participantProfileId);
                careRecipientIdentifier = getMyAgedCareIdFromProfile(participantProfileItem) || '';
            }

            let fundingSource = '';
            if (p.fundingSourceIds.length > 0) {
                const fundingSourceNames = [];
                for (const fsId of p.fundingSourceIds) {
                    const fsItem = refItemsMap.get(fsId);
                    const fsName = getFundingSourceNameFromItem(fsItem);
                    if (fsName) {
                        fundingSourceNames.push(fsName);
                    }
                }
                fundingSource = fundingSourceNames.join(', ');
            }

            const serviceDeliveryDate = actualEnd && typeof actualEnd === 'string'
                ? (actualEnd.includes('T') ? actualEnd.split('T')[0] : actualEnd.split(' ')[0])
                : null;
            const scheduledServiceDate = scheduledStart && typeof scheduledStart === 'string'
                ? (scheduledStart.includes('T') ? scheduledStart.split('T')[0] : scheduledStart.split(' ')[0])
                : null;

            const deliveredBy = formatStatus(getValue(item, ATTRIBUTE_NAMES.DELIVERED_BY));
            const deliveredByThirdParty = deliveredBy && deliveredBy.toLowerCase().includes('associated') ? 'True' : 'False';

            const paymentStatusFormatted = formatStatus(getValue(item, ATTRIBUTE_NAMES.PAYMENT_STATUS));
            const transactionStatusFormatted = formatStatus(getValue(item, ATTRIBUTE_NAMES.TRANSACTION_STATUS));

            const prescribedItem = getValue(item, 'Prescribed Item');
            const prescribedItemValue = prescribedItem === true || prescribedItem === 'true' || prescribedItem === 'Y' ? 'Y' : 'N';

            const itemFirstPaymentRaw = getValue(item, 'Item First Payment');
            let itemFirstPaymentValue = 'False';
            if (typeof itemFirstPaymentRaw === 'boolean') {
                itemFirstPaymentValue = itemFirstPaymentRaw ? 'True' : 'False';
            } else if (typeof itemFirstPaymentRaw === 'string') {
                const normalized = itemFirstPaymentRaw.trim().toLowerCase();
                itemFirstPaymentValue = ['true', 'y', 'yes'].includes(normalized) ? 'True' : 'False';
            }

            const itemPurchasedMethod = formatStatus(getValue(item, 'Item Purchased Method'));
            let itemPurchasedMethodString = undefined;
            if (itemPurchasedMethod) {
                const methodName = typeof itemPurchasedMethod === 'object' ? itemPurchasedMethod.name || '' : String(itemPurchasedMethod || '');
                if (methodName) {
                    itemPurchasedMethodString = methodName.toLowerCase().includes('loan') ? 'LOANED' : 'PURCHASED';
                }
            }

            const ifLoanedLenderName = getValue(item, 'If Loaned, Lender Name');
            const ifLoanedLenderNameString = ifLoanedLenderName
                ? (typeof ifLoanedLenderName === 'object' ? ifLoanedLenderName.name : String(ifLoanedLenderName))
                : '';
            const ifLoanedLenderInvoiceNo = getValue(item, 'If Loaned, Lender Invoice No.') || '';

            let loanedByOrganisationName = '';
            let loanedByInvoiceNumber = '';
            if (itemPurchasedMethodString === 'LOANED') {
                loanedByOrganisationName = ifLoanedLenderNameString || '';
                loanedByInvoiceNumber = ifLoanedLenderInvoiceNo || '';
            }

            const normalizedUnit = typeof unit === 'string' ? unit.toLowerCase() : '';
            const isItemUnit = normalizedUnit === 'item';
            const serviceLabel = service || '';
            const isWraparound = serviceLabel.toLowerCase().includes('wraparound');

            return {
                id: item.itemId,
                paymentStatus: paymentStatusFormatted,
                participant,
                service: serviceLabel,
                scheduledServiceDate,
                serviceDeliveryDate,
                unit,
                quantity,
                unitPrice,
                totalAmount,
                govSubsidy,
                participantContribution,
                fundingSource,
                transactionStatus: transactionStatusFormatted,
                notes,
                invoiceNumber: invoiceNumberMap.get(itemId),
                careRecipientIdentifier,
                serviceIdentifier,
                deliveredByThirdParty,
                itemOrWraparound: isItemUnit ? 'Item' : (isWraparound ? 'Wraparound' : ''),
                itemDescriptionCode: isItemUnit ? itemDescriptionCode : '',
                itemDescription: isItemUnit ? itemDescription : '',
                wraparoundDescriptionCode: isWraparound ? wraparoundDescriptionCode : '',
                wraparoundDescription: isWraparound ? wraparoundDescription : '',
                prescribedItem: prescribedItemValue,
                itemPurchasedMethod: itemPurchasedMethodString,
                loanedByOrganisationName,
                loanedByInvoiceNumber,
                healthProfessionalTypeCode,
                healthProfessionalTypeOther,
                itemFirstPayment: itemFirstPaymentValue
            };
        });

        const duration = Date.now() - startTime;
        info('Export-Service', 'Completed optimized CSV export (DB only)', {
            workspaceId,
            boardId,
            itemCount: transformedItems.length,
            durationMs: duration
        }, extractContextFromReq(req));

        res.status(200).json({
            items: transformedItems,
            total: totals.total,
            totalAmount: totals.totalAmount,
            totalGovSubsidy: totals.totalGovSubsidy,
            totalParticipantContribution: totals.totalParticipantContribution,
            exportDurationMs: duration
        });
    } catch (err) {
        error('Export-Service', 'Failed to export invoice CSV', {
            message: err.message,
            stack: err.stack
        }, extractContextFromReq(req));
        res.status(500).json({ message: 'Server error', error: err.message });
    }
});

router.get('/:workspaceId/:boardId/monthly-statement-csv', authenticateToken, async (req, res) => {
    const startTime = Date.now();
    try {
        const { workspaceId, boardId } = req.params;
        const {
            participant = '',
            startDate,
            endDate,
            month,
            year,
            type = 'service',
            categoryCode,
            serviceTransactionStatus: serviceTransactionStatusFilter = '',
            serviceFundingSource: serviceFundingSourceFilter = ''
        } = req.query;

        if (!workspaceId || !boardId) {
            return res.status(400).json({ message: 'WorkspaceId and boardId are required' });
        }

        info('Export-Service', 'Starting monthly statement CSV export (DB only)', {
            workspaceId, boardId, participant, type
        }, extractContextFromReq(req));

        const businessProfile = await Business.findOne({ workspaceId: workspaceId.toString() })
            .select('name')
            .lean();

        if (type === 'budget') {
            let folders = [];
            try {
                const { folder } = await getFolder(workspaceId, boardId);
                folders = Array.isArray(folder) ? folder : [];
            } catch (err) {
                folders = [];
            }

            const folderIdToName = new Map();
            const folderIdToCode = {};
            const budgetFolderConfig = [
                { code: 'HSQ', folderName: 'Home Support Quarterly Budget' },
                { code: 'ATS', folderName: 'Assistive Technology - Short-term Budget' },
                { code: 'ATO', folderName: 'Assistive Technology - Ongoing Budget' },
                { code: 'HMB', folderName: 'Home Modification Budget' },
                { code: 'RCP', folderName: 'Restorative Care Pathway Budget' },
                { code: 'EOL', folderName: 'End-of-Life Pathway Budget' }
            ];

            folders.forEach(folderElement => {
                if (!folderElement?.id) return;
                const folderName = folderElement.name || '';
                folderIdToName.set(folderElement.id, folderName);
                const normalized = folderName.toLowerCase();
                const matchedConfig = budgetFolderConfig.find(cfg =>
                    normalized.includes(cfg.folderName.toLowerCase())
                );
                if (matchedConfig) {
                    folderIdToCode[folderElement.id] = matchedConfig.code;
                }
            });

            const budgetFolderNames = [
                'Home Support Quarterly Budget',
                'Restorative Care Pathway Budget',
                'End-of-Life Pathway Budget',
                'Assistive Technology - Short-term Budget',
                'Assistive Technology - Ongoing Budget',
                'Home Modification Budget'
            ].join(',');

            const folderIds = await getFolderIds(budgetFolderNames, workspaceId, boardId, folders);
            const baseQuery = { workspaceId, boardId };
            if (folderIds.length > 0) {
                baseQuery.folderId = { $in: folderIds };
            }

            const allBudgetItems = await Item.find(baseQuery).lean();

            const primarySupplementRefIds = new Set();
            allBudgetItems.forEach(item => {
                const primarySupplementValue = getValue(item, 'Primary Supplement');
                const refIds = extractAllRefIds(primarySupplementValue).filter(isUuidLike);
                refIds.forEach(id => primarySupplementRefIds.add(id));
            });
            const primarySupplementMap = primarySupplementRefIds.size > 0
                ? await Item.find({ workspaceId, boardId, itemId: { $in: [...primarySupplementRefIds] } }).lean()
                      .then(items => new Map(items.map(entry => [entry.itemId, entry])))
                : new Map();

            const BUDGET_FIELD_NAMES = {
                totalAvailable: [
                    'Total Available Budget for Home Support ($)',
                    'Total Available Fund for AT - Short-term ($)',
                    'Total Available Fund for AT Ongoing ($)',
                    'Total Available Fund for HM ($)',
                    'Total Available Budget for Restorative Care ($)',
                    'Total Available Budget for End-of-Life Care ($)'
                ],
                delivered: [
                    'Home Support Delivered During the Month ($-)',
                    'AT - Short-term Delivered During the Month ($-)',
                    'Assistive Technology - Short-term Delivered During the Month ($-)',
                    'Assistive Technology - Short-term Delivered During the Month',
                    'AT - Ongoing Delivered During the Month ($-)',
                    'Assistive Technology - Ongoing Delivered During the Month ($-)',
                    'Assistive Technology - Ongoing Delivered During the Month',
                    'Home Modification Delivered During the Month ($-)',
                    'Home Modification Delivered During the Month',
                    'Restorative Care Delivered During the Month ($-)',
                    'End-of-Life Care Delivered During the Month ($-)'
                ],
                remaining: [
                    'Remaining Home Support Balance as at the End of the Month ($)',
                    'Remaining AT - Short-term Balance as at the End of the Month ($)',
                    'Remaining AT - Ongoing Balance as at the End of the Month ($)',
                    'Remaining HM Balance as at the End of the Month ($)',
                    'Remaining Restorative Care Balance as at the End of the Month ($)',
                    'Remaining End-of-Life Care Balance as at the End of the Month ($)'
                ],
                previousMonthSpending: [
                    'Spending from Previous Month(s) within same Quarter ($)',
                    'Spending from Previous Month(s) within Allocated Period ($)'
                ],
                commonwealthUnspent: [
                    'Unspent HCP Funds - Commonwealth Portion (Provider-held) ($)',
                    'Commonwealth-held HCP Unspent Funds ($)'
                ],
                providerUnspent: [
                    'Commonwealth-held HCP Unspent Funds (Notional Home Care Account) ($)',
                    'Provider-held HCP Unspent Funds ($)'
                ],
                participantUnspent: [
                    'Unspent HCP Funds - Participant Portion (Provider-held) ($)',
                    'Participant Portion HCP Unspent Funds ($)'
                ],
                remainingAllocationPeriod: [
                    'Remaining AT - Short-term Balance for Allocation Period ($)',
                    'Remaining AT - Ongoing Balance for Allocation Period ($)',
                    'Remaining HM Balance for Allocation Period ($)'
                ]
            };

            const transformedBudgetItems = allBudgetItems.map(item => {
                const participantName = getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
                const monthLabel = formatStatus(getValue(item, 'Month'));
                const yearLabel = formatStatus(getValue(item, 'Year'));
                const folderName = folderIdToName.get(item.folderId) || '';
                const resolvedCategoryCode = folderIdToCode[item.folderId] || 'HSQ';
                const primarySupplementValue = getValue(item, 'Primary Supplement');
                const primarySupplementLabel = resolveReferenceValue(primarySupplementValue, primarySupplementMap);

                return {
                    id: item.itemId,
                    folderName,
                    categoryCode: resolvedCategoryCode,
                    participantName,
                    month: monthLabel,
                    year: yearLabel,
                    quarter: formatStatus(getValue(item, 'FY Quarter')) || '',
                    totalAvailableBudget: parseNumber(getValueMulti(item, BUDGET_FIELD_NAMES.totalAvailable)),
                    deliveredAmount: Math.abs(parseNumber(getValueMulti(item, BUDGET_FIELD_NAMES.delivered))),
                    adjustmentAmount: parseNumber(getValue(item, 'Adjustments from Previous Months [Charges($-)/Refund($)]')),
                    remainingBalance: parseNumber(getValueMulti(item, BUDGET_FIELD_NAMES.remaining)),
                    availableFundStart: parseNumber(getValue(item, 'Available Fund at the Start of the Month ($)')),
                    quarterlyAdjustment: parseNumber(getValue(item, 'Classification Quarterly Budget Adjustment ($)')),
                    primarySupplementAmount: parseNumber(getValue(item, 'Primary Supplement ($)')),
                    carryoverFunding: parseNumber(getValue(item, 'Carryover Funding from the Previous Quarter ($)')),
                    unspentReturned: parseNumber(getValueMulti(item, [
                        'Unspent Budget at the End of the Quarter \u2013 Returned ($-)',
                        'Unspent Budget at the End of the Quarter - Returned ($-)'
                    ])),
                    commonwealthUnspent: parseNumber(getValueMulti(item, BUDGET_FIELD_NAMES.commonwealthUnspent)),
                    providerUnspent: parseNumber(getValueMulti(item, BUDGET_FIELD_NAMES.providerUnspent)),
                    participantUnspent: parseNumber(getValueMulti(item, BUDGET_FIELD_NAMES.participantUnspent)),
                    previousMonthSpending: parseNumber(getValueMulti(item, BUDGET_FIELD_NAMES.previousMonthSpending)),
                    fundAmount: parseNumber(getValue(item, 'Fund Amount ($)')),
                    fundClassification: getValue(item, 'Fund Classification') || '',
                    primarySupplementLabel,
                    fundingStartDate: getValue(item, 'Funding Start Date'),
                    fundingEndDate: getValue(item, 'Funding End Date'),
                    fund: getValue(item, 'Fund'),
                    committedFunds: parseNumber(getValue(item, 'Committed AT Short-term Funds - to be delivered ($-)')) +
                        parseNumber(getValue(item, 'Committed AT Ongoing Funds - to be delivered ($-)')) +
                        parseNumber(getValue(item, 'Committed HM Funds - to be delivered ($-)')),
                    remainingBalanceEndOfMonth: parseNumber(getValueMulti(item, BUDGET_FIELD_NAMES.remaining)),
                    remainingBalanceAllocationPeriod: parseNumber(getValueMulti(item, BUDGET_FIELD_NAMES.remainingAllocationPeriod)),
                    rawData: item.data || {}
                };
            });

            let filteredItems = transformedBudgetItems;
            if (participant && participant !== 'all') {
                const participantRegex = new RegExp(participant, 'i');
                filteredItems = filteredItems.filter(item => participantRegex.test(item.participantName));
            }
            if (month) {
                const monthLabelLookup = {
                    '01': 'January', '02': 'February', '03': 'March', '04': 'April',
                    '05': 'May', '06': 'June', '07': 'July', '08': 'August',
                    '09': 'September', '10': 'October', '11': 'November', '12': 'December'
                };
                const targetMonth = monthLabelLookup[month.padStart(2, '0')];
                if (targetMonth) {
                    filteredItems = filteredItems.filter(item =>
                        item.month?.toLowerCase() === targetMonth.toLowerCase()
                    );
                }
            }
            if (year) {
                filteredItems = filteredItems.filter(item => item.year === year);
            }
            if (categoryCode) {
                filteredItems = filteredItems.filter(item => item.categoryCode === categoryCode);
            }

            const duration = Date.now() - startTime;
            info('Export-Service', 'Completed budget CSV export (DB only)', {
                itemCount: filteredItems.length,
                durationMs: duration
            }, extractContextFromReq(req));

            res.status(200).json({
                items: filteredItems,
                total: filteredItems.length,
                exportDurationMs: duration
            });
        } else {
            // Export service items (logic aligned with items.js monthly-statement endpoint)
            const folderIds = await getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
            const baseQuery = { workspaceId, boardId };
            if (folderIds.length > 0) {
                baseQuery.folderId = { $in: folderIds };
            }

            const allServiceItems = await Item.find(baseQuery).lean();

            // Collect participant profile IDs and bulk fetch (same as items.js)
            const participantProfileIds = new Set();
            for (const item of allServiceItems) {
                const participantProfileValue = getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
                const ppId = extractRefId(participantProfileValue);
                if (ppId) participantProfileIds.add(ppId);
            }
            const participantProfilesMap = [...participantProfileIds].length > 0
                ? await bulkFetchItemsFromDB(workspaceId, boardId, [...participantProfileIds])
                : new Map();

            // Process items with same date, participant and transaction status logic as items.js
            let processedItems = allServiceItems.map(item => {
                const scheduledStart = getValue(item, ATTRIBUTE_NAMES.SCHEDULED_START);
                const actualEnd = getValue(item, ATTRIBUTE_NAMES.ACTUAL_END);
                const transactionStatusRaw = getValue(item, ATTRIBUTE_NAMES.TRANSACTION_STATUS);
                const transactionStatusFormatted = formatStatus(transactionStatusRaw);
                const useActualEndForFilter = normalizeString(transactionStatusFormatted) === normalizeString(TRANSACTION_STATUS_USE_ACTUAL_END);
                const scheduledStartDate = parseDate(scheduledStart);
                const actualEndDate = parseDate(actualEnd);
                const filterDate = useActualEndForFilter ? actualEndDate : scheduledStartDate;

                const participantProfileValue = getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
                const participantId = extractRefId(participantProfileValue);
                let participantName = '';
                if (participantId) {
                    const profileItem = participantProfilesMap.get(participantId);
                    if (profileItem) {
                        participantName = getParticipantNameFromProfile(profileItem) || '';
                    }
                }
                if (!participantName) {
                    participantName = getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
                }

                return {
                    item,
                    scheduledStartDate,
                    actualEndDate,
                    filterDate,
                    participantName: String(participantName),
                    participantProfileValue,
                    transactionStatusFormatted: transactionStatusFormatted || '',
                    servicePlanId: extractRefId(getValue(item, ATTRIBUTE_NAMES.SERVICE_PLAN)),
                    fundingSourceIds: extractAllRefIds(getValue(item, ATTRIBUTE_NAMES.FUNDING_SOURCE))
                };
            });

            // Filter by participant (same logic as items.js: regex on name or profile value)
            if (participant && participant !== 'all') {
                try {
                    const participantRegex = new RegExp(participant, 'i');
                    processedItems = processedItems.filter(p =>
                        participantRegex.test(p.participantName) ||
                        (p.participantProfileValue && (
                            (typeof p.participantProfileValue === 'string' && participantRegex.test(p.participantProfileValue)) ||
                            (Array.isArray(p.participantProfileValue) && p.participantProfileValue.some(v => participantRegex.test(String(v)))) ||
                            (typeof p.participantProfileValue === 'object' && p.participantProfileValue.id && participantRegex.test(String(p.participantProfileValue.id)))
                        ))
                    );
                } catch (regexErr) {
                    warn('Export-Service', 'Invalid participant regex pattern', { pattern: participant, error: regexErr.message }, extractContextFromReq(req));
                }
            }
            // Filter by date using filterDate (Actual End for "Delivered...", else Scheduled Start)
            if (startDate) {
                const startDateObj = new Date(startDate);
                processedItems = processedItems.filter(p => p.filterDate && p.filterDate >= startDateObj);
            }
            if (endDate) {
                const endDateObj = new Date(endDate);
                processedItems = processedItems.filter(p => p.filterDate && p.filterDate <= endDateObj);
            }
            if (serviceTransactionStatusFilter && String(serviceTransactionStatusFilter).trim() !== '' && String(serviceTransactionStatusFilter).toLowerCase() !== 'all') {
                const filterValue = String(serviceTransactionStatusFilter).trim();
                processedItems = processedItems.filter(p =>
                    p.transactionStatusFormatted && p.transactionStatusFormatted === filterValue
                );
            }

            const servicePlanIds = new Set();
            const fundingSourceIds = new Set();

            for (const p of processedItems) {
                if (p.servicePlanId) servicePlanIds.add(p.servicePlanId);
                for (const fsId of p.fundingSourceIds) {
                    if (fsId) fundingSourceIds.add(fsId);
                }
            }

            const allRefIds = [...servicePlanIds, ...fundingSourceIds];
            const refItemsMap = await bulkFetchItemsFromDB(workspaceId, boardId, allRefIds);

            // Apply Funding Source filter (now that refItemsMap is populated)
            if (serviceFundingSourceFilter && serviceFundingSourceFilter !== 'all') {
                const fsFilterValue = String(serviceFundingSourceFilter).trim();
                processedItems = processedItems.filter(p => {
                    if (p.fundingSourceIds.length === 0) return false;
                    const fundingSourceNames = [];
                    for (const fsId of p.fundingSourceIds) {
                        const fsItem = refItemsMap.get(fsId);
                        const fsName = getFundingSourceNameFromItem(fsItem);
                        if (fsName) fundingSourceNames.push(fsName);
                    }
                    const resolved = fundingSourceNames.join(', ');
                    return resolved && resolved === fsFilterValue;
                });
            }

            const transformedItems = processedItems.map(p => {
                const item = p.item;
                const participantNameValue = p.participantName;
                const scheduledStart = getValue(item, ATTRIBUTE_NAMES.SCHEDULED_START);
                const actualEnd = getValue(item, ATTRIBUTE_NAMES.ACTUAL_END);
                const unit = getValue(item, ATTRIBUTE_NAMES.UNIT) || 'Hour';
                const quantity = parseNumber(getValue(item, ATTRIBUTE_NAMES.QUANTITY));
                const unitPrice = parseNumber(getValue(item, ATTRIBUTE_NAMES.UNIT_PRICE));
                const totalAmount = parseNumber(getValue(item, ATTRIBUTE_NAMES.TOTAL_AMOUNT));
                const govSubsidy = parseNumber(getValue(item, ATTRIBUTE_NAMES.GOV_SUBSIDY));
                const participantContribution = parseNumber(getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION));
                const notes = getValue(item, ATTRIBUTE_NAMES.ADDITIONAL_NOTES) || '';
                const transactionStatus = formatStatus(getValue(item, ATTRIBUTE_NAMES.TRANSACTION_STATUS));
                const committedAtHm = getValue(item, ATTRIBUTE_NAMES.COMMITTED_AT_HM);

                // Get service from service plan using helper function
                let service = '';
                if (p.servicePlanId) {
                    const servicePlanItem = refItemsMap.get(p.servicePlanId);
                    service = getServiceFromServicePlan(servicePlanItem) || '';
                }

                // Get funding source using helper function
                let fundingSource = '';
                if (p.fundingSourceIds.length > 0) {
                    const fundingSourceNames = [];
                    for (const fsId of p.fundingSourceIds) {
                        const fsItem = refItemsMap.get(fsId);
                        const fsName = getFundingSourceNameFromItem(fsItem);
                        if (fsName) {
                            fundingSourceNames.push(fsName);
                        }
                    }
                    fundingSource = fundingSourceNames.join(', ');
                }

                // Get service provider
                let serviceProvider = businessProfile?.name || '';
                const deliveredByRaw = getValue(item, ATTRIBUTE_NAMES.DELIVERED_BY);
                if (deliveredByRaw) {
                    const deliveredByName = typeof deliveredByRaw === 'object' ? deliveredByRaw.name : String(deliveredByRaw);
                    if (deliveredByName?.toLowerCase()?.includes('associated')) {
                        const associatedProvider = getValue(item, ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER);
                        serviceProvider = associatedProvider
                            ? (typeof associatedProvider === 'object' ? associatedProvider.name : String(associatedProvider))
                            : '';
                    }
                }

                // Return raw ISO datetime strings so the frontend can format them in the user's local timezone
                const serviceDeliveryDate = actualEnd || null;
                const scheduledServiceDate = scheduledStart || null;

                const committedAtHmForDelivery = committedAtHm !== null && committedAtHm !== undefined
                    ? (typeof committedAtHm === 'number' ? committedAtHm : Number(committedAtHm) || 0)
                    : undefined;

                return {
                    id: item.itemId,
                    participant: participantNameValue,
                    service,
                    serviceProvider,
                    scheduledServiceDate,
                    serviceDeliveryDate,
                    transactionStatus,
                    committedAtHmForDelivery,
                    unit,
                    quantity,
                    unitPrice,
                    totalAmount,
                    govSubsidy,
                    participantContribution,
                    fundingSource,
                    notes
                };
            });

            const duration = Date.now() - startTime;
            info('Export-Service', 'Completed service CSV export (DB only)', {
                itemCount: transformedItems.length,
                durationMs: duration
            }, extractContextFromReq(req));

            res.status(200).json({
                items: transformedItems,
                total: transformedItems.length,
                exportDurationMs: duration
            });
        }
    } catch (err) {
        error('Export-Service', 'Failed to export monthly statement CSV', {
            message: err.message,
            stack: err.stack
        }, extractContextFromReq(req));
        res.status(500).json({ message: 'Server error', error: err.message });
    }
});

export default router;
