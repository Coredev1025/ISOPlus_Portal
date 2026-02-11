import Item from '../models/Item.js';
import Business from '../models/Business.js';
import { getFolder } from './isoplus.js';
import { info, warn } from '../utils/logger.js';

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
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value === 'string' || typeof value === 'number') {
        const date = new Date(value);
        return isNaN(date.getTime()) ? null : date;
    }
    return null;
};

const getValue = (item, attributeName) => {
    if (!item?.data) return null;
    return item.data[attributeName] ?? null;
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

const isUuidLike = (value) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

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

const normalizeString = (value) => (value || '').toString().trim().toLowerCase().replace(/\.+$/, '');

const TRANSACTION_STATUS_USE_ACTUAL_END = 'Delivered - To be claimed and invoiced.';

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

const stripEmojiFromFundingSource = (str) =>
    (str || '').replace(/[\u{1F300}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();

const ATTRIBUTE_NAMES = {
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

const REF_ATTR = {
    PROFILE_FULL_NAME: 'Full Name/Preferred Name',
    PROFILE_PREFERRED_NAME: 'Preferred Name',
    PROFILE_MY_AGED_CARE_ID: 'My Aged Care ID Number',
    PROFILE_MY_AGED_CARE_ID_ALT: 'My Aged Care ID',
    SERVICE_PLAN_ID: 'Service Plan ID',
    SERVICE_ID_ITEM_ID: 'Service ID/  Item ID',
    SERVICE_ID_ITEM_ID_ALT: 'Service ID/Item ID',
    FS_NAME: 'Funding Stream',
    FS_DEFINITION: 'Definition'
};

const BUDGET_FOLDER_CONFIG = [
    { code: 'HSQ', folderName: 'Home Support Quarterly Budget' },
    { code: 'ATS', folderName: 'Assistive Technology - Short-term Budget' },
    { code: 'ATO', folderName: 'Assistive Technology - Ongoing Budget' },
    { code: 'HMB', folderName: 'Home Modification Budget' },
    { code: 'RCP', folderName: 'Restorative Care Pathway Budget' },
    { code: 'EOL', folderName: 'End-of-Life Pathway Budget' }
];

const BUDGET_FOLDER_NAMES = BUDGET_FOLDER_CONFIG.map(c => c.folderName).join(',');

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

const MONTH_LABEL_LOOKUP = {
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
        } catch (err) {
            return [];
        }
    }
    const folderNames = folderName.toLowerCase().split(',').map(n => n.trim());
    return folders
        .filter(f => f.name && folderNames.some(name => f.name.toLowerCase().includes(name)))
        .map(f => f.id);
};

const bulkFetchItemsFromDB = async (workspaceId, boardId, itemIds) => {
    if (!itemIds || itemIds.length === 0) return new Map();
    const uniqueIds = [...new Set(itemIds.filter(Boolean))];
    if (uniqueIds.length === 0) return new Map();

    const items = await Item.find({ workspaceId, boardId, itemId: { $in: uniqueIds } }).lean();
    const itemMap = new Map();
    for (const item of items) {
        itemMap.set(item.itemId, item);
    }

    const foundIds = new Set(items.map(i => i.itemId));
    const missingIds = uniqueIds.filter(id => !foundIds.has(id));
    if (missingIds.length > 0) {
        const crossBoardItems = await Item.find({ workspaceId, itemId: { $in: missingIds } }).lean();
        for (const item of crossBoardItems) {
            if (!itemMap.has(item.itemId)) {
                itemMap.set(item.itemId, item);
            }
        }
    }
    return itemMap;
};

const getParticipantNameFromProfile = (profileItem) => {
    if (!profileItem) return null;
    const name = getValueMulti(profileItem, [
        REF_ATTR.PROFILE_PREFERRED_NAME,
        REF_ATTR.PROFILE_FULL_NAME,
        'Full Name', 'Preferred Name', 'Name'
    ]);
    if (!name) return null;
    if (typeof name === 'object' && name !== null) {
        return name.name ? String(name.name) : String(name);
    }
    return String(name);
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

const getFundingSourceNameFromItem = (fsItem) => {
    if (!fsItem) return null;
    const name = getValueMulti(fsItem, [
        REF_ATTR.FS_NAME,
        REF_ATTR.FS_DEFINITION,
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

export async function fetchBudgetItems(workspaceId, boardId, options = {}) {
    const { participant, month, year, categoryCode } = options;

    let folders = [];
    try {
        const { folder } = await getFolder(workspaceId, boardId);
        folders = Array.isArray(folder) ? folder : [];
    } catch (err) {
        folders = [];
    }

    const folderIdToName = new Map();
    const folderIdToCode = {};
    folders.forEach(folderElement => {
        if (!folderElement?.id) return;
        const folderName = folderElement.name || '';
        folderIdToName.set(folderElement.id, folderName);
        const normalized = folderName.toLowerCase();
        const matchedConfig = BUDGET_FOLDER_CONFIG.find(cfg =>
            normalized.includes(cfg.folderName.toLowerCase())
        );
        if (matchedConfig) {
            folderIdToCode[folderElement.id] = matchedConfig.code;
        }
    });

    const folderIds = await getFolderIds(BUDGET_FOLDER_NAMES, workspaceId, boardId, folders);
    const baseQuery = { workspaceId, boardId };
    if (folderIds.length > 0) {
        baseQuery.folderId = { $in: folderIds };
    }

    const allBudgetItems = await Item.find(baseQuery).lean();

    // Resolve Primary Supplement references
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

    // Transform items
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

    // Apply filters
    let filteredItems = transformedBudgetItems;
    if (participant && participant !== 'all') {
        try {
            const participantRegex = new RegExp(participant, 'i');
            filteredItems = filteredItems.filter(item => participantRegex.test(item.participantName));
        } catch (regexErr) {
            warn('MonthlyStatementData', 'Invalid participant regex for budget filter', { pattern: participant });
        }
    }
    if (month) {
        const targetMonth = MONTH_LABEL_LOOKUP[month.padStart(2, '0')];
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

    info('MonthlyStatementData', 'Fetched budget items from DB', {
        workspaceId, boardId, totalRaw: allBudgetItems.length, filtered: filteredItems.length
    });

    return filteredItems;
}

export async function fetchServiceItems(workspaceId, boardId, options = {}) {
    const { participant, startDate, endDate } = options;

    const businessProfile = await Business.findOne({ workspaceId: workspaceId.toString() })
        .select('name')
        .lean();

    const folderIds = await getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
    const baseQuery = { workspaceId, boardId };
    if (folderIds.length > 0) {
        baseQuery.folderId = { $in: folderIds };
    }

    const allServiceItems = await Item.find(baseQuery).lean();

    // Collect participant profile IDs and bulk fetch
    const participantProfileIds = new Set();
    for (const item of allServiceItems) {
        const participantProfileValue = getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
        const ppId = extractRefId(participantProfileValue);
        if (ppId) participantProfileIds.add(ppId);
    }
    const participantProfilesMap = [...participantProfileIds].length > 0
        ? await bulkFetchItemsFromDB(workspaceId, boardId, [...participantProfileIds])
        : new Map();

    // Process items with date, participant and transaction status logic
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

    // Filter by participant
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
            warn('MonthlyStatementData', 'Invalid participant regex for service filter', { pattern: participant });
        }
    }

    // Filter by date range
    if (startDate) {
        const startDateObj = new Date(startDate);
        processedItems = processedItems.filter(p => p.filterDate && p.filterDate >= startDateObj);
    }
    if (endDate) {
        const endDateObj = new Date(endDate);
        processedItems = processedItems.filter(p => p.filterDate && p.filterDate <= endDateObj);
    }

    // Resolve service plan and funding source references
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

    // Transform to final format
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

        // Resolve service name from service plan
        let service = '';
        if (p.servicePlanId) {
            const servicePlanItem = refItemsMap.get(p.servicePlanId);
            service = getServiceFromServicePlan(servicePlanItem) || '';
        }

        // Resolve funding source
        let fundingSource = '';
        if (p.fundingSourceIds.length > 0) {
            const fundingSourceNames = [];
            for (const fsId of p.fundingSourceIds) {
                const fsItem = refItemsMap.get(fsId);
                const fsName = getFundingSourceNameFromItem(fsItem);
                if (fsName) fundingSourceNames.push(fsName);
            }
            fundingSource = fundingSourceNames.join(', ');
        }

        // Resolve service provider
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

    info('MonthlyStatementData', 'Fetched service items from DB', {
        workspaceId, boardId, totalRaw: allServiceItems.length, filtered: transformedItems.length
    });

    return transformedItems;
}
