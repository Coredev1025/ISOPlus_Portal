import Item from '../models/Item.js';
import Business from '../models/Business.js';
import { getFolder } from './isoplus.js';
import { info } from '../utils/logger.js';

const parseNumber = (value) => {
    if (value === null || value === undefined) return 0;
    if (Array.isArray(value) && value.length > 0) return parseNumber(value[0]);
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value !== 'string') return 0;

    // Handle common “negative” formats from boards/exports:
    // - parentheses: ($1,234.56)
    // - trailing minus: 1,234.56-
    // - unicode minus: −1234.56
    let s = value.trim();
    if (!s) return 0;

    // Normalize unicode minus to ASCII hyphen-minus.
    s = s.replace(/[\u2212\u2012\u2013\u2014]/g, '-');

    let negative = false;
    // Parentheses mean negative in many exports.
    if (/\(.*\)/.test(s)) {
        negative = true;
        s = s.replace(/[()]/g, '');
    }
    // Trailing minus means negative.
    if (/-\s*$/.test(s)) {
        negative = true;
        s = s.replace(/-\s*$/, '');
    }

    const cleaned = s.replace(/[^0-9.+-]/g, '');
    const parsed = parseFloat(cleaned);
    if (!Number.isFinite(parsed)) return 0;

    if (negative && parsed > 0) return -Math.abs(parsed);
    return parsed;
};

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

const ATTR = {
    SCHEDULED_START: 'Scheduled Shift Start Date & Time',
    ACTUAL_END: 'Actual Shift End Date & Time',
    PARTICIPANT_FULL_NAME: 'Participant Full Name',
    PARTICIPANT_PROFILE: 'Participant Profile',
    SERVICE_PLAN: 'Service Plan',
    SERVICE_PLAN_ID: 'Service Plan ID',
    SERVICE_CATEGORY: 'Service Category',
    UNIT: 'Unit',
    QUANTITY: 'Quantity',
    UNIT_PRICE: 'Unit Price ($)',
    TOTAL_AMOUNT: 'Total Amount ($)',
    GOV_SUBSIDY: 'Government Subsidy ($)',
    PARTICIPANT_CONTRIBUTION: 'Participant Contribution ($)',
    ADDITIONAL_NOTES: 'Additional Notes',
    TRANSACTION_STATUS: 'Transaction Status',
    FUNDING_SOURCE: 'Funding Source',
    DELIVERED_BY: 'Delivered by',
    ASSOCIATED_PROVIDER: 'Associated Provider (If Applicable)',
    COMMITTED_AT_HM: 'Committed AT-HM for Delivery',
    FULL_NAME: 'Full Name/Preferred Name'
};

const BUDGET_FOLDER_CONFIG = [
    { code: 'HSQ', folderName: 'Home Support Quarterly Budget' },
    { code: 'HSCM', folderName: 'Home Support Care Management Budget' },
    { code: 'ATS', folderName: 'Assistive Technology - Short-term Budget' },
    { code: 'ATO', folderName: 'Assistive Technology - Ongoing Budget' },
    { code: 'HMB', folderName: 'Home Modification Budget' },
    { code: 'RCP', folderName: 'Restorative Care Pathway Budget' },
    { code: 'EOL', folderName: 'End-of-Life Pathway Budget' }
];

const BUDGET_FOLDER_NAMES = BUDGET_FOLDER_CONFIG.map(c => c.folderName).join(',');

const BUDGET_FIELDS = {
    totalAvailable: [
        'Total Available Budget for Home Support ($)',
        'Total Available Fund for AT - Short-term ($)',
        'Total Available Fund for AT - Ongoing ($)',
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
        const match = BUDGET_FOLDER_CONFIG.find(cfg => name.toLowerCase().includes(cfg.folderName.toLowerCase()));
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
        // Also collect Associated Participant IDs for HSCM items
        const apId = extractRefId(getValue(item, 'Associated Participant'));
        if (apId) profileIds.add(apId);
        extractAllRefIds(getValue(item, 'Primary Supplement')).filter(isUuidLike).forEach(id => psRefIds.add(id));
    });

    const [profileMap, psMap] = await Promise.all([
        profileIds.size > 0 ? bulkFetchItems(workspaceId, boardId, [...profileIds]) : Promise.resolve(new Map()),
        psRefIds.size > 0 ? bulkFetchItems(workspaceId, boardId, [...psRefIds]) : Promise.resolve(new Map())
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

    const getMonthLabelFromDate = (dateValue) => {
        if (!dateValue) return '';
        const date = new Date(dateValue);
        if (isNaN(date.getTime())) return '';
        const monthLabels = [
            'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'
        ];
        return monthLabels[date.getMonth()] || '';
    };

    const getYearFromDate = (dateValue) => {
        if (!dateValue) return '';
        const date = new Date(dateValue);
        if (isNaN(date.getTime())) return '';
        return date.getFullYear().toString();
    };

    const budgetCategoryOrder = BUDGET_FOLDER_CONFIG.map(c => c.code);
    const getCategoryOrderIndex = (code) => {
        const normalizedCode = (code || 'HSQ').toString();
        const idx = budgetCategoryOrder.indexOf(normalizedCode);
        return idx === -1 ? budgetCategoryOrder.length : idx;
    };

    const transformed = rawItems.map(item => {
        const code = folderIdToCode[item.folderId] || 'HSQ';
        const folderName = folderIdToName.get(item.folderId) || '';
        const isCareManagement = folderName.toLowerCase().includes('home support care management budget');

        if (isCareManagement) {
            const participantProfileIdValue = getValue(item, 'Associated Participant');
            const participantProfileId = extractRefId(participantProfileIdValue);
            const participantName = resolveParticipantForHSCM(item);
            const dateValue = getValueMulti(item, ['Date']);
            const transactionTypeValue = getValueMulti(item, ['Transaction Type']);
            const receivedAmount = parseNumber(getValue(item, 'Received Amount ($)'));
            const allocatedTime = parseNumber(getValueMulti(item, ['Allocated time (Hr.)', 'Allocated Time (Hr.)']));
            const allocatedAmount = toOutflow(parseNumber(getValue(item, 'Allocated Amount ($-)')));
            const currentBalance = parseNumber(getValue(item, 'Net Movement ($)'));
            const transactionType = (() => {
                if (!transactionTypeValue) return '';
                if (typeof transactionTypeValue === 'object' && transactionTypeValue.name) return transactionTypeValue.name;
                if (typeof transactionTypeValue === 'string') return transactionTypeValue;
                return transactionTypeValue.toString ? transactionTypeValue.toString() : '';
            })();

            return {
                id: item.itemId,
                categoryCode: 'HSCM',
                folderName: folderName || 'Home Support Care Management Budget',
                participantName,
                participantProfileId: participantProfileId ? participantProfileId.toString() : null,
                month: getMonthLabelFromDate(dateValue),
                year: getYearFromDate(dateValue),
                quarter: '',
                totalAvailableBudget: receivedAmount || 0,
                availableFundStart: receivedAmount || 0,
                quarterlyAdjustment: 0,
                primarySupplementAmount: 0,
                carryoverFunding: 0,
                unspentReturned: 0,
                commonwealthUnspent: 0,
                providerUnspent: 0,
                participantUnspent: 0,
                previousMonthSpending: 0,
                deliveredAmount: allocatedAmount || 0,
                deliveredAmountRaw: allocatedAmount,
                adjustmentAmount: 0,
                remainingBalance: currentBalance,
                fundClassification: 'Care Management',
                fundAmount: 0,
                fund: '',
                committedFunds: 0,
                fundingStartDate: null,
                fundingEndDate: null,
                primarySupplementLabel: '',
                remainingBalanceEndOfMonth: currentBalance,
                remainingBalanceAllocationPeriod: 0,
                hscmDate: dateValue || null,
                hscmTransactionType: transactionType,
                hscmReceivedAmount: receivedAmount || 0,
                hscmAllocatedTime: allocatedTime || 0,
                hscmAllocatedAmount: allocatedAmount || 0,
                hscmCurrentBalance: currentBalance || 0,
                updatedAt: item.updatedAt,
                createdAt: item.createdAt,
                rawData: item.data || {}
            };
        }

        const participantProfileIdValue = getValue(item, ATTR.PARTICIPANT_PROFILE);
        const participantProfileId = extractRefId(participantProfileIdValue);
        const participantName = resolveParticipant(item);

        const monthLabel = formatStatus(getValue(item, 'Month'));
        const yearLabel = formatStatus(getValue(item, 'Year'));
        const quarterLabel = formatStatus(getValue(item, 'FY Quarter')) || '';

        const fundingStartDate = getValue(item, 'Funding Start Date');
        const fundingEndDate = getValue(item, 'Funding End Date');

        const availableFundStart = parseNumber(getValue(item, 'Available Fund at the Start of the Month ($)'));
        const quarterlyAdjustment = parseNumber(getValue(item, 'Classification Quarterly Budget Adjustment ($)'));
        const primarySupplementAmount = parseNumber(getValue(item, 'Primary Supplement ($)'));
        const carryoverFunding = parseNumber(getValue(item, 'Carryover Funding from the Previous Quarter ($)'));
        const unspentReturned = parseNumber(getValueMulti(item, [
            'Unspent Budget at the End of the Quarter – Returned ($-)',
            'Unspent Budget at the End of the Quarter - Returned ($-)'
        ]));
        const commonwealthUnspent = parseNumber(getValueMulti(item, BUDGET_FIELDS.commonwealthUnspent));
        const providerUnspent = parseNumber(getValueMulti(item, BUDGET_FIELDS.providerUnspent));
        const participantUnspent = parseNumber(getValueMulti(item, BUDGET_FIELDS.participantUnspent));
        const previousMonthSpending = parseNumber(getValue(item, 'Spending from Previous Month(s) within same Quarter ($)'));
        const previousSpendingAllocated = parseNumber(getValue(item, 'Spending from Previous Month(s) within Allocated Period ($)'));

        let totalAvailableBudget = (() => {
            if (code === 'HSQ') {
                return parseNumber(getValue(item, 'Total Available Budget for Home Support ($)'));
            }
            const totalAttrs = (() => {
                if (code === 'RCP') return ['Total Available Budget for Restorative Care ($)', 'Total Available Fund for Restorative Care ($)'];
                if (code === 'EOL') return ['Total Available Budget for End-of-Life Care ($)', 'Total Available Fund for End-of-Life Care ($)'];
                if (code === 'ATS') return ['Total Available Budget for Assistive Technology - Short-term ($)', 'Total Available Fund for AT - Short-term ($)'];
                if (code === 'ATO') return ['Total Available Budget for Assistive Technology - Ongoing ($)', 'Total Available Fund for AT Ongoing ($)'];
                if (code === 'HMB') return ['Total Available Budget for Home Modification ($)', 'Total Available Fund for HM ($)'];
                return null;
            })();
            if (totalAttrs && totalAttrs.length) {
                return parseNumber(getValueMulti(item, totalAttrs));
            }
            return 0;
        })();

        // if (!totalAvailableBudget && code === 'HSQ') {
        //     totalAvailableBudget =
        //         availableFundStart +
        //         quarterlyAdjustment +
        //         primarySupplementAmount +
        //         carryoverFunding +
        //         commonwealthUnspent +
        //         providerUnspent +
        //         participantUnspent +
        //         previousMonthSpending +
        //         unspentReturned;
        // }

        // if (!totalAvailableBudget && (code === 'RCP' || code === 'EOL')) {
        //     totalAvailableBudget = availableFundStart + primarySupplementAmount + previousSpendingAllocated;
        // }

        // if (!totalAvailableBudget && availableFundStart) {
        //     totalAvailableBudget = availableFundStart;
        // }

        const deliveredAmountRaw = (() => {
            if (code === 'ATS') {
                const minusVal =
                    getValue(item, 'AT - Short-term Delivered During the Month ($-)') ??
                    getValue(item, 'Assistive Technology - Short-term Delivered During the Month ($-)');
                if (minusVal !== null && minusVal !== undefined) return toOutflow(parseNumber(minusVal));
                return toOutflow(parseNumber(getValue(item, 'Assistive Technology - Short-term Delivered During the Month')));
            }
            if (code === 'ATO') {
                const minusVal =
                    getValue(item, 'AT - Ongoing Delivered During the Month ($-)') ??
                    getValue(item, 'Assistive Technology - Ongoing Delivered During the Month ($-)');
                if (minusVal !== null && minusVal !== undefined) return toOutflow(parseNumber(minusVal));
                return toOutflow(parseNumber(getValue(item, 'Assistive Technology - Ongoing Delivered During the Month')));
            }
            if (code === 'HMB') {
                const minusVal = getValue(item, 'Home Modification Delivered During the Month ($-)');
                if (minusVal !== null && minusVal !== undefined) return toOutflow(parseNumber(minusVal));
                return toOutflow(parseNumber(getValue(item, 'Home Modification Delivered During the Month')));
            }
            if (code === 'RCP') {
                const minusVal = getValue(item, 'Restorative Care Delivered During the Month ($-)');
                if (minusVal !== null && minusVal !== undefined) return toOutflow(parseNumber(minusVal));
                // Some boards omit ($-) in the attribute name; still treat delivered as outflow.
                return toOutflow(parseNumber(getValue(item, 'Restorative Care Delivered During the Month')));
            }
            if (code === 'EOL') {
                const minusVal = getValue(item, 'End-of-Life Care Delivered During the Month ($-)');
                if (minusVal !== null && minusVal !== undefined) return toOutflow(parseNumber(minusVal));
                return toOutflow(parseNumber(getValue(item, 'End-of-Life Care Delivered During the Month')));
            }
            // HSQ
            {
                const minusVal = getValue(item, 'Home Support Delivered During the Month ($-)');
                if (minusVal !== null && minusVal !== undefined) return toOutflow(parseNumber(minusVal));
                return toOutflow(parseNumber(getValue(item, 'Home Support Delivered During the Month')));
            }
        })();

        const adjustmentAmount = parseNumber(getValue(item, 'Adjustments from Previous Months [Charges($-)/Refund($)]'));
        const primarySupplementLabel = resolveReferenceValue(getValue(item, 'Primary Supplement'), psMap);
        const fundClassification = formatStatus(getValue(item, 'Fund Classification')) || '';
        const fundAmount = parseNumber(getValueMulti(item, ['Fund Amount ($)', 'Fund Amount($)']));
        const additionalAmountApproved = parseNumber(getValue(item, 'Additional amount approved (AT high tier) ($)'));
        const fund = formatStatus(getValue(item, 'Fund')) || '';

        const committedATShort = toOutflow(parseNumber(getValue(item, 'Committed AT Short-term Funds - to be delivered ($-)')));
        const committedATOngoing = toOutflow(parseNumber(getValue(item, 'Committed AT Ongoing Funds - to be delivered ($-)')));
        const committedHM = toOutflow(parseNumber(getValue(item, 'Committed HM Funds - to be delivered ($-)')));
        let committedFunds = 0;
        if (code === 'ATS') committedFunds = committedATShort;
        else if (code === 'ATO') committedFunds = committedATOngoing;
        else if (code === 'HMB') committedFunds = committedHM;

        const remainingEndOfMonthAttr = (() => {
            if (code === 'HSQ') return 'Remaining Home Support Balance as at the End of the Month ($)';
            if (code === 'ATS') return 'Remaining AT - Short-term Balance as at the End of the Month ($)';
            if (code === 'ATO') return 'Remaining AT - Ongoing Balance as at the End of the Month ($)';
            if (code === 'HMB') return 'Remaining HM Balance as at the End of the Month ($)';
            if (code === 'RCP' || code === 'EOL') return null;
            return 'Remaining Home Support Balance as at the End of the Month ($)';
        })();

        const remainingBalanceEndOfMonthRaw = remainingEndOfMonthAttr
            ? getValue(item, remainingEndOfMonthAttr)
            : (code === 'RCP' || code === 'EOL' ? getValue(item, 'Remaining Balance for Allocation Period ($)') : null);

        const remainingBalanceEndOfMonth = (remainingBalanceEndOfMonthRaw !== null && remainingBalanceEndOfMonthRaw !== undefined)
            ? parseNumber(remainingBalanceEndOfMonthRaw)
            : 0;

        let remainingBalanceAllocationPeriod = null;
        if (code === 'ATS' || code === 'ATO' || code === 'HMB') {
            const allocationAttr = code === 'ATS'
                ? 'Remaining AT - Short-term Balance for Allocation Period ($)'
                : code === 'ATO'
                    ? 'Remaining AT - Ongoing Balance for Allocation Period ($)'
                    : 'Remaining HM Balance for Allocation Period ($)';
            const allocationRaw = getValue(item, allocationAttr);
            remainingBalanceAllocationPeriod = (allocationRaw !== null && allocationRaw !== undefined)
                ? parseNumber(allocationRaw)
                : 0;
        }

        const effectiveRemainingBalance = (code === 'ATS' || code === 'ATO' || code === 'HMB')
            ? remainingBalanceAllocationPeriod
            : remainingBalanceEndOfMonth;

        return {
            id: item.itemId,
            folderName,
            categoryCode: code,
            participantName,
            participantProfileId: participantProfileId ? participantProfileId.toString() : null,
            month: monthLabel,
            year: yearLabel,
            quarter: quarterLabel,
            fundingStartDate,
            fundingEndDate,
            totalAvailableBudget,
            availableFundStart,
            quarterlyAdjustment,
            primarySupplementAmount,
            carryoverFunding,
            unspentReturned,
            commonwealthUnspent,
            providerUnspent,
            participantUnspent,
            previousMonthSpending,
            deliveredAmount: deliveredAmountRaw || 0,
            deliveredAmountRaw,
            adjustmentAmount,
            remainingBalance: effectiveRemainingBalance,
            remainingBalanceEndOfMonth,
            ...(remainingBalanceAllocationPeriod !== null && { remainingBalanceAllocationPeriod }),
            primarySupplementLabel,
            fundClassification,
            fundAmount,
            additionalAmountApproved,
            fund,
            committedFunds,
            fundingStreamId: getValue(item, 'Funding Stream'),
            updatedAt: item.updatedAt,
            createdAt: item.createdAt,
            rawData: item.data || {}
        };
    });

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

    const businessProfile = await Business.findOne({ workspaceId: workspaceId.toString() }).select('name').lean();

    const folderIds = await getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
    const query = { workspaceId, boardId };
    if (folderIds.length) query.folderId = { $in: folderIds };

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

    let processed = rawItems.map(item => {
        const scheduledStart = getValue(item, ATTR.SCHEDULED_START);
        const actualEnd = getValue(item, ATTR.ACTUAL_END);
        const statusFormatted = formatStatus(getValue(item, ATTR.TRANSACTION_STATUS));
        const useActualEnd = normalizeString(statusFormatted) === normalizeString(DELIVERED_STATUS);
        const scheduledStartDate = parseDate(scheduledStart);
        const actualEndDate = parseDate(actualEnd);
        const statusNorm = normalizeString(statusFormatted);

        const profileValue = getValue(item, ATTR.PARTICIPANT_PROFILE);
        const profileId = extractRefId(profileValue);
        let participantName = profileId ? (getParticipantName(profileMap.get(profileId)) || '') : '';
        if (!participantName) participantName = getValue(item, ATTR.PARTICIPANT_FULL_NAME) || '';

        const fundingSourceIds = extractAllRefIds(getValue(item, ATTR.FUNDING_SOURCE));
        const fundingSourceResolvedBase = fundingSourceIds.length
            ? fundingSourceIds.map(id => getFundingSourceName(fundingSourceMap.get(id))).filter(Boolean).join(', ')
            : '';

        return {
            item, scheduledStartDate, actualEndDate,
            scheduledStart,
            actualEnd,
            filterDate: (() => {
                if (useActualEnd) return actualEndDate;
                const isAdjustmentLike = statusNorm.includes('adjust') || statusNorm.includes('refund') || statusNorm.includes('charge');
                if (isAdjustmentLike) {
                    return scheduledStartDate || actualEndDate || (item.updatedAt ? new Date(item.updatedAt) : null) || (item.createdAt ? new Date(item.createdAt) : null);
                }
                return scheduledStartDate;
            })(),
            participantName: String(participantName),
            profileValue,
            statusFormatted: statusFormatted || '',
            servicePlanId: extractRefId(getValue(item, ATTR.SERVICE_PLAN)),
            fundingSourceIds,
            fundingSourceResolvedBase
        };
    });

    if (participantParam && participantParam !== 'all') {
        try {
            const re = new RegExp(participantParam, 'i');
            processed = processed.filter(p =>
                re.test(p.participantName) ||
                (p.profileValue && (
                    (typeof p.profileValue === 'string' && re.test(p.profileValue)) ||
                    (Array.isArray(p.profileValue) && p.profileValue.some(v => re.test(String(v)))) ||
                    (typeof p.profileValue === 'object' && p.profileValue.id && re.test(String(p.profileValue.id)))
                ))
            );
        } catch { /* invalid regex */ }
    }

    if (startDate) {
        const d = new Date(startDate);
        processed = processed.filter(p => p.filterDate && p.filterDate >= d);
    }
    if (endDate) {
        const d = new Date(endDate);
        processed = processed.filter(p => p.filterDate && p.filterDate <= d);
    }

    if (transactionStatusFilter && transactionStatusFilter.toLowerCase() !== 'all') {
        const v = transactionStatusFilter.trim();
        processed = processed.filter(p => p.statusFormatted === v);
    }

    if (fundingSourceFilter && fundingSourceFilter !== 'all') {
        const fv = fundingSourceFilter.trim();
        processed = processed.filter(p => {
            return p.fundingSourceResolvedBase && p.fundingSourceResolvedBase === fv;
        });
    }

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

    const result = processed.map(p => {
        const item = p.item;
        const committedAtHm = getValue(item, ATTR.COMMITTED_AT_HM);

        const servicePlanItem = p.servicePlanId ? refMap.get(p.servicePlanId) : null;
        const service = getServiceFromServicePlan(servicePlanItem) || '';

        // Delivered By + Service Provider (single computation for both)
        const deliveredByRaw = getValue(item, ATTR.DELIVERED_BY);
        const deliveredByName = deliveredByRaw == null
            ? null
            : (typeof deliveredByRaw === 'object' ? (deliveredByRaw.name || deliveredByRaw.toString()) : String(deliveredByRaw));
        let serviceProvider = undefined;
        if (deliveredByName && typeof deliveredByName === 'string') {
            const deliveredByLower = deliveredByName.toLowerCase();
            if (deliveredByLower.includes('company workforce')) {
                serviceProvider = businessProfile?.name || undefined;
            } else if (deliveredByLower.includes('associated')) {
                const apRefId = extractRefId(getValue(item, ATTR.ASSOCIATED_PROVIDER));
                const providerRefItem = apRefId ? refMap.get(apRefId) : null;
                const businessIndividual = providerRefItem ? getValueFromFlatData(providerRefItem, 'Business/Individual') : null;
                serviceProvider = (businessIndividual != null && businessIndividual !== '')
                    ? (typeof businessIndividual === 'object' && businessIndividual.name ? businessIndividual.name : String(businessIndividual))
                    : (apRefId || undefined);
            }
        }

        // Funding source names (with special case for Primary Supplement / Unspent HCP)
        const serviceCategoryRaw = servicePlanItem ? getValueFromFlatData(servicePlanItem, ['Service Category', ATTR.SERVICE_CATEGORY]) : null;
        const serviceCategory = serviceCategoryRaw
            ? (typeof serviceCategoryRaw === 'object' && serviceCategoryRaw.name ? serviceCategoryRaw.name : String(serviceCategoryRaw).trim())
            : '';

        let fundingSource;
        if (p.fundingSourceIds.length) {
            const names = [];
            for (const fsId of p.fundingSourceIds) {
                let fsName = getFundingSourceName(refMap.get(fsId));
                if (fsName) {
                    if (serviceCategory && isPrimarySupplementOrUnspentHcp(fsName)) {
                        fsName = `${fsName} - ${stripEmoji(serviceCategory)}`;
                    }
                    names.push(fsName);
                }
            }
            fundingSource = names.length ? names.join(', ') : undefined;
        }

        const scheduledStart = p.scheduledStart || null;
        const actualEnd = p.actualEnd || null;
        const notes = getValue(item, ATTR.ADDITIONAL_NOTES) || '';
        const allocatedTimeValue = getValueMulti(item, ['Allocated time (Hr.)', 'Allocated Time (Hr.)']);
        const allocatedTime = allocatedTimeValue !== null && allocatedTimeValue !== undefined
            ? (typeof allocatedTimeValue === 'number' ? allocatedTimeValue : Number(allocatedTimeValue) || 0)
            : undefined;

        return {
            id: item.itemId,
            participant: p.participantName,
            service,
            serviceProvider,
            deliveredBy: deliveredByName,
            updatedAt: item.updatedAt,
            createdAt: item.createdAt,
            scheduledStart,
            scheduledServiceDate: scheduledStart,
            scheduledShiftStart: scheduledStart,
            scheduledShiftStartDateTime: scheduledStart,
            actualEnd,
            actualShiftEndDateTime: actualEnd,
            serviceDeliveryDate: actualEnd,
            transactionStatus: formatStatus(getValue(item, ATTR.TRANSACTION_STATUS)),
            committedAtHmForDelivery: committedAtHm !== null && committedAtHm !== undefined
                ? (typeof committedAtHm === 'number' ? committedAtHm : Number(committedAtHm) || 0)
                : undefined,
            unit: getValue(item, ATTR.UNIT) || 'Hour',
            quantity: Number(getValue(item, ATTR.QUANTITY)) || 0,
            unitPrice: Number(getValue(item, ATTR.UNIT_PRICE)) || 0,
            totalAmount: Number(getValue(item, ATTR.TOTAL_AMOUNT)) || 0,
            govSubsidy: Number(getValue(item, ATTR.GOV_SUBSIDY)) || 0,
            participantContribution: Number(getValue(item, ATTR.PARTICIPANT_CONTRIBUTION)) || 0,
            fundingSource,
            notes,
            allocatedTime
        };
    });

    info('MonthlyStatementData', 'Fetched service items', {
        workspaceId, boardId, raw: rawItems.length, filtered: result.length
    });
    return result;
}
