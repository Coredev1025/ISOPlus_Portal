import Item from '../models/Item.js';
import Business from '../models/Business.js';
import { getFolder } from './isoplus.js';
import { info } from '../utils/logger.js';
import { parseFlexibleNumber } from '../utils/parseFlexibleNumber.js';
import {
    getDeliveredAmountForCategoryCode,
    buildServiceItemDateQuery,
} from '../utils/monthlyStatementDeliveredHelpers.js';
import {
    mapRawServiceItem,
    filterProcessedServiceItems,
} from '../utils/monthlyStatementServiceHelpers.js';
import { transformProcessedServiceItem } from '../utils/monthlyStatementDataServiceHelpers.js';
import { transformBudgetItemData } from '../utils/monthlyStatementDataBudgetHelpers.js';
import { mongoEq } from '../utils/securityHelpers.js';
import {
    ATTRIBUTE_NAMES,
    BUDGET_CATEGORY_CONFIG,
    BUDGET_CATEGORY_ORDER,
} from '../constants/monthlyStatementAttributes.js';

export const parseMonthlyStatementNumber = parseFlexibleNumber;
const parseNumber = parseFlexibleNumber;

// Values marked as ($-) in the board are outflows and should be negative.
const toOutflow = (num) => {
    const n = Number(num);
    if (!Number.isFinite(n) || n === 0) return 0;
    return -Math.abs(n);
};

const parseDate = (value) => {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
};

const getValueFromFlatData = (item, attributeName) => {
    if (!item?.data) return null;

    const attributeNames = Array.isArray(attributeName) ? attributeName : [attributeName];
    for (const attrName of attributeNames) {
        if (item.data[attrName] !== undefined && item.data[attrName] !== null) {
            return item.data[attrName];
        }
    }

    // Some items may store data in a values[] array form
    if (Array.isArray(item.data.values)) {
        for (const attrName of attributeNames) {
            const entry = item.data.values.find(v => v?.attribute?.name === attrName);
            if (entry?.data !== undefined && entry?.data !== null) {
                return entry.data;
            }
        }
    }

    return null;
};

const getValue = (item, attr) => getValueFromFlatData(item, attr);
const getValueMulti = (item, attrs) => getValueFromFlatData(item, attrs);

const isUuidLike = (v) =>
    typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const extractRefId = (value) => {
    if (!value) return null;
    if (Array.isArray(value) && value.length > 0) {
        const first = value[0];
        if (typeof first === 'object' && first.id) return first.id.toString();
        return first?.toString() ?? null;
    }
    if (typeof value === 'object' && value.id) return value.id.toString();
    return value?.toString() ?? null;
};

const extractAllRefIds = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.map(v => (typeof v === 'object' && v.id) ? v.id.toString() : v?.toString()).filter(Boolean);
    }
    if (typeof value === 'object' && value.id) return [value.id.toString()];
    return value ? [value.toString()] : [];
};

const formatStatus = (value) => {
    if (!value) return undefined;
    if (Array.isArray(value) && value.length > 0) {
        return value.map(v => (typeof v === 'object' && v.name) ? v.name : String(v)).filter(Boolean).join(', ');
    }
    if (typeof value === 'object' && value.name) return value.name;
    return String(value);
};

const normalizeString = (v) => (v || '').toString().trim().toLowerCase().replace(/\.+$/, '');
const DELIVERED_STATUS = 'Delivered - To be claimed and invoiced.';

const stripEmoji = (str) =>
    (str || '').replace(/[\u{1F300}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();

const resolveDisplayName = (refItem) => {
    if (!refItem?.data) return '';
    // Prefer short "Primary Supplement" value (e.g. "Veterans") over "Definition" (long text)
    // and prefer "Funding Stream" label for funding stream references.
    for (const key of ['Funding Stream', 'Primary Supplement', 'Name', 'Full Name/Preferred Name', 'Definition']) {
        const val = getValueFromFlatData(refItem, key);
        if (val) return (typeof val === 'object' && val.name) ? val.name : String(val);
    }
    return '';
};

const resolveReferenceValue = (value, refMap) => {
    if (!value) return '';
    if (Array.isArray(value)) return value.map(v => resolveReferenceValue(v, refMap)).filter(Boolean).join(', ');
    if (typeof value === 'object') {
        if (value.name) return value.name;
        if (value.id) return resolveReferenceValue(value.id, refMap);
        return '';
    }
    const str = String(value);
    if (isUuidLike(str) && refMap?.has(str)) return resolveDisplayName(refMap.get(str)) || str;
    return str;
};

const ATTR = ATTRIBUTE_NAMES;

const BUDGET_FOLDER_NAMES = BUDGET_CATEGORY_CONFIG.map((c) => c.folderName).join(',');

const BUDGET_FIELDS = {
    totalAvailable: [
        'Total Available Budget for Home Support ($)',
        'Total Available Fund for AT - Short-term ($)',
        'Total Available Fund for AT - Ongoing ($)',
        'Total Available Fund for AT Ongoing ($)',
        'Total Available Fund for HM ($)',
        'Total Available Budget for Restorative Care ($)',
        'Total Available Budget for End-of-Life Care ($)',
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
        'End-of-Life Care Delivered During the Month ($-)',
    ],
    remaining: [
        'Remaining Home Support Balance as at the End of the Month ($)',
        'Remaining AT - Short-term Balance as at the End of the Month ($)',
        'Remaining AT - Ongoing Balance as at the End of the Month ($)',
        'Remaining HM Balance as at the End of the Month ($)',
        'Remaining Restorative Care Balance as at the End of the Month ($)',
        'Remaining End-of-Life Care Balance as at the End of the Month ($)',
    ],
    previousMonthSpending: [
        'Spending from Previous Month(s) within same Quarter ($)',
        'Spending from Previous Month(s) within Allocated Period ($)',
    ],
    commonwealthUnspent: [
        'Unspent HCP Funds - Commonwealth Portion (Provider-held) ($)',
        'Commonwealth-held HCP Unspent Funds ($)',
    ],
    providerUnspent: [
        'Commonwealth-held HCP Unspent Funds (Notional Home Care Account) ($)',
        'Provider-held HCP Unspent Funds ($)',
    ],
    participantUnspent: [
        'Unspent HCP Funds - Participant Portion (Provider-held) ($)',
        'Participant Portion HCP Unspent Funds ($)',
    ],
    remainingAllocationPeriod: [
        'Remaining AT - Short-term Balance for Allocation Period ($)',
        'Remaining AT - Ongoing Balance for Allocation Period ($)',
        'Remaining HM Balance for Allocation Period ($)',
    ],
};

const MONTH_LABELS = {
    '01': 'January', '02': 'February', '03': 'March', '04': 'April',
    '05': 'May', '06': 'June', '07': 'July', '08': 'August',
    '09': 'September', '10': 'October', '11': 'November', '12': 'December'
};

const getFolderIds = async (folderName, workspaceId, boardId, providedFolders = null) => {
    let folders = providedFolders;
    if (!Array.isArray(folders)) {
        try {
            const { folder } = await getFolder(workspaceId, boardId);
            folders = Array.isArray(folder) ? folder : [];
        } catch { return []; }
    }
    const names = String(folderName || '')
        .toLowerCase()
        .split(',')
        .map(n => n.trim())
        .filter(Boolean);
    if (names.length === 0) return [];
    return folders
        .filter(f => f?.name && names.some(n => String(f.name).toLowerCase().includes(n)))
        .map(f => f.id);
};

const normalizeMonthParam = (month) => {
    if (month === null || month === undefined || month === '') return null;
    const raw = String(month).trim();
    if (!/^\d{1,2}$/.test(raw)) return null;
    const padded = raw.padStart(2, '0');
    return MONTH_LABELS[padded] ? padded : null;
};

const normalizeYearParam = (year) => {
    if (year === null || year === undefined || year === '') return '';
    return String(year).trim();
};

const normalizeParticipantParam = (participant) => {
    if (participant === null || participant === undefined) return '';
    if (typeof participant === 'string') return participant.trim();
    if (typeof participant === 'number' || typeof participant === 'boolean') return String(participant).trim();

    if (Array.isArray(participant)) {
        const ref = extractRefId(participant);
        return ref ? String(ref).trim() : '';
    }
    if (typeof participant === 'object') {
        if (participant.id) return String(participant.id).trim();
        if (participant.value) return String(participant.value).trim();
        if (participant.name) return String(participant.name).trim();
        const ref = extractRefId(participant);
        return ref ? String(ref).trim() : '';
    }

    return String(participant).trim();
};

const bulkFetchItems = async (workspaceId, boardId, itemIds) => {
    if (!itemIds?.length) return new Map();
    const uniqueIds = [...new Set(itemIds.filter(Boolean))];
    if (!uniqueIds.length) return new Map();

    const items = await Item.find({ workspaceId, boardId, itemId: { $in: uniqueIds } }).lean();
    const map = new Map(items.map(i => [i.itemId, i]));

    const missingIds = uniqueIds.filter(id => !map.has(id));
    if (missingIds.length) {
        const cross = await Item.find({ workspaceId, itemId: { $in: missingIds } }).lean();
        cross.forEach(i => { if (!map.has(i.itemId)) map.set(i.itemId, i); });
    }
    return map;
};

const getParticipantName = (profileItem) => {
    if (!profileItem) return null;
    const nameAttrs = [
        'Full Name/Preferred Name',
        'Preferred Name',
        'First Name',
        'Last Name',
        'Full Name',
        'Name'
    ];
    const name = getValueFromFlatData(profileItem, nameAttrs);
    if (!name) return null;
    if (typeof name === 'object' && name.name) return name.name;
    return String(name);
};

const getServiceFromServicePlan = (servicePlanItem) => {
    if (!servicePlanItem) return null;

    const servicePlanIdValue = getValueFromFlatData(servicePlanItem, [ATTR.SERVICE_PLAN_ID, 'Service Plan ID']);
    if (servicePlanIdValue) {
        const servicePlanIdStr = String(servicePlanIdValue).trim();
        if (servicePlanIdStr.includes('-')) {
            const parts = servicePlanIdStr.split('-');
            const fromId = parts.length >= 2 ? parts.slice(1).join('-').trim() : servicePlanIdStr;
            if (fromId) return fromId;
        } else if (servicePlanIdStr) {
            return servicePlanIdStr;
        }
    }

    // Fallback: use Service attribute if present (fixes blank service for some rows)
    const serviceAttr = getValueFromFlatData(servicePlanItem, ['Service']);
    if (serviceAttr) {
        if (typeof serviceAttr === 'object' && serviceAttr.name) return serviceAttr.name;
        return String(serviceAttr).trim();
    }
    return null;
};

const getServiceName = (servicePlanItem) => {
    if (!servicePlanItem) return null;
    const val = getValueMulti(servicePlanItem, ['Service Plan ID', ATTR.SERVICE_PLAN_ID]);
    if (!val) return null;
    const str = String(val).trim();
    if (str.includes('-')) {
        const parts = str.split('-');
        return parts.length >= 2 ? parts.slice(1).join('-').trim() : str;
    }
    return str;
};

const getFundingSourceName = (fsItem) => {
    if (!fsItem) return null;
    const name = getValueFromFlatData(fsItem, ['Funding Stream', 'Definition']);
    if (!name) return null;
    const raw = (typeof name === 'object' && name.name) ? String(name.name).trim() : String(name).trim();
    return stripEmoji(raw) || null;
};

const isPrimarySupplementOrUnspentHcp = (name) => {
    const n = (name || '').toLowerCase();
    return n.includes('primary supplement') || n.includes('unspent home care package') || n.includes('unspent hcp');
};

export async function fetchBudgetItems(workspaceId, boardId, options = {}) {
    const { participant, month, year, categoryCode } = options;
    const participantParam = normalizeParticipantParam(participant);
    const yearParam = normalizeYearParam(year);

    let folders = [];
    try {
        const { folder } = await getFolder(workspaceId, boardId);
        folders = Array.isArray(folder) ? folder : [];
    } catch { folders = []; }

    const folderIdToName = new Map();
    const folderIdToCode = {};
    for (const f of folders) {
        if (!f?.id) continue;
        const name = f.name || '';
        folderIdToName.set(f.id, name);
        const match = BUDGET_CATEGORY_CONFIG.find(cfg => name.toLowerCase().includes(cfg.folderName.toLowerCase()));
        if (match) folderIdToCode[f.id] = match.code;
    }

    const folderIds = await getFolderIds(BUDGET_FOLDER_NAMES, workspaceId, boardId, folders);
    const query = { workspaceId, boardId };
    if (folderIds.length) query.folderId = { $in: folderIds };

    const rawItems = await Item.find(query).lean();

    const profileIds = new Set();
    const psRefIds = new Set();
    rawItems.forEach(item => {
        const ppId = extractRefId(getValue(item, ATTR.PARTICIPANT_PROFILE));
        if (ppId) profileIds.add(ppId);
        const apId = extractRefId(getValue(item, 'Associated Participant'));
        if (apId) profileIds.add(apId);
        extractAllRefIds(getValue(item, 'Primary Supplement')).filter(isUuidLike).forEach(id => psRefIds.add(id));
    });

    const [profileMap, psMap] = await Promise.all([
        profileIds.size > 0 ? bulkFetchItems(workspaceId, boardId, [...profileIds]) : Promise.resolve(new Map()),
        psRefIds.size > 0 ? bulkFetchItems(workspaceId, boardId, [...psRefIds]) : Promise.resolve(new Map()),
    ]);

    const resolveParticipant = (item) => {
        const ppId = extractRefId(getValue(item, ATTR.PARTICIPANT_PROFILE));
        if (ppId) {
            const name = getParticipantName(profileMap.get(ppId));
            if (name) return name;
        }
        return getValue(item, ATTR.PARTICIPANT_FULL_NAME) || '';
    };

    const resolveParticipantForHSCM = (item) => {
        const ppId = extractRefId(getValue(item, 'Associated Participant'));
        if (ppId) {
            const name = getParticipantName(profileMap.get(ppId));
            if (name) return name;
        }
        return getValue(item, ATTR.PARTICIPANT_FULL_NAME) || '';
    };

    const budgetTransformCtx = {
        folderIdToCode,
        folderIdToName,
        resolveParticipant,
        resolveParticipantForHSCM,
        getValue,
        getValueMulti,
        parseNumber,
        toOutflow,
        extractRefId,
        formatStatus,
        resolveReferenceValue,
        psMap,
        BUDGET_FIELDS,
        getDeliveredAmountForCategoryCode,
        ATTR,
    };

    const transformed = rawItems.map((item) => transformBudgetItemData(item, budgetTransformCtx));

    const getCategoryOrderIndex = (code) => {
        const normalizedCode = (code || 'HSQ').toString();
        const idx = BUDGET_CATEGORY_ORDER.indexOf(normalizedCode);
        return idx === -1 ? BUDGET_CATEGORY_ORDER.length : idx;
    };

    const isIdLike = (value) => typeof value === 'string' && value.includes('-');
    const normalizedParticipant = normalizeString(participantParam);

    const normalizedMonth = normalizeMonthParam(month);
    const targetMonthLabel = normalizedMonth && MONTH_LABELS[normalizedMonth] ? MONTH_LABELS[normalizedMonth] : null;

    let result = transformed.filter(item => {
        const matchesParticipant = normalizedParticipant
            ? (isIdLike(participantParam)
                ? item.participantProfileId === participantParam
                : normalizeString(item.participantName) === normalizedParticipant)
            : true;

        const matchesYear = yearParam ? normalizeString(item.year) === normalizeString(yearParam) : true;
        const matchesMonth = targetMonthLabel ? normalizeString(item.month) === normalizeString(targetMonthLabel) : true;
        return matchesParticipant && matchesYear && matchesMonth;
    });

    if (categoryCode) result = result.filter(i => i.categoryCode === categoryCode);

    result.sort((a, b) => {
        const orderDiff = getCategoryOrderIndex(a.categoryCode) - getCategoryOrderIndex(b.categoryCode);
        if (orderDiff !== 0) return orderDiff;
        return (a.folderName || '').localeCompare(b.folderName || '');
    });

    info('MonthlyStatementData', 'Fetched budget items', {
        workspaceId, boardId, raw: rawItems.length, filtered: result.length
    });
    return result;
}

export async function fetchServiceItems(workspaceId, boardId, options = {}) {
    const { participant, startDate, endDate, transactionStatusFilter, fundingSourceFilter } = options;
    const participantParam = normalizeParticipantParam(participant);

    const businessProfile = await Business.findOne({ workspaceId: mongoEq(workspaceId) }).select('name').lean();

    const folderIds = await getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
    const query = { workspaceId, boardId };
    if (folderIds.length) query.folderId = { $in: folderIds };

    const toValidDate = (value) => {
        if (!value) return null;
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    };
    const startD = toValidDate(startDate);
    const endD = toValidDate(endDate);
    const scheduledKey = `data.${ATTR.SCHEDULED_START}`;
    const actualEndKey = `data.${ATTR.ACTUAL_END}`;

    if (startD || endD) {
        const dateQuery = buildServiceItemDateQuery(startD, endD, scheduledKey, actualEndKey);
        if (dateQuery) Object.assign(query, dateQuery);
    }

    const rawItems = await Item.find(query).lean();

    const profileIds = new Set();
    rawItems.forEach(item => {
        const id = extractRefId(getValue(item, ATTR.PARTICIPANT_PROFILE));
        if (id) profileIds.add(id);
    });
    const profileMap = profileIds.size > 0
        ? await bulkFetchItems(workspaceId, boardId, [...profileIds])
        : new Map();

    const fundingSourceIdsAll = new Set();
    rawItems.forEach(item => {
        extractAllRefIds(getValue(item, ATTR.FUNDING_SOURCE)).forEach(id => { if (id) fundingSourceIdsAll.add(id); });
    });
    const fundingSourceMap = fundingSourceIdsAll.size > 0
        ? await bulkFetchItems(workspaceId, boardId, [...fundingSourceIdsAll])
        : new Map();

    let processed = rawItems.map((item) => mapRawServiceItem(item, profileMap, fundingSourceMap, {
        getValue,
        ATTR,
        formatStatus,
        normalizeString,
        DELIVERED_STATUS,
        parseDate,
        extractRefId,
        extractAllRefIds,
        getParticipantName,
        getFundingSourceName,
    }));

    processed = filterProcessedServiceItems(processed, {
        participantParam,
        startDate,
        endDate,
        transactionStatusFilter,
        fundingSourceFilter,
    });

    // Sort like monthly-statement endpoint default (by updatedAt desc when no explicit sort is provided)
    processed.sort((a, b) => {
        const aUpdated = a.item.updatedAt || a.item.createdAt || new Date(0);
        const bUpdated = b.item.updatedAt || b.item.createdAt || new Date(0);
        const aTime = aUpdated instanceof Date ? aUpdated.getTime() : new Date(aUpdated).getTime();
        const bTime = bUpdated instanceof Date ? bUpdated.getTime() : new Date(bUpdated).getTime();
        if (aTime < bTime) return 1;
        if (aTime > bTime) return -1;
        return 0;
    });

    const spIds = new Set();
    const fsIds = new Set();
    const associatedProviderIds = new Set();
    for (const p of processed) {
        if (p.servicePlanId) spIds.add(p.servicePlanId);
        p.fundingSourceIds.forEach(id => { if (id) fsIds.add(id); });
        const apId = extractRefId(getValue(p.item, ATTR.ASSOCIATED_PROVIDER));
        if (apId) associatedProviderIds.add(apId);
    }
    const refMap = await bulkFetchItems(workspaceId, boardId, [...spIds, ...fsIds, ...associatedProviderIds]);

    const serviceTransformHelpers = {
        getValue,
        getValueMulti,
        ATTR,
        formatStatus,
        parseNumber,
        getServiceFromServicePlan,
        getValueFromFlatData,
        extractRefId,
        getFundingSourceName,
        stripEmoji,
    };

    const result = processed.map((p) => transformProcessedServiceItem(
        p,
        refMap,
        businessProfile,
        {
            ...serviceTransformHelpers,
            item: p.item,
            scheduledStart: p.scheduledStart,
            actualEnd: p.actualEnd,
            participantName: p.participantName,
        },
    ));

    info('MonthlyStatementData', 'Fetched service items', {
        workspaceId, boardId, raw: rawItems.length, filtered: result.length
    });
    return result;
}
