import express from 'express';
import {
    lookupServiceIdFromRefs,
    normalizeServiceIdString,
    normalizeHealthProfessionalTypeOther,
    lookupHealthProfessionalFromRef,
} from '../utils/exportOptimizedServicePlanHelpers.js';
import { handleInvoiceCsvExport } from '../utils/exportOptimizedInvoiceCsvHelpers.js';
import { handleNdisInvoiceCsvExport } from '../utils/exportOptimizedNdisCsvHelpers.js';
import { authenticateToken } from '../middleware/auth.js';
import { toRequiredQueryString } from '../utils/securityHelpers.js';
import Item from '../models/Item.js';
import InvoiceNumber from '../models/InvoiceNumber.js';
import Business from '../models/Business.js';
import { info, error, warn } from '../utils/logger.js';
import { getFolder } from '../services/isoplus.js';
import { fetchBudgetItems, fetchServiceItems } from '../services/monthlyStatementData.js';
import {
    buildNdisMasterPlanServiceRows,
    buildNdisSupportCatalogueForServicePlan,
    collectNdisSupportCatalogueRefIds,
    NDIS_MASTERPLAN_ATTR,
    NDIS_SERVICEPLAN_ATTR,
    extractRefId as extractNdisRefId,
    extractAllRefIds as extractNdisAllRefIds,
    formatLabelValue as formatNdisLabelValue,
    getValueMulti as getNdisValueMulti,
    parseNumberValue as parseNdisNumber,
    formatDdMmYyyy,
    mapNdisClaimCsvQuantityAndHours,
    sanitizeDigits,
    getParticipantDisplayName as getNdisParticipantDisplayName,
    getParticipantNdisNumber,
    mapCancellationReasonCode,
    resolveNdisClaimType,
    resolveCancellationReasonLabel,
    resolveNdisSupportDeliveredDates,
    resolveRefItemDisplayName,
    isCancellationClaimRow,
    isUuidLike as isUuidLikeNdis,
} from '../utils/ndisServiceRecords.js';
import { resolveNdisPricingRuleForServicePlan } from '../utils/ndisPricingRules.js';

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
            warn('Export-Service', 'Failed to fetch folders from ISO+ API (falling back to empty)', { err, workspaceId, boardId });
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

const readNamedField = (data, field) => {
    const value = data?.[field];
    if (!value) return '';
    if (typeof value === 'object' && value.name) return value.name;
    return String(value);
};

const getReferenceDisplayName = (refItem) => {
    if (!refItem?.data) return '';

    const fields = ['Funding Stream', 'Definition', 'Full Name/Preferred Name', 'Name'];
    for (const field of fields) {
        const label = readNamedField(refItem.data, field);
        if (label) return label;
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
        return normalizeServiceIdString(serviceId);
    }

    if (refItemsMap) {
        return lookupServiceIdFromRefs(
            servicePlanItem,
            refItemsMap,
            SERVICE_REF_ATTRS,
            getValue,
            getValueMulti,
            extractRefId,
            idAttrs,
        );
    }

    return null;
};

const SERVICE_REF_ATTRS = [
    'Home Support (HS)',
    'Assistive Technology (AT) - Short Term',
    'Assistive Technology (AT) - Ongoing',
    'Home Modification (HM)',
    'Health Professional'
];

const lookupItemDescriptionFromRefs = (servicePlanItem, refItemsMap, codeAttrs, descAttrs) => {
    for (const refAttr of SERVICE_REF_ATTRS) {
        const refValue = getValue(servicePlanItem, refAttr);
        const refId = extractRefId(refValue);
        if (!refId) continue;
        const refItem = refItemsMap.get(refId);
        if (!refItem) continue;
        const refCode = getValueMulti(refItem, codeAttrs);
        const refDesc = getValueMulti(refItem, descAttrs);
        if (refCode || refDesc) {
            return { code: refCode || '', description: refDesc || '' };
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
        const fromRefs = lookupItemDescriptionFromRefs(servicePlanItem, refItemsMap, codeAttrs, descAttrs);
        if (fromRefs) return fromRefs;
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
        return {
            typeCode,
            typeOther: normalizeHealthProfessionalTypeOther(typeOther),
        };
    }

    if (refItemsMap) {
        const healthProfRefValue = getValue(servicePlanItem, 'Health Professional');
        const healthProfRefId = extractRefId(healthProfRefValue);

        if (healthProfRefId) {
            const fromRef = lookupHealthProfessionalFromRef(
                refItemsMap,
                healthProfRefId,
                getValueMulti,
                typeCodeAttrs,
                typeOtherAttrs,
            );
            if (fromRef) return fromRef;
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

const exportInvoiceCsvDeps = {
    info,
    error,
    getFolderIds,
    Item,
    InvoiceNumber,
    bulkFetchItemsFromDB,
    getFundingSourceNameFromItem,
    getValue,
    ATTRIBUTE_NAMES,
    parseDate,
    parseNumber,
    formatStatus,
    extractRefId,
    extractAllRefIds,
    getParticipantNameFromProfile,
    getServiceFromServicePlan,
    getServiceIdentifierFromServicePlan,
    getItemDescriptionFromServicePlan,
    getWraparoundDescriptionFromServicePlan,
    getHealthProfessionalFromServicePlan,
    getMyAgedCareIdFromProfile,
};

const exportNdisCsvDeps = {
    Business,
    Item,
    InvoiceNumber,
    bulkFetchItemsFromDB,
    getFolderIds,
    info,
    warn,
    error,
    NDIS_MASTERPLAN_ATTR,
    extractNdisRefId,
    extractNdisAllRefIds,
    formatNdisLabelValue,
    getNdisValueMulti,
    formatDdMmYyyy,
    mapNdisClaimCsvQuantityAndHours,
    sanitizeDigits,
    getNdisParticipantDisplayName,
    getParticipantNdisNumber,
    mapCancellationReasonCode,
    resolveNdisClaimType,
    resolveCancellationReasonLabel,
    resolveNdisSupportDeliveredDates,
    resolveRefItemDisplayName,
    isCancellationClaimRow,
    isUuidLikeNdis,
    buildNdisMasterPlanServiceRows,
    buildNdisSupportCatalogueForServicePlan,
    collectNdisSupportCatalogueRefIds,
    resolveNdisPricingRuleForServicePlan,
};

router.get('/:workspaceId/:boardId/invoice-csv', authenticateToken, async (req, res) => handleInvoiceCsvExport(req, res, exportInvoiceCsvDeps));
router.get('/:workspaceId/:boardId/invoice-csv-ndis', authenticateToken, async (req, res) => handleNdisInvoiceCsvExport(req, res, exportNdisCsvDeps));
router.get('/:workspaceId/:boardId/monthly-statement-csv', authenticateToken, async (req, res) => {
    const startTime = Date.now();
    try {
        const workspaceId = toRequiredQueryString(req.params.workspaceId);
        const boardId = toRequiredQueryString(req.params.boardId);
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
            return res.status(400).json({
                message: 'Monthly statement CSV export could not start because the workspace or board is missing. Return to your workspace list, open the board again, and try the export again.'
            });
        }

        info('Export-Service', 'Starting monthly statement CSV export (DB only)', {
            workspaceId, boardId, participant, type
        }, req ?? null);

        let items;
        if (type === 'budget') {
            items = await fetchBudgetItems(workspaceId, boardId, {
                participant, month, year, categoryCode
            });
        } else {
            items = await fetchServiceItems(workspaceId, boardId, {
                participant, startDate, endDate,
                transactionStatusFilter: serviceTransactionStatusFilter,
                fundingSourceFilter: serviceFundingSourceFilter
            });
        }

        const duration = Date.now() - startTime;
        info('Export-Service', `Completed ${type} CSV export (DB only)`, {
            itemCount: items.length, durationMs: duration
        }, req ?? null);

        res.status(200).json({
            items,
            total: items.length,
            exportDurationMs: duration
        });
    } catch (err) {
        error('Export-Service', 'Failed to export monthly statement CSV', { err }, req);
        res.status(500).json({
            message: 'Monthly statement CSV export failed due to a server problem. Please try again. If this keeps happening, contact support.'
        });
    }
});

export default router;
