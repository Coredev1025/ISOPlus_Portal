import Item from '../models/Item.js';
import Business from '../models/Business.js';
import { getFolder } from './isoplus.js';
import { info } from '../utils/logger.js';

const parseNumber = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
        const parsed = parseFloat(value.replace(/[^0-9.-]/g, ''));
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
};

const parseDate = (value) => {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
};

const getValue = (item, attr) => item?.data?.[attr] ?? null;

const getValueMulti = (item, attrs) => {
    if (!item?.data) return null;
    for (const a of (Array.isArray(attrs) ? attrs : [attrs])) {
        if (item.data[a] != null) return item.data[a];
    }
    return null;
};

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
    for (const key of ['Funding Stream', 'Name', 'Full Name/Preferred Name', 'Definition']) {
        const val = refItem.data[key];
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
            folders = folder || [];
        } catch { return []; }
    }
    const names = folderName.toLowerCase().split(',').map(n => n.trim());
    return folders.filter(f => f.name && names.some(n => f.name.toLowerCase().includes(n))).map(f => f.id);
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
    const name = getValueMulti(profileItem, ['Preferred Name', 'Full Name/Preferred Name', 'Full Name', 'Name']);
    if (!name) return null;
    return (typeof name === 'object' && name.name) ? String(name.name) : String(name);
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
    const name = getValueMulti(fsItem, ['Funding Stream', 'Definition', ATTR.FULL_NAME]);
    if (!name) return null;
    const raw = (typeof name === 'object' && name.name) ? String(name.name).trim() : String(name).trim();
    return stripEmoji(raw) || null;
};

export async function fetchBudgetItems(workspaceId, boardId, options = {}) {
    const { participant, month, year, categoryCode } = options;

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
        psRefIds.size > 0
            ? Item.find({ workspaceId, boardId, itemId: { $in: [...psRefIds] } }).lean()
                .then(items => new Map(items.map(e => [e.itemId, e])))
            : Promise.resolve(new Map())
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

    const transformed = rawItems.map(item => {
        const code = folderIdToCode[item.folderId] || 'HSQ';
        const folderName = folderIdToName.get(item.folderId) || '';
        const isCareManagement = code === 'HSCM' || folderName.toLowerCase().includes('home support care management budget');

        if (isCareManagement) {
            const participantName = resolveParticipantForHSCM(item);
            const dateValue = getValueMulti(item, ['Date']);
            const transactionTypeValue = getValueMulti(item, ['Transaction Type']);
            const receivedAmount = parseNumber(getValue(item, 'Received Amount ($)'));
            const allocatedTime = parseNumber(getValue(item, 'Allocated Time (Hr.)'));
            const allocatedAmount = parseNumber(getValue(item, 'Allocated Amount ($-)'));
            const currentBalanceValue = parseNumber(getValue(item, 'Current Balance ($)'));
            const currentBalance = (Number.isFinite(currentBalanceValue) && currentBalanceValue !== 0)
                ? currentBalanceValue
                : (receivedAmount || 0) + (allocatedAmount || 0);
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
                remainingBalance: Math.max(0, currentBalance),
                fundClassification: 'Care Management',
                fundAmount: 0,
                fund: '',
                committedFunds: 0,
                fundingStartDate: null,
                fundingEndDate: null,
                primarySupplementLabel: '',
                primarySupplementValue: '',
                remainingBalanceEndOfMonth: Math.max(0, currentBalance),
                remainingBalanceAllocationPeriod: 0,
                hscmDate: dateValue || null,
                hscmTransactionType: transactionType,
                hscmReceivedAmount: receivedAmount || 0,
                hscmAllocatedTime: allocatedTime || 0,
                hscmAllocatedAmount: allocatedAmount || 0,
                hscmCurrentBalance: currentBalance || 0,
                rawData: item.data || {}
            };
        }

        return {
            id: item.itemId,
            folderName,
            categoryCode: code,
            participantName: resolveParticipant(item),
            month: formatStatus(getValue(item, 'Month')),
            year: formatStatus(getValue(item, 'Year')),
            quarter: formatStatus(getValue(item, 'FY Quarter')) || '',
            totalAvailableBudget: parseNumber(getValueMulti(item, BUDGET_FIELDS.totalAvailable)),
            deliveredAmount: parseNumber(getValueMulti(item, BUDGET_FIELDS.delivered)),
            adjustmentAmount: parseNumber(getValue(item, 'Adjustments from Previous Months [Charges($-)/Refund($)]')),
            remainingBalance: parseNumber(getValueMulti(item, BUDGET_FIELDS.remaining)),
            availableFundStart: parseNumber(getValue(item, 'Available Fund at the Start of the Month ($)')),
            quarterlyAdjustment: parseNumber(getValue(item, 'Classification Quarterly Budget Adjustment ($)')),
            primarySupplementAmount: parseNumber(getValue(item, 'Primary Supplement ($)')),
            carryoverFunding: parseNumber(getValue(item, 'Carryover Funding from the Previous Quarter ($)')),
            unspentReturned: parseNumber(getValueMulti(item, [
                'Unspent Budget at the End of the Quarter \u2013 Returned ($-)',
                'Unspent Budget at the End of the Quarter - Returned ($-)'
            ])),
            commonwealthUnspent: parseNumber(getValueMulti(item, BUDGET_FIELDS.commonwealthUnspent)),
            providerUnspent: parseNumber(getValueMulti(item, BUDGET_FIELDS.providerUnspent)),
            participantUnspent: parseNumber(getValueMulti(item, BUDGET_FIELDS.participantUnspent)),
            previousMonthSpending: parseNumber(getValueMulti(item, BUDGET_FIELDS.previousMonthSpending)),
            fundAmount: parseNumber(getValue(item, 'Fund Amount ($)')),
            fundClassification: formatStatus(getValue(item, 'Fund Classification')) || '',
            primarySupplementLabel: resolveReferenceValue(getValue(item, 'Primary Supplement'), psMap),
            fundingStartDate: getValue(item, 'Funding Start Date'),
            fundingEndDate: getValue(item, 'Funding End Date'),
            fund: formatStatus(getValue(item, 'Fund')) || '',
            committedFunds: parseNumber(getValue(item, 'Committed AT Short-term Funds - to be delivered ($-)')) +
                parseNumber(getValue(item, 'Committed AT Ongoing Funds - to be delivered ($-)')) +
                parseNumber(getValue(item, 'Committed HM Funds - to be delivered ($-)')),
            remainingBalanceEndOfMonth: parseNumber(getValueMulti(item, BUDGET_FIELDS.remaining)),
            remainingBalanceAllocationPeriod: parseNumber(getValueMulti(item, BUDGET_FIELDS.remainingAllocationPeriod)),
            rawData: item.data || {}
        };
    });

    let result = transformed;
    if (participant && participant !== 'all') {
        try {
            const re = new RegExp(participant, 'i');
            result = result.filter(i => re.test(i.participantName));
        } catch { /* invalid regex */ }
    }
    if (month) {
        const target = MONTH_LABELS[month.padStart(2, '0')];
        if (target) result = result.filter(i => i.month?.toLowerCase() === target.toLowerCase());
    }
    if (year) result = result.filter(i => i.year === year);
    if (categoryCode) result = result.filter(i => i.categoryCode === categoryCode);

    info('MonthlyStatementData', 'Fetched budget items', {
        workspaceId, boardId, raw: rawItems.length, filtered: result.length
    });
    return result;
}

export async function fetchServiceItems(workspaceId, boardId, options = {}) {
    const { participant, startDate, endDate, transactionStatusFilter, fundingSourceFilter } = options;

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

    let processed = rawItems.map(item => {
        const scheduledStart = getValue(item, ATTR.SCHEDULED_START);
        const actualEnd = getValue(item, ATTR.ACTUAL_END);
        const statusFormatted = formatStatus(getValue(item, ATTR.TRANSACTION_STATUS));
        const useActualEnd = normalizeString(statusFormatted) === normalizeString(DELIVERED_STATUS);
        const scheduledStartDate = parseDate(scheduledStart);
        const actualEndDate = parseDate(actualEnd);

        const profileValue = getValue(item, ATTR.PARTICIPANT_PROFILE);
        const profileId = extractRefId(profileValue);
        let participantName = profileId ? (getParticipantName(profileMap.get(profileId)) || '') : '';
        if (!participantName) participantName = getValue(item, ATTR.PARTICIPANT_FULL_NAME) || '';

        return {
            item, scheduledStartDate, actualEndDate,
            filterDate: useActualEnd ? actualEndDate : scheduledStartDate,
            participantName: String(participantName),
            profileValue,
            statusFormatted: statusFormatted || '',
            servicePlanId: extractRefId(getValue(item, ATTR.SERVICE_PLAN)),
            fundingSourceIds: extractAllRefIds(getValue(item, ATTR.FUNDING_SOURCE))
        };
    });

    if (participant && participant !== 'all') {
        try {
            const re = new RegExp(participant, 'i');
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

    const spIds = new Set();
    const fsIds = new Set();
    for (const p of processed) {
        if (p.servicePlanId) spIds.add(p.servicePlanId);
        p.fundingSourceIds.forEach(id => { if (id) fsIds.add(id); });
    }
    const refMap = await bulkFetchItems(workspaceId, boardId, [...spIds, ...fsIds]);

    if (fundingSourceFilter && fundingSourceFilter !== 'all') {
        const fv = fundingSourceFilter.trim();
        processed = processed.filter(p => {
            if (!p.fundingSourceIds.length) return false;
            const resolved = p.fundingSourceIds.map(id => getFundingSourceName(refMap.get(id))).filter(Boolean).join(', ');
            return resolved === fv;
        });
    }

    const result = processed.map(p => {
        const item = p.item;
        const actualEnd = getValue(item, ATTR.ACTUAL_END);
        const scheduledStart = getValue(item, ATTR.SCHEDULED_START);
        const committedAtHm = getValue(item, ATTR.COMMITTED_AT_HM);

        let service = '';
        if (p.servicePlanId) service = getServiceName(refMap.get(p.servicePlanId)) || '';

        let fundingSource = '';
        if (p.fundingSourceIds.length) {
            fundingSource = p.fundingSourceIds.map(id => getFundingSourceName(refMap.get(id))).filter(Boolean).join(', ');
        }

        let serviceProvider = businessProfile?.name || '';
        const deliveredBy = getValue(item, ATTR.DELIVERED_BY);
        if (deliveredBy) {
            const name = typeof deliveredBy === 'object' ? deliveredBy.name : String(deliveredBy);
            if (name?.toLowerCase()?.includes('associated')) {
                const ap = getValue(item, ATTR.ASSOCIATED_PROVIDER);
                serviceProvider = ap ? ((typeof ap === 'object') ? ap.name : String(ap)) : '';
            }
        }

        return {
            id: item.itemId,
            participant: p.participantName,
            service,
            serviceProvider,
            deliveredBy: deliveredBy ? (typeof deliveredBy === 'object' ? deliveredBy.name : String(deliveredBy)) : '',
            scheduledServiceDate: scheduledStart || null,
            serviceDeliveryDate: actualEnd || null,
            transactionStatus: formatStatus(getValue(item, ATTR.TRANSACTION_STATUS)),
            committedAtHmForDelivery: committedAtHm != null
                ? (typeof committedAtHm === 'number' ? committedAtHm : Number(committedAtHm) || 0)
                : undefined,
            unit: getValue(item, ATTR.UNIT) || 'Hour',
            quantity: parseNumber(getValue(item, ATTR.QUANTITY)),
            unitPrice: parseNumber(getValue(item, ATTR.UNIT_PRICE)),
            totalAmount: parseNumber(getValue(item, ATTR.TOTAL_AMOUNT)),
            govSubsidy: parseNumber(getValue(item, ATTR.GOV_SUBSIDY)),
            participantContribution: parseNumber(getValue(item, ATTR.PARTICIPANT_CONTRIBUTION)),
            fundingSource,
            notes: getValue(item, ATTR.ADDITIONAL_NOTES) || ''
        };
    });

    info('MonthlyStatementData', 'Fetched service items', {
        workspaceId, boardId, raw: rawItems.length, filtered: result.length
    });
    return result;
}
