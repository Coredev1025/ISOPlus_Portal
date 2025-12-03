import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Item from '../models/Item.js';
import Business from '../models/Business.js';
import { info, error, warn, extractContextFromReq } from '../utils/logger.js';
import { getItemValues, getFolder, getMember, getMonthlyStatementBudgetData, getAgeCareParticipantsServicePlanReferencedItems } from '../services/isoplus.js';
import { RateLimiter, batchProcess } from '../utils/helpers.js';

const router = express.Router();

const ATTRIBUTE_NAMES = {
    SCHEDULED_START: 'Scheduled Shift Start Date & Time',
    ACTUAL_START: 'Actual Shift Start Date & Time',
    ACTUAL_END: 'Actual Shift End Date & Time',
    PARTICIPANT_FULL_NAME: 'Participant Full Name',
    WORKER_PLANNER: 'Worker/Planner',
    DELIVERED_BY: 'Delivered by',
    ASSOCIATED_PROVIDER: 'Associated Provider (If Applicable)',
    SERVICE_PROVIDER: 'Service Provider',
    UNIT: 'Unit',
    QUANTITY: 'Quantity',
    UNIT_PRICE: 'Unit Price ($)',
    TOTAL_AMOUNT: 'Total Amount ($)',
    GOV_SUBSIDY: 'Government Subsidy ($)',
    PARTICIPANT_CONTRIBUTION: 'Participant Contribution ($)',
    SERVICE_PLAN: 'Service Plan',
    SERVICE_PLAN_ID: 'Service Plan ID',
    SERVICE_CATEGORY: 'Service Category',
    TASK_NAME: 'Task Name',
    ADDITIONAL_NOTES: 'Additional Notes',
    TRANSACTION_STATUS: 'Transaction Status',
    FUNDING_SOURCE: 'Funding Source',
    PARTICIPANT_PROFILE: 'Participant Profile',
    FULL_NAME: 'Full Name/Preferred Name',
    ADDRESS: 'Address',
    SUBURB: 'Suburb',
    POSTCODE: 'Postcode',
    POST_CODE: 'Post Code',
    STATE: 'State',
    MY_AGED_CARE_ID: 'My Aged Care ID Number',
    MY_AGED_CARE_ID_ALT: 'My Aged Care ID',
    PROVIDER_ID: 'Provider ID',
    COMMITTED_AT_HM: 'Committed AT-HM for Delivery',
    FUNDING_STREAM: 'Funding Stream',
    YEAR_LABEL: 'Year',
    FY_QUARTER: 'FY Quarter',
    QUARTERLY_BUDGET: 'Quarterly Budget ($)',
    AVAILABLE_FUND_START: 'Available Fund at the Start of the Month ($)',
    QUARTERLY_ADJUSTMENT: 'Classification Quarterly Budget Adjustment ($)',
    PRIMARY_SUPPLEMENT_AMOUNT: 'Primary Supplement ($)',
    CARRYOVER_FUNDING: 'Carryover Funding from the Previous Quarter ($)',
    UNSPENT_BUDGET_RETURNED: 'Unspent Budget at the End of the Quarter – Returned ($-)',
    COMMONWEALTH_UNSPENT_FUNDS: [
        'Unspent HCP Funds - Commonwealth Portion (Provider-held) ($)',
        'Commonwealth-held HCP Unspent Funds ($)'
    ],
    PROVIDER_UNSPENT_FUNDS: [
        'Commonwealth-held HCP Unspent Funds (Notional Home Care Account) ($)',
        'Provider-held HCP Unspent Funds ($)'
    ],
    PARTICIPANT_UNSPENT_FUNDS: [
        'Unspent HCP Funds - Participant Portion (Provider-held) ($)',
        'Participant Portion HCP Unspent Funds ($)'
    ],
    PREVIOUS_MONTH_SPENDING: 'Spending from Previous Month(s) within same Quarter ($)',
    MONTH_LABEL: 'Month',
    FUNDING_START_DATE: 'Funding Start Date',
    FUNDING_END_DATE: 'Funding End Date',
    FUND_CLASSIFICATION: 'Fund Classification',
    FUND_AMOUNT: 'Fund Amount ($)',
    TOTAL_AVAILABLE_HOME_SUPPORT: 'Total Available Budget for Home Support ($)',
    FUND_TEXT: 'Fund',
    HOME_SUPPORT_DELIVERED: 'Home Support Delivered During the Month ($-)',
    HOME_SUPPORT_ADJUSTMENTS: 'Adjustments from Previous Months [Charges($-)/Refund($)]',
    REMAINING_HOME_SUPPORT_BALANCE: 'Remaining Home Support Balance as at the End of the Month ($)',
    COMMITTED_AT_SHORT_TERM: 'Committed AT Short-term Funds - to be delivered ($-)',
    COMMITTED_AT_ONGOING: 'Committed AT Ongoing Funds - to be delivered ($-)',
    COMMITTED_HOME_MODIFICATION: 'Committed HM Funds - to be delivered ($-)',
    ITEM_OR_WRAPAROUND: 'Item or Wraparound',
    ITEM_DESCRIPTION_CODE: 'Item Description Code',
    ITEM_DESCRIPTION: 'Item Description',
    WRAPAROUND_DESCRIPTION_CODE: 'Wraparound Description Code',
    DELIVERED_BY_THIRD_PARTY: 'Delivered By Third Party',
    LOANED_BY_ORGANISATION_NAME: 'Loaned by Organisation Name',
    PAYMENT_STATUS: 'Payment Status',
    INVOICE_NUMBER: 'Generated Invoice Number'
};

const FUNDING_SOURCE_TYPES = {
    HOME_SUPPORT: 'Home Support Quarterly Budget',
    RESTORATIVE_CARE: 'Restorative Care Pathway Budget',
    END_OF_LIFE: 'End-of-Life Pathway Budget',
    ASSISTIVE_TECH_SHORT: 'Assistive Technology - Short-term Budget',
    ASSISTIVE_TECH_ONGOING: 'Assistive Technology - Ongoing Budget',
    HOME_MODIFICATION: 'Home Modification Budget'
};

const BUDGET_CATEGORY_CONFIG = [
    { code: 'HSQ', folderName: FUNDING_SOURCE_TYPES.HOME_SUPPORT, profileKey: 'homeSupport' },
    { code: 'ATS', folderName: FUNDING_SOURCE_TYPES.ASSISTIVE_TECH_SHORT, profileKey: 'assistiveTechShortTerm' },
    { code: 'ATO', folderName: FUNDING_SOURCE_TYPES.ASSISTIVE_TECH_ONGOING, profileKey: 'assistiveTechOngoing' },
    { code: 'HMB', folderName: FUNDING_SOURCE_TYPES.HOME_MODIFICATION, profileKey: 'homeModification' },
    { code: 'RCP', folderName: FUNDING_SOURCE_TYPES.RESTORATIVE_CARE, profileKey: 'restorativeCare' },
    { code: 'EOL', folderName: FUNDING_SOURCE_TYPES.END_OF_LIFE, profileKey: 'endOfLife' }
];

const BUDGET_CATEGORY_ORDER = BUDGET_CATEGORY_CONFIG.map(config => config.code);

const DELIVERED_BY_TYPES = {
    COMPANY_WORKFORCE: 'company workforce',
    ASSOCIATED_PROVIDERS: 'associated providers'
};

// Rate limiter instance for API calls with more conservative settings to prevent 429 errors
const rateLimiter = new RateLimiter({
    batchSize: 2, // Process 2 requests at a time (reduced from 3)
    delayBetweenBatches: 600, // 600ms delay between batches (increased from 300ms)
    delayBetweenRequests: 150, // 150ms delay between individual requests in a batch
    maxRetries: 5, // Increased from 3
    retryDelay: 2500 // Start with 2.5 seconds delay (increased from 1.5 seconds)
});

// Wrapper for getItemValues with rate limiting and retry logic
const getItemValuesWithRateLimit = async (workspaceId, boardId, itemId) => {
    return rateLimiter.executeWithRetry(
        () => getItemValues(workspaceId, boardId, itemId),
        { workspaceId, boardId, itemId }
    );
};

const getFolderIds = async (folderName, workspaceId, boardId, providedFolders = null) => {
    let folders = providedFolders;

    if (!Array.isArray(folders)) {
        const { folder } = await getFolder(workspaceId, boardId);
        folders = folder || [];
    }

    let folderids = [], folderNames = folderName.toLowerCase().split(',');

    if (folders && folders.length > 0) {
        try {
            const filteredFolders = await Promise.all(
                folders.map(async folderElement => {
                    const matchesName = folderNames.some(name =>
                        folderElement.name.toLowerCase().includes(name)
                    );
                    return matchesName ? folderElement : null;
                })
            );

            folderids = filteredFolders
                .filter(folder => folder !== null)
                .map(folder => folder.id);

            return folderids || [];
        } catch (folderError) {
            error('Items-Service', 'Error processing folders', {
                message: folderError.message
            });
            return [];
        }
    } else {
        return [];
    }
}

router.get('/:workspaceId/:boardId/invoice-generator/participants', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        
        if (!workspaceId || !boardId) {
            return res.status(400).json({
                message: 'WorkspaceId and boardId are required'
            });
        }

        // Build aggregation pipeline to get distinct participant names
        const pipeline = [];

        // Base match - only from Master Plan,Shift Planning and Reporting
        const baseMatch = { workspaceId, boardId };
        const folderIds = await getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
        if (folderIds && folderIds.length > 0) {
            baseMatch.folderId = { $in: folderIds };
        }
        pipeline.push({ $match: baseMatch });

        // Extract participant name
        pipeline.push({
            $addFields: {
                participantVal: { 
                    $arrayElemAt: [{ 
                        $filter: { 
                            input: "$data.values", 
                            as: "v", 
                            cond: { $eq: ["$$v.attribute.name", "Participant Full Name"] } 
                        } 
                    }, 0] 
                }
            }
        });

        pipeline.push({
            $addFields: {
                participantName: { $ifNull: ["$participantVal.data", null] }
            }
        });

        // Filter out null/empty participant names
        pipeline.push({
            $match: {
                participantName: { $ne: null, $ne: "", $exists: true }
            }
        });

        // Group by participant name to get distinct values
        pipeline.push({
            $group: {
                _id: "$participantName"
            }
        });

        // Project to clean format
        pipeline.push({
            $project: {
                _id: 0,
                participant: "$_id"
            }
        });

        // Sort alphabetically
        pipeline.push({
            $sort: { participant: 1 }
        });

        const result = await Item.aggregate(pipeline, { 
            allowDiskUse: true,
            batchSize: 1000,
            maxTimeMS: 30000 // 30 second timeout
        });

        const participants = result.map(item => item.participant).filter(p => p && p.trim() !== '');

        res.status(200).json({
            participants: participants
        });
    } catch (err) {
        error('Items-Service', 'Failed to fetch invoice generator participants', {
            message: err.message,
            workspaceId,
            boardId
        }, extractContextFromReq(req));
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/:workspaceId/:boardId/monthly-statement/participants', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        
        if (!workspaceId || !boardId) {
            return res.status(400).json({
                message: 'WorkspaceId and boardId are required'
            });
        }

        // Build aggregation pipeline to get distinct participant names
        const pipeline = [];

        // Base match - only from Master Plan,Shift Planning and Reporting
        const baseMatch = { workspaceId, boardId };
        const folderIds = await getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
        if (folderIds && folderIds.length > 0) {
            baseMatch.folderId = { $in: folderIds };
        }
        pipeline.push({ $match: baseMatch });

        // Extract participant name
        pipeline.push({
            $addFields: {
                participantVal: { 
                    $arrayElemAt: [{ 
                        $filter: { 
                            input: "$data.values", 
                            as: "v", 
                            cond: { $eq: ["$$v.attribute.name", ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME] } 
                        } 
                    }, 0] 
                }
            }
        });

        pipeline.push({
            $addFields: {
                participantName: { $ifNull: ["$participantVal.data", null] }
            }
        });

        // Filter out null/empty participant names
        pipeline.push({
            $match: {
                participantName: { $ne: null, $ne: "", $exists: true }
            }
        });

        // Group by participant name to get distinct values
        pipeline.push({
            $group: {
                _id: "$participantName"
            }
        });

        // Project to clean format
        pipeline.push({
            $project: {
                _id: 0,
                participant: "$_id"
            }
        });

        // Sort alphabetically
        pipeline.push({
            $sort: { participant: 1 }
        });

        const result = await Item.aggregate(pipeline, { 
            allowDiskUse: true,
            batchSize: 1000,
            maxTimeMS: 30000 // 30 second timeout
        });

        const participants = result.map(item => item.participant).filter(p => p && p.trim() !== '');

        res.status(200).json({
            participants: participants
        });
    } catch (err) {
        error('Items-Service', 'Failed to fetch monthly statement participants', {
            message: err.message,
            workspaceId,
            boardId
        }, extractContextFromReq(req));
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/:workspaceId/:boardId/invoice-generator', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        const {
            status = '',
            participant = '',
            startDate,
            endDate,
            serviceDeliveryStart,
            serviceDeliveryEnd,
            transactionStatus: transactionStatusFilter = '',
            paymentStatus: paymentStatusFilter = '',
            page = 1,
            limit: limitParam,
            sortBy = 'scheduledServiceDate',
            sortOrder = 'asc'
        } = req.query;

        if (!workspaceId || !boardId) {
            return res.status(400).json({
                message: 'WorkspaceId and boardId are required'
            });
        }

        // Calculate pagination
        const hasLimitParam = limitParam !== undefined && limitParam !== null && limitParam !== '';
        let limitNumber = null;
        let applyPagination = false;
        if (hasLimitParam) {
            const limitValue = limitParam.toString().toLowerCase();
            if (limitValue !== 'all') {
                const parsedLimit = parseInt(limitParam, 10);
                if (!isNaN(parsedLimit) && parsedLimit > 0) {
                    limitNumber = parsedLimit;
                    applyPagination = true;
                }
            }
        }
        const pageNumber = applyPagination
            ? (parseInt(page, 10) > 0 ? parseInt(page, 10) : 1)
            : 1;
        const skip = applyPagination && limitNumber
            ? (pageNumber - 1) * limitNumber
            : 0;

        // STABLE VERSION: Use find() instead of aggregate() for better stability
        // Base query - only from Master Plan,Shift Planning and Reporting
        const baseQuery = { workspaceId, boardId };
        const folderIds = await getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
        if (folderIds && folderIds.length > 0) {
            baseQuery.folderId = { $in: folderIds };
        }

        // Fetch all items matching base criteria using stable find() query
        let allItems;
        try {
            allItems = await Item.find(baseQuery).lean();
        } catch (dbErr) {
            error('Items-Service', 'Database query error', {
                message: dbErr.message,
                stack: dbErr.stack,
                workspaceId,
                boardId
            }, extractContextFromReq(req));
            return res.status(500).json({ 
                message: 'Error fetching invoice generator data',
                error: dbErr.message 
            });
        }

        // Helper function to extract value from item data
        const getValueFromItem = (item, attributeName) => {
            if (!item.data || !item.data.values) return null;
            const valueObj = item.data.values.find(v => v.attribute && v.attribute.name === attributeName);
            return valueObj ? valueObj.data : null;
        };

        // Helper function to parse number from value
        const parseNumber = (value) => {
            if (value === null || value === undefined) return 0;
            if (typeof value === 'number') return value;
            if (typeof value === 'string') {
                const match = value.match(/-?\d+(?:\.\d+)?/);
                return match ? parseFloat(match[0]) : 0;
            }
            return 0;
        };

        // Helper function to parse date from value
        const parseDate = (value) => {
            if (!value) return null;
            if (value instanceof Date) return value;
            if (typeof value === 'string') {
                const date = new Date(value);
                return isNaN(date.getTime()) ? null : date;
            }
            return null;
        };

        // Helper function to check if item is invoiced
        const isInvoiced = (item) => {
            const invoiceIssued = getValueFromItem(item, 'Invoice Issued and Sent');
            if (invoiceIssued === true || invoiceIssued === 'true' || invoiceIssued === 'Y') {
                return true;
            }
            
            if (!item.data || !item.data.values) return false;
            
            const paymentStatusValue = item.data.values.find(v => 
                v.attribute && (v.attribute.name === 'Payment Status' || v.attribute.name === ATTRIBUTE_NAMES.PAYMENT_STATUS)
            );
            if (paymentStatusValue) {
                const paymentStatusData = paymentStatusValue.data;
                const labels = paymentStatusValue.attribute?.settings?.labels || [];
                
                if (Array.isArray(paymentStatusData) && paymentStatusData.length > 0) {
                    return paymentStatusData.some(id => {
                        const label = labels.find(l => l.id === id || (typeof id === 'object' && l.id === id.id));
                        const labelName = label ? label.name : (typeof id === 'object' ? id.name : String(id));
                        return labelName && labelName.includes('Paid');
                    });
                } else if (paymentStatusData) {
                    let labelName = '';
                    if (typeof paymentStatusData === 'object' && paymentStatusData.id) {
                        const label = labels.find(l => l.id === paymentStatusData.id);
                        labelName = label ? label.name : (paymentStatusData.name || String(paymentStatusData.id));
                    } else if (typeof paymentStatusData === 'string') {
                        const label = labels.find(l => l.id === paymentStatusData);
                        labelName = label ? label.name : paymentStatusData;
                    } else {
                        labelName = String(paymentStatusData);
                    }
                    return labelName.includes('Paid');
                }
            }
            return false;
        };

        // Helper function to get label names from status value
        const getLabelNames = (item, attributeName) => {
            if (!item.data || !item.data.values) return [];
            
            const statusValue = item.data.values.find(v => 
                v.attribute && v.attribute.name === attributeName
            );
            if (!statusValue) return [];
            
            const statusData = statusValue.data;
            const labels = statusValue.attribute?.settings?.labels || [];
            
            if (Array.isArray(statusData) && statusData.length > 0) {
                return statusData.map(id => {
                    const label = labels.find(l => l.id === id || (typeof id === 'object' && l.id === id.id));
                    return label ? label.name : (typeof id === 'object' ? id.name : String(id));
                });
            } else if (statusData) {
                if (typeof statusData === 'object' && statusData.id) {
                    const label = labels.find(l => l.id === statusData.id);
                    return [label ? label.name : (statusData.name || String(statusData.id))];
                } else if (typeof statusData === 'string') {
                    const label = labels.find(l => l.id === statusData);
                    return [label ? label.name : statusData];
                } else {
                    return [String(statusData)];
                }
            }
            return [];
        };

        // Helper function to get raw status data for fallback matching
        const getRawStatusData = (item, attributeName) => {
            if (!item.data || !item.data.values) return null;
            
            const statusValue = item.data.values.find(v => 
                v.attribute && v.attribute.name === attributeName
            );
            if (!statusValue || !statusValue.data) return null;
            return statusValue.data;
        };

        // Process and filter items in JavaScript (more stable than aggregation)
        const processedItems = allItems.map(item => {
            const scheduledStart = getValueFromItem(item, ATTRIBUTE_NAMES.SCHEDULED_START);
            const actualEnd = getValueFromItem(item, ATTRIBUTE_NAMES.ACTUAL_END);
            const participantName = getValueFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
            
            return {
                item,
                scheduledStartDate: parseDate(scheduledStart),
                actualEndDate: parseDate(actualEnd),
                participantName: String(participantName),
                invoicedFlag: isInvoiced(item),
                totalAmountNum: parseNumber(getValueFromItem(item, ATTRIBUTE_NAMES.TOTAL_AMOUNT)),
                govSubsidyNum: parseNumber(getValueFromItem(item, ATTRIBUTE_NAMES.GOV_SUBSIDY)),
                participantContributionNum: parseNumber(getValueFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)),
                transactionStatusNames: getLabelNames(item, ATTRIBUTE_NAMES.TRANSACTION_STATUS),
                paymentStatusNames: getLabelNames(item, ATTRIBUTE_NAMES.PAYMENT_STATUS || 'Payment Status'),
                transactionStatusRaw: getRawStatusData(item, ATTRIBUTE_NAMES.TRANSACTION_STATUS),
                paymentStatusRaw: getRawStatusData(item, ATTRIBUTE_NAMES.PAYMENT_STATUS || 'Payment Status')
            };
        });

        // Apply filters in JavaScript
        let filteredItems = processedItems;
        console.log("Base Query: ", baseQuery);
        console.log("ALL Count: ", allItems.length);

        if (status && status !== 'all') {
            filteredItems = filteredItems.filter(p => 
                status === 'invoiced' ? p.invoicedFlag : !p.invoicedFlag
            );
        }

        if (startDate) {
            const startDateObj = new Date(startDate);
            filteredItems = filteredItems.filter(p => 
                p.scheduledStartDate && p.scheduledStartDate >= startDateObj
            );
        }

        if (endDate) {
            const endDateObj = new Date(endDate);
            filteredItems = filteredItems.filter(p => 
                p.scheduledStartDate && p.scheduledStartDate <= endDateObj
            );
        }

        if (serviceDeliveryStart) {
            const serviceDeliveryStartObj = new Date(serviceDeliveryStart);
            filteredItems = filteredItems.filter(p => 
                p.actualEndDate && p.actualEndDate >= serviceDeliveryStartObj
            );
        }

        if (serviceDeliveryEnd) {
            const serviceDeliveryEndObj = new Date(serviceDeliveryEnd);
            filteredItems = filteredItems.filter(p => 
                p.actualEndDate && p.actualEndDate <= serviceDeliveryEndObj
            );
        }

        if (participant) {
            try {
                const participantRegex = new RegExp(participant, 'i');
                filteredItems = filteredItems.filter(p => 
                    participantRegex.test(p.participantName)
                );
            } catch (regexErr) {
                warn('Items-Service', 'Invalid participant regex pattern', {
                    pattern: participant,
                    error: regexErr.message
                }, extractContextFromReq(req));
            }
        }

        if (transactionStatusFilter && transactionStatusFilter !== 'all') {
            try {
                filteredItems = filteredItems.filter(p => {
                    // Helper to check if two strings match (bidirectional contains check)
                    const matches = (searchTerm, value) => {
                        const searchLower = String(searchTerm).toLowerCase();
                        const valueLower = String(value).toLowerCase();
                        return valueLower.includes(searchLower) || searchLower.includes(valueLower);
                    };
                    
                    // First try matching against label names
                    if (Array.isArray(p.transactionStatusNames) && p.transactionStatusNames.length > 0) {
                        if (p.transactionStatusNames.some(name => {
                            const nameStr = String(name);
                            return transactionStatusFilter == nameStr
                        })) {
                            return true;
                        }
                    } else if (p.transactionStatusNames && !Array.isArray(p.transactionStatusNames)) {
                        const nameStr = String(p.transactionStatusNames);
                        if (transactionStatusFilter == nameStr) {
                            return true;
                        }
                    }
                    // Fallback: try matching against raw status data if label names didn't match or were empty
                    if (p.transactionStatusRaw) {
                        const rawStr = Array.isArray(p.transactionStatusRaw) 
                            ? p.transactionStatusRaw.map(v => String(v)).join(' ')
                            : String(p.transactionStatusRaw);
                        if (transactionStatusFilter == rawStr) {
                            return true;
                        }
                    }
                    return false;
                });
            } catch (regexErr) {
                warn('Items-Service', 'Invalid transaction status regex pattern', {
                    pattern: transactionStatusFilter,
                    error: regexErr.message
                }, extractContextFromReq(req));
            }
        }

        if (paymentStatusFilter && paymentStatusFilter !== 'all') {
            try {
                filteredItems = filteredItems.filter(p => {
                    // Helper to check if two strings match (bidirectional contains check)
                    const matches = (searchTerm, value) => {
                        const searchLower = String(searchTerm).toLowerCase();
                        const valueLower = String(value).toLowerCase();
                        return valueLower.includes(searchLower) || searchLower.includes(valueLower);
                    };
                    
                    // First try matching against label names
                    if (Array.isArray(p.paymentStatusNames) && p.paymentStatusNames.length > 0) {
                        if (p.paymentStatusNames.some(name => {
                            const nameStr = String(name);
                            return paymentStatusFilter == nameStr
                        })) {
                            return true;
                        }
                    } else if (p.paymentStatusNames && !Array.isArray(p.paymentStatusNames)) {
                        const nameStr = String(p.paymentStatusNames);
                        if (paymentStatusFilter == nameStr) {
                            return true;
                        }
                    }
                    // Fallback: try matching against raw status data if label names didn't match or were empty
                    if (p.paymentStatusRaw) {
                        const rawStr = Array.isArray(p.paymentStatusRaw) 
                            ? p.paymentStatusRaw.map(v => String(v)).join(' ')
                            : String(p.paymentStatusRaw);
                        if (paymentStatusFilter == rawStr) {
                            return true;
                        }
                    }
                    return false;
                });
            } catch (regexErr) {
                warn('Items-Service', 'Invalid payment status regex pattern', {
                    pattern: paymentStatusFilter,
                    error: regexErr.message
                }, extractContextFromReq(req));
            }
        }

        // Calculate totals from filtered items
        const totalsData = {
            totalAmount: 0,
            totalGovSubsidy: 0,
            totalParticipantContribution: 0,
            invoicedCount: 0,
            pendingCount: 0,
            total: 0
        };

        console.log("Filtered Count: ", filteredItems.length);

        filteredItems.forEach(p => {
            totalsData.totalAmount += p.totalAmountNum;
            totalsData.totalGovSubsidy += p.govSubsidyNum;
            totalsData.totalParticipantContribution += p.participantContributionNum;
            if (p.invoicedFlag) {
                totalsData.invoicedCount++;
            } else {
                totalsData.pendingCount++;
            }
            totalsData.total++;
        });

        // Sort items in JavaScript
        const sortFieldMap = {
            scheduledServiceDate: 'scheduledStartDate',
            serviceDeliveryDate: 'actualEndDate',
            updatedAt: 'updatedAt'
        };
        const selectedSortField = sortFieldMap[sortBy] || 'scheduledStartDate';
        const selectedSortOrder = sortOrder === 'desc' ? -1 : 1;

        filteredItems.sort((a, b) => {
            let aVal, bVal;
            
            if (selectedSortField === 'updatedAt') {
                aVal = a.item.updatedAt || a.item.createdAt || new Date(0);
                bVal = b.item.updatedAt || b.item.createdAt || new Date(0);
            } else {
                aVal = a[selectedSortField];
                bVal = b[selectedSortField];
            }

            if (aVal === null || aVal === undefined) return 1;
            if (bVal === null || bVal === undefined) return -1;
            
            if (aVal < bVal) return -1 * selectedSortOrder;
            if (aVal > bVal) return 1 * selectedSortOrder;
            
            // Secondary sort by updatedAt if not primary sort field
            if (selectedSortField !== 'updatedAt') {
                const aUpdated = a.item.updatedAt || a.item.createdAt || new Date(0);
                const bUpdated = b.item.updatedAt || b.item.createdAt || new Date(0);
                if (aUpdated < bUpdated) return 1;
                if (aUpdated > bUpdated) return -1;
            }
            
            return 0;
        });

        // Apply pagination
        const items = applyPagination && limitNumber
            ? filteredItems.slice(skip, skip + limitNumber)
            : filteredItems;

        // Cache for item values to reduce redundant API calls
        const itemValuesCache = new Map();
        const getCachedItemValues = async (itemId) => {
            if (!itemId) return null;
            const cacheKey = itemId.toString();
            if (itemValuesCache.has(cacheKey)) {
                return itemValuesCache.get(cacheKey);
            }
            // Add small delay to prevent rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
            const values = await getItemValuesWithRateLimit(workspaceId, boardId, cacheKey);
            if (values) {
                itemValuesCache.set(cacheKey, values);
            }
            return values;
        };

        // Transform items with rate limiting (reduced batch size to prevent 429 errors)
        const transformedItems = await batchProcess(
            items,
            async (processedItem) => {
                const item = processedItem.item;
                const getValue = (attributeName) => {
                    if (!item.data || !item.data.values) return null;
                    return item.data.values.find(v => v.attribute && v.attribute.name === attributeName)?.data;
                };

                const participant = getValue(ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
                const scheduledStart = getValue(ATTRIBUTE_NAMES.SCHEDULED_START) || null;
                const unit = getValue(ATTRIBUTE_NAMES.UNIT) || 'Hours';
                const quantity = Number(getValue(ATTRIBUTE_NAMES.QUANTITY)) || 0;
                const unitPrice = Number(getValue(ATTRIBUTE_NAMES.UNIT_PRICE)) || 0;
                const totalAmount = Number(getValue(ATTRIBUTE_NAMES.TOTAL_AMOUNT)) || 0;
                const govSubsidy = Number(getValue(ATTRIBUTE_NAMES.GOV_SUBSIDY)) || 0;
                const participantContribution = Number(getValue(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)) || 0;
                const notes = getValue(ATTRIBUTE_NAMES.ADDITIONAL_NOTES) || '';

                const servicePlanId = getValue(ATTRIBUTE_NAMES.SERVICE_PLAN);
                const servicePlan = servicePlanId?.toString()
                    ? await getCachedItemValues(servicePlanId.toString())
                    : null;

            let service = undefined;
            let serviceIdentifier = undefined;
            let itemId = '';
            let itemName = '';
            let wraparoundItemId = '';
            let wraparoundDescription = '';
            let healthProfessionalTypeCode;
            let healthProfessionalTypeOther;

            if (servicePlan?.values) {
                const servicePlanIdValue = servicePlan.values
                    .find(v => v.attribute.name === ATTRIBUTE_NAMES.SERVICE_PLAN_ID)?.data?.toString().trim();
                if (servicePlanIdValue) {
                    const parts = servicePlanIdValue.split('-');
                    service = parts.length >= 2 ? parts.slice(1).join('-').trim() : servicePlanIdValue;
                }

                // Add small delay before making multiple API calls to prevent rate limiting
                await new Promise(resolve => setTimeout(resolve, 150));
                const [
                    ,
                    homeSupportValues,
                    assistiveTechnologyShortTermValues,
                    assistiveTechnologyOngoingValues,
                    homeModificationValues,
                    healthProfessionalValues,
                    wraparoundValues
                ] = await getAgeCareParticipantsServicePlanReferencedItems(workspaceId, boardId, servicePlanId);

                const serviceIdItemId =
                    homeSupportValues?.serviceIDItemID ||
                    assistiveTechnologyShortTermValues?.serviceIDItemID ||
                    assistiveTechnologyOngoingValues?.serviceIDItemID ||
                    homeModificationValues?.serviceIDItemID ||
                    healthProfessionalValues?.serviceIDItemID ||
                    '';

                if (serviceIdItemId) {
                    serviceIdentifier = typeof serviceIdItemId === 'string'
                        ? serviceIdItemId
                        : String(serviceIdItemId);
                    if (serviceIdentifier.includes('/')) {
                        serviceIdentifier = serviceIdentifier.split('/')[0].trim();
                    }
                }

                healthProfessionalTypeCode = healthProfessionalValues?.healthProfessionalTypeCode || '';
                healthProfessionalTypeOther = healthProfessionalValues?.healthProfessionalTypeOther.includes(' - Other') ? healthProfessionalValues?.healthProfessionalTypeOther.split(' - Other')[0] : '';

                itemId =
                    homeSupportValues?.itemID ||
                    assistiveTechnologyShortTermValues?.itemID ||
                    assistiveTechnologyOngoingValues?.itemID ||
                    homeModificationValues?.itemID ||
                    healthProfessionalValues?.itemID ||
                    '';

                itemName =
                    homeSupportValues?.item ||
                    assistiveTechnologyShortTermValues?.item ||
                    assistiveTechnologyOngoingValues?.item ||
                    homeModificationValues?.item ||
                    healthProfessionalValues?.item ||
                    '';

                wraparoundItemId = wraparoundValues?.itemID || '';
                wraparoundDescription = wraparoundValues?.wraparoundDescription || '';
            }

            const invoiceNumber =
                getValue(ATTRIBUTE_NAMES.INVOICE_NUMBER) || getValue('Generated Invoice Number') || '';

            let careRecipientIdentifier;
            const participantProfileValue = getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
            if (participantProfileValue) {
                try {
                    const participantProfileId = Array.isArray(participantProfileValue)
                        ? participantProfileValue[0]
                        : (typeof participantProfileValue === 'object'
                            ? participantProfileValue.id
                            : participantProfileValue);

                    if (participantProfileId) {
                        const participantProfile = await getCachedItemValues(participantProfileId.toString());
                        const myAgedCareId = participantProfile?.values?.find(v =>
                            v.attribute.name === ATTRIBUTE_NAMES.MY_AGED_CARE_ID ||
                            v.attribute.name === ATTRIBUTE_NAMES.MY_AGED_CARE_ID_ALT
                        )?.data;
                        if (myAgedCareId) {
                            careRecipientIdentifier = typeof myAgedCareId === 'string'
                                ? myAgedCareId
                                : String(myAgedCareId);
                        }
                    }
                } catch (err) {
                    warn(
                        'Items-Service',
                        'Failed to fetch My Aged Care ID from participant profile',
                        { error: err.message },
                        extractContextFromReq(req)
                    );
                }
            }

            const deliveredBy = getValue(ATTRIBUTE_NAMES.DELIVERED_BY);
            const deliveredByString = deliveredBy
                ? (typeof deliveredBy === 'object' ? deliveredBy.name : String(deliveredBy))
                : undefined;

            const prescribedItem = getValue('Prescribed Item');
            const prescribedItemValue =
                prescribedItem === true || prescribedItem === 'true' || prescribedItem === 'Y' ? 'Y' : 'N';

            const itemFirstPaymentRaw = getValue('Item First Payment');
            let itemFirstPaymentValue;
            if (typeof itemFirstPaymentRaw === 'boolean') {
                itemFirstPaymentValue = itemFirstPaymentRaw ? 'Y' : 'N';
            } else if (typeof itemFirstPaymentRaw === 'string') {
                const normalized = itemFirstPaymentRaw.trim().toLowerCase();
                itemFirstPaymentValue = ['true', 'y', 'yes'].includes(normalized) ? 'Y' : 'N';
            }

            const itemPurchasedMethod = getValue('Item Purchased Method');
            const itemPurchasedMethodString = itemPurchasedMethod
                ? (typeof itemPurchasedMethod === 'object'
                    ? itemPurchasedMethod.name
                    : String(itemPurchasedMethod))
                : undefined;

            const associatedProvider = getValue(ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER);
            const associatedProviderString = associatedProvider
                ? (typeof associatedProvider === 'object' ? associatedProvider.name : String(associatedProvider))
                : undefined;

            const associatedProviderInvoiceNo =
                getValue('Associated Provider Invoice No. (if applicable)') ||
                getValue('Associated Provider Invoice No') ||
                undefined;

            const loanedByOrganisationName = associatedProviderString || undefined;

            const fileUrl =
                getValue('Invoice File URL') ||
                getValue('Invoice PDF Link') ||
                getValue('Generated Invoice File URL') ||
                getValue('Generated Invoice Link') ||
                undefined;

            const invoiceIssued = getValue('Invoice Issued and Sent') || false;
            const paymentStatusValueForCheck = item.data?.values?.find(v =>
                v.attribute && v.attribute.name === 'Payment Status'
            );
            let hasPaidStatus = false;
            if (paymentStatusValueForCheck) {
                const paymentStatusData = paymentStatusValueForCheck.data;
                const labels = paymentStatusValueForCheck.attribute?.settings?.labels || [];
                if (Array.isArray(paymentStatusData) && paymentStatusData.length > 0) {
                    hasPaidStatus = paymentStatusData.some(id => {
                        const label = labels.find(l => l.id === id || (typeof id === 'object' && l.id === id.id));
                        const labelName = label ? label.name : (typeof id === 'object' ? id.name : String(id));
                        return labelName && labelName.includes('Paid');
                    });
                } else if (paymentStatusData) {
                    let labelName = '';
                    if (typeof paymentStatusData === 'object' && paymentStatusData.id) {
                        const label = labels.find(l => l.id === paymentStatusData.id);
                        labelName = label ? label.name : (paymentStatusData.name || String(paymentStatusData.id));
                    } else if (typeof paymentStatusData === 'string') {
                        const label = labels.find(l => l.id === paymentStatusData);
                        labelName = label ? label.name : paymentStatusData;
                    } else {
                        labelName = String(paymentStatusData);
                    }
                    hasPaidStatus = labelName.includes('Paid');
                }
            }
            const invoiceStatus = invoiceIssued || hasPaidStatus ? 'invoiced' : 'pending';

            const actualEnd = getValue(ATTRIBUTE_NAMES.ACTUAL_END) || null;
            const serviceDeliveryDate = actualEnd && typeof actualEnd === 'string'
                ? (actualEnd.includes('T') ? actualEnd.split('T')[0] : actualEnd.split(' ')[0])
                : null;
            const scheduledServiceDate = scheduledStart && typeof scheduledStart === 'string'
                ? (scheduledStart.includes('T') ? scheduledStart.split('T')[0] : scheduledStart.split(' ')[0])
                : null;

            const transactionStatusValue = item.data?.values?.find(v =>
                v.attribute && v.attribute.name === ATTRIBUTE_NAMES.TRANSACTION_STATUS
            );
            let transactionStatus;
            if (transactionStatusValue) {
                const transactionStatusData = transactionStatusValue.data;
                const labels = transactionStatusValue.attribute?.settings?.labels || [];
                if (Array.isArray(transactionStatusData) && transactionStatusData.length > 0) {
                    transactionStatus = transactionStatusData.map(id => {
                        const label = labels.find(l => l.id === id || (typeof id === 'object' && l.id === id.id));
                        return label ? label.name : (typeof id === 'object' ? id.name : String(id));
                    }).join(', ');
                } else if (transactionStatusData) {
                    if (typeof transactionStatusData === 'object' && transactionStatusData.id) {
                        const label = labels.find(l => l.id === transactionStatusData.id);
                        transactionStatus = label
                            ? label.name
                            : (transactionStatusData.name || String(transactionStatusData.id));
                    } else if (typeof transactionStatusData === 'string') {
                        const label = labels.find(l => l.id === transactionStatusData);
                        transactionStatus = label ? label.name : transactionStatusData;
                    } else {
                        transactionStatus = String(transactionStatusData);
                    }
                }
            }

            const paymentStatusValue = item.data?.values?.find(v =>
                v.attribute && (
                    v.attribute.name === ATTRIBUTE_NAMES.PAYMENT_STATUS ||
                    v.attribute.name === 'Payment Status'
                )
            );
            let paymentStatusFormatted;
            if (paymentStatusValue) {
                const paymentStatusData = paymentStatusValue.data;
                const labels = paymentStatusValue.attribute?.settings?.labels || [];
                if (Array.isArray(paymentStatusData) && paymentStatusData.length > 0) {
                    paymentStatusFormatted = paymentStatusData.map(id => {
                        const label = labels.find(l => l.id === id || (typeof id === 'object' && l.id === id.id));
                        return label ? label.name : (typeof id === 'object' ? id.name : String(id));
                    }).filter(Boolean).join(', ');
                } else if (paymentStatusData) {
                    if (typeof paymentStatusData === 'object' && paymentStatusData.id) {
                        const label = labels.find(l => l.id === paymentStatusData.id);
                        paymentStatusFormatted = label
                            ? label.name
                            : (paymentStatusData.name || String(paymentStatusData.id));
                    } else if (typeof paymentStatusData === 'string') {
                        const label = labels.find(l => l.id === paymentStatusData);
                        paymentStatusFormatted = label ? label.name : paymentStatusData;
                    } else {
                        paymentStatusFormatted = String(paymentStatusData);
                    }
                }
            }

            const fetchFundingSourceName = async (refItemId, timeoutMs = 10000, maxRetries = 5) => {
                if (!refItemId || typeof refItemId !== 'string' || refItemId.trim() === '') {
                    return null;
                }
                let lastError = null;
                for (let attempt = 0; attempt < maxRetries; attempt++) {
                    try {
                        // Add delay before each attempt to prevent rate limiting
                        if (attempt > 0) {
                            // Exponential backoff with jitter
                            const jitter = 1 + (Math.random() * 0.3);
                            const delayMs = Math.min(500 * Math.pow(2, attempt - 1) * jitter, 5000);
                            await new Promise(resolve => setTimeout(resolve, Math.floor(delayMs)));
                        } else {
                            // Small delay even on first attempt to space out requests
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        const timeoutPromise = new Promise((_, reject) => {
                            setTimeout(() => reject(new Error('Timeout')), timeoutMs);
                        });
                        const refItem = await Promise.race([
                            getItemValuesWithRateLimit(workspaceId, boardId, refItemId.toString()),
                            timeoutPromise
                        ]);
                        if (refItem?.values) {
                            const nameValue = refItem.values.find(v =>
                                ['Name', 'Title', 'Funding Source Name', 'Full Name'].includes(v.attribute.name)
                            );
                            if (nameValue?.data) {
                                const name = typeof nameValue.data === 'object' && nameValue.data.name
                                    ? nameValue.data.name
                                    : String(nameValue.data);
                                if (name?.trim()) {
                                    return name;
                                }
                            }
                            const textValue = refItem.values.find(v =>
                                v.attribute.type === 'text' && v.data
                            );
                            if (textValue?.data) {
                                const text = String(textValue.data);
                                if (text?.trim()) {
                                    return text;
                                }
                            }
                        }
                        if (attempt < maxRetries - 1) {
                            continue;
                        }
                        return null;
                    } catch (err) {
                        lastError = err;
                        if (err.message !== 'Timeout' && attempt < maxRetries - 1) {
                            continue;
                        }
                        if (attempt === maxRetries - 1 && err.message !== 'Timeout') {
                            warn('Items-Service', 'Failed to fetch funding source item after retries', {
                                refId: refItemId,
                                error: err.message,
                                attempts: maxRetries
                            }, extractContextFromReq(req));
                        }
                    }
                }
                return null;
            };

            let fundingSource;
            const fundingSourceValue = item.data?.values?.find(v =>
                v.attribute && v.attribute.name === ATTRIBUTE_NAMES.FUNDING_SOURCE
            );
            if (fundingSourceValue?.data) {
                const fundingSourceData = fundingSourceValue.data;
                if (Array.isArray(fundingSourceData) && fundingSourceData.length > 0) {
                    // Process funding sources in batches to avoid rate limiting
                    const fundingSourcePromises = fundingSourceData.map((refId) => {
                        const refItemId = typeof refId === 'object' ? refId.id || refId : refId;
                        if (!refItemId) return Promise.resolve(null);
                        return fetchFundingSourceName(refItemId.toString());
                    });
                    
                    const fundingSourceResults = await rateLimiter.processBatches(
                        fundingSourcePromises,
                        { batchSize: 2, delayBetweenBatches: 600, delayBetweenRequests: 150 }
                    );
                    
                    const fundingSourceNames = fundingSourceResults
                        .filter(result => result.status === 'fulfilled' && result.value)
                        .map(result => result.value);
                    fundingSource = fundingSourceNames.length > 0 ? fundingSourceNames.join(', ') : undefined;
                } else {
                    const refItemId = typeof fundingSourceData === 'object'
                        ? fundingSourceData.id || fundingSourceData
                        : fundingSourceData;
                    if (refItemId) {
                        fundingSource = await fetchFundingSourceName(refItemId.toString());
                    }
                }
            }

            const normalizedUnit = typeof unit === 'string' ? unit.toLowerCase() : '';
            const isItemUnit = normalizedUnit === 'item';
            const serviceLabel = service || '';
            const isWraparound = serviceLabel.toLowerCase().includes('wraparound');

            return {
                id: item.itemId,
                status: invoiceStatus,
                invoiceNumber,
                participant,
                service: serviceLabel,
                scheduledStart,
                scheduledServiceDate,
                serviceDeliveryDate,
                unit,
                quantity,
                unitPrice,
                totalAmount,
                govSubsidy,
                participantContribution,
                notes,
                transactionStatus,
                paymentStatus: paymentStatusFormatted,
                fundingSource,
                fileUrl,
                careRecipientIdentifier,
                serviceIdentifier,
                deliveredBy: deliveredByString,
                itemOrWraparound: isItemUnit ? 'Item' : (isWraparound ? 'Wraparound' : undefined),
                itemDescriptionCode: isItemUnit ? itemId : undefined,
                itemDescription: isItemUnit ? itemName : undefined,
                wraparoundDescriptionCode: isWraparound ? wraparoundItemId : undefined,
                wraparoundDescription: isWraparound ? wraparoundDescription : undefined,
                prescribedItem: prescribedItemValue,
                itemPurchasedMethod: itemPurchasedMethodString,
                associatedProvider: associatedProviderString,
                associatedProviderInvoiceNo,
                loanedByOrganisationName,
                healthProfessionalTypeCode,
                healthProfessionalTypeOther,
                itemFirstPayment: itemFirstPaymentValue
            };
            },
            { batchSize: 2, delayBetweenBatches: 600, delayBetweenRequests: 150 }
        );

        res.status(200).json({
            items: transformedItems,
            total: totalsData.total || 0,
            invoiced: totalsData.invoicedCount || 0,
            pending: totalsData.pendingCount || 0,
            totalAmount: totalsData.totalAmount || 0,
            totalGovSubsidy: totalsData.totalGovSubsidy || 0,
            totalParticipantContribution: totalsData.totalParticipantContribution || 0
        });
    } catch (err) {
        error('Items-Service', 'Failed to fetch invoice generator data', {
            message: err.message
        }, extractContextFromReq(req));
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/:workspaceId/:boardId/monthly-statement', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        const { members } = await getMember(req.session.Authorization, workspaceId);
        const {
            participant = '',
            startDate,
            endDate,
            month,
            year,
            budgetPage = 1,
            budgetLimit: budgetLimitParam,
            servicePage = 1,
            serviceLimit: serviceLimitParam
        } = req.query;

        if (!workspaceId || !boardId) {
            return res.status(400).json({
                message: 'WorkspaceId and boardId are required'
            });
        }

        // Fetch business name once for all items
        let businessProfile = null;
        try {
            // Only select name field to reduce memory usage
            businessProfile = await Business.findOne({ workspaceId: workspaceId.toString() })
                .select('name')
                .lean();
        } catch (err) {
            warn('Items-Service', 'Failed to fetch business name', {
                message: err.message,
                workspaceId
            }, extractContextFromReq(req));
        }

        // Fetch folders for mapping budget categories
        let folderList = [];
        try {
            const folderResponse = await getFolder(workspaceId, boardId);
            folderList = Array.isArray(folderResponse?.folder) ? folderResponse.folder : [];
        } catch (err) {
            warn('Items-Service', 'Failed to fetch folders', {
                message: err.message,
                workspaceId,
                boardId
            }, extractContextFromReq(req));
        }

        const folderIdToName = new Map(folderList.map(folder => [folder.id, folder.name]));
        const folderIdToCode = {};
        BUDGET_CATEGORY_CONFIG.forEach(config => {
            const match = folderList.find(folder => folder.name?.toLowerCase().includes(config.folderName.toLowerCase()));
            if (match) {
                folderIdToCode[match.id] = config.code;
            }
        });

        // Helper function to build aggregation pipeline
        const buildPipeline = (folderName, participantFilter, dateFilter, options = {}, type = 'budget') => {
            const pipeline = [];
            const baseMatch = { workspaceId, boardId };

            return getFolderIds(folderName, workspaceId, boardId, options.folderList).then(folderIds => {
                if (folderIds && folderIds.length > 0) {
                    baseMatch.folderId = { $in: folderIds };
                }
                pipeline.push({ $match: baseMatch });

                // Add aggregation stages for extracting values
                pipeline.push(
                    {
                        $addFields: {
                            scheduledStartValue: {
                                $filter: {
                                    input: "$data.values",
                                    as: "value",
                                    cond: { $eq: ["$$value.attribute.name", ATTRIBUTE_NAMES.SCHEDULED_START] }
                                }
                            },
                            actualEndValue: {
                                $filter: {
                                    input: "$data.values",
                                    as: "value",
                                    cond: { $eq: ["$$value.attribute.name", ATTRIBUTE_NAMES.ACTUAL_END] }
                                }
                            },
                            participantValue: {
                                $filter: {
                                    input: "$data.values",
                                    as: "value",
                                    cond: { $eq: ["$$value.attribute.name", type === 'budget' ? ATTRIBUTE_NAMES.PARTICIPANT_PROFILE : ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME] }
                                }
                            }
                        }
                    },
                    {
                        $addFields: {
                            scheduledStartRaw: {
                                $let: {
                                    vars: { firstVal: { $arrayElemAt: ["$scheduledStartValue", 0] } },
                                    in: { $ifNull: ["$$firstVal.data", null] }
                                }
                            },
                            actualEndRaw: {
                                $let: {
                                    vars: { firstVal: { $arrayElemAt: ["$actualEndValue", 0] } },
                                    in: { $ifNull: ["$$firstVal.data", null] }
                                }
                            },
                            participantNameRaw: {
                                $let: {
                                    vars: { firstVal: { $arrayElemAt: ["$participantValue", 0] } },
                                    in: { $ifNull: ["$$firstVal.data", null] }
                                }
                            }
                        }
                    },
                    {
                        $addFields: {
                            scheduledStartDate: {
                                $dateFromString: { dateString: "$scheduledStartRaw", onError: null }
                            },
                            actualEndDate: {
                                $dateFromString: { dateString: "$actualEndRaw", onError: null }
                            }
                        }
                    }
                );

                // Add filters
                const andConditions = [];
                const dateFieldName = type === 'service' ? 'actualEndDate' : 'scheduledStartDate';
                if (participantFilter) {
                    andConditions.push({ participantNameRaw: { $regex: participantFilter, $options: 'i' } });
                }
                if (dateFilter && dateFilter.startDate) {
                    andConditions.push({ [dateFieldName]: { $gte: new Date(dateFilter.startDate) } });
                }
                if (dateFilter && dateFilter.endDate) {
                    andConditions.push({ [dateFieldName]: { $lte: new Date(dateFilter.endDate) } });
                }
                if (andConditions.length > 0) {
                    pipeline.push({ $match: { $and: andConditions } });
                }

                return pipeline;
            });
        };

        // Fetch all budget items (first table)
        const budgetFolderNames = [
            'Home Support Quarterly Budget',
            'Restorative Care Pathway Budget',
            'End-of-Life Pathway Budget',
            'Assistive Technology - Short-term Budget',
            'Assistive Technology - Ongoing Budget',
            'Home Modification Budget'
        ].join(',');

        let participantIntakeIds = [];
        const participantIntakeFolderIds = await getFolderIds('Participants Intake', workspaceId, boardId);
        if (participantIntakeFolderIds && participantIntakeFolderIds.length > 0) {
            // Only select itemId and data.values to reduce memory usage
            const participantIntakeItems = await Item.find({ workspaceId: workspaceId, boardId: boardId, folderId: { $in: participantIntakeFolderIds } })
                .select('itemId data.values')
                .lean();
            participantIntakeIds = participantIntakeItems.map(item => item.data.values.find(v => v.attribute.name.includes(ATTRIBUTE_NAMES.FULL_NAME))?.data == participant ? item.itemId : null).filter(id => id !== null);
        }

        const budgetPipelineForTotals = await buildPipeline(budgetFolderNames, participantIntakeIds[0] ? participantIntakeIds[0] : null, {}, { folderList }, 'budget');
        budgetPipelineForTotals.push({ $sort: { updatedAt: -1 } });
        
        let allBudgetItemsResult;
        try {
            // Use allowDiskUse to handle large datasets on memory-constrained servers
            // batchSize helps control memory usage during aggregation
            allBudgetItemsResult = await Item.aggregate(budgetPipelineForTotals, { 
                allowDiskUse: true,
                batchSize: 1000, // Process in smaller batches to reduce memory pressure
                maxTimeMS: 300000 // 5 minute timeout to prevent hanging
            });
        } catch (aggErr) {
            error('Items-Service', 'Budget aggregation pipeline error', {
                message: aggErr.message,
                stack: aggErr.stack,
                workspaceId,
                boardId,
                pipelineLength: budgetPipelineForTotals.length
            }, extractContextFromReq(req));
            return res.status(500).json({ 
                message: 'Error fetching budget items for monthly statement',
                error: aggErr.message 
            });
        }
        
        const allBudgetItems = Array.isArray(allBudgetItemsResult) ? allBudgetItemsResult : [];

        const parseNumberValue = (rawValue) => {
            if (rawValue === null || rawValue === undefined) return 0;
            if (Array.isArray(rawValue) && rawValue.length > 0) {
                return parseNumberValue(rawValue[0]);
            }
            if (typeof rawValue === 'number') {
                return Number.isFinite(rawValue) ? rawValue : 0;
            }
            if (typeof rawValue === 'string') {
                const normalized = rawValue.replace(/[^0-9.\\-]/g, '');
                const parsed = parseFloat(normalized);
                return Number.isFinite(parsed) ? parsed : 0;
            }
            return 0;
        };

        const normalizeAttributeNames = (attributeName) => {
            if (Array.isArray(attributeName)) {
                return attributeName
                    .filter((name) => typeof name === 'string' && name.trim() !== '');
            }
            if (typeof attributeName === 'string' && attributeName.trim() !== '') {
                return [attributeName];
            }
            return [];
        };

        const getAttributeEntry = (item, attributeName) => {
            const candidateNames = normalizeAttributeNames(attributeName);
            const values = item?.data?.values;
            if (!values || candidateNames.length === 0) {
                return null;
            }
            for (const name of candidateNames) {
                const entry = values.find(v => v.attribute.name === name);
                if (entry) {
                    return entry;
                }
            }
            return null;
        };

        const getNumberFromItem = (item, attributeName) => {
            const entry = getAttributeEntry(item, attributeName);
            if (!entry) {
                return 0;
            }
            return parseNumberValue(entry.data);
        };

        const getLabelFromItem = (item, attributeName) => {
            const entry = getAttributeEntry(item, attributeName);
            if (!entry) {
                return null;
            }
            const data = entry.data;
            if (Array.isArray(data) && data.length > 0) {
                const label = entry.attribute?.settings?.labels?.find(l => l.id === data[0]);
                return label?.name || null;
            }
            if (typeof data === 'string') {
                return data;
            }
            return null;
        };

        const getDateFromItem = (item, attributeName) => {
            const entry = getAttributeEntry(item, attributeName);
            const data = entry?.data;
            if (!data) {
                return null;
            }
            if (typeof data === 'string') {
                return data;
            }
            return null;
        };

        const getTextFromItem = (item, attributeName) => {
            const entry = getAttributeEntry(item, attributeName);
            const data = entry?.data;
            if (data === null || data === undefined) {
                return '';
            }
            if (typeof data === 'string') {
                return data;
            }
            if (Array.isArray(data) && data.length > 0) {
                return data[0]?.toString() || '';
            }
            return data.toString ? data.toString() : '';
        };

        const getFirstReferenceId = (item, attributeName) => {
            const entry = getAttributeEntry(item, attributeName);
            const data = entry?.data;
            if (Array.isArray(data) && data.length > 0) {
                return data[0];
            }
            if (typeof data === 'string') {
                return data;
            }
            return null;
        };

        const itemValuesCache = new Map();
        const fetchItemValuesCached = async (targetItemId) => {
            if (!targetItemId) return null;
            if (itemValuesCache.has(targetItemId)) {
                return itemValuesCache.get(targetItemId);
            }
            try {
                const values = await getItemValuesWithRateLimit(workspaceId, boardId, targetItemId);
                itemValuesCache.set(targetItemId, values);
                return values;
            } catch (err) {
                warn('Items-Service', 'Failed to fetch item values', {
                    message: err.message,
                    targetItemId
                }, extractContextFromReq(req));
                return null;
            }
        };

        const resolveParticipantName = async (participantProfileIdValue) => {
            if (!participantProfileIdValue) {
                return '';
            }
            const profileIdStr = participantProfileIdValue.toString();
            const participantProfile = await fetchItemValuesCached(profileIdStr);
            if (!participantProfile || !participantProfile.values) {
                return '';
            }
            const nameEntry = participantProfile.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.FULL_NAME);
            const rawName = nameEntry?.data;
            if (!rawName) {
                return '';
            }
            if (typeof rawName === 'object' && rawName.name) {
                return rawName.name;
            }
            return rawName.toString();
        };

        const determineCategoryCodeForBudget = (item) => {
            if (item?.folderId && folderIdToCode[item.folderId]) {
                return folderIdToCode[item.folderId];
            }
            const folderName = folderIdToName.get(item?.folderId) || '';
            const config = BUDGET_CATEGORY_CONFIG.find(cfg => folderName.toLowerCase().includes(cfg.folderName.toLowerCase()));
            return config ? config.code : 'HSQ';
        };

        const determineCategoryCodeForService = (service = {}) => {
            const normalize = (value) => (value || '').toString().toLowerCase();
            const fundingSource = normalize(service.fundingSource);
            const serviceName = normalize(service.service);
            const notes = normalize(service.notes);
            const haystack = `${fundingSource} ${serviceName} ${notes}`;

            if (haystack.includes('restorative care')) {
                return 'RCP';
            }
            if (haystack.includes('end-of-life') || haystack.includes('end of life')) {
                return 'EOL';
            }
            if (haystack.includes('assistive') && haystack.includes('short')) {
                return 'ATS';
            }
            if (haystack.includes('assistive') && haystack.includes('ongoing')) {
                return 'ATO';
            }
            if (haystack.includes('modification')) {
                return 'HMB';
            }
            if (haystack.includes('home support') || haystack.includes('hsq')) {
                return 'HSQ';
            }
            return 'HSQ';
        };

        const transformBudgetItem = async (item) => {
            const categoryCode = determineCategoryCodeForBudget(item);
            const folderName = folderIdToName.get(item.folderId) || '';

            const participantProfileIdValue = getFirstReferenceId(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
            const participantName = await resolveParticipantName(participantProfileIdValue);

            const monthLabel = getLabelFromItem(item, ATTRIBUTE_NAMES.MONTH_LABEL);
            const yearLabel = getLabelFromItem(item, ATTRIBUTE_NAMES.YEAR_LABEL);
            const quarterLabel = getLabelFromItem(item, ATTRIBUTE_NAMES.FY_QUARTER);

            const fundingStartDate = getDateFromItem(item, ATTRIBUTE_NAMES.FUNDING_START_DATE);
            const fundingEndDate = getDateFromItem(item, ATTRIBUTE_NAMES.FUNDING_END_DATE);

            const availableFundStart = getNumberFromItem(item, ATTRIBUTE_NAMES.AVAILABLE_FUND_START);
            const quarterlyAdjustment = getNumberFromItem(item, ATTRIBUTE_NAMES.QUARTERLY_ADJUSTMENT);
            const primarySupplementAmount = getNumberFromItem(item, ATTRIBUTE_NAMES.PRIMARY_SUPPLEMENT_AMOUNT);
            const carryoverFunding = getNumberFromItem(item, ATTRIBUTE_NAMES.CARRYOVER_FUNDING);
            const unspentReturned = getNumberFromItem(item, ATTRIBUTE_NAMES.UNSPENT_BUDGET_RETURNED);
            const commonwealthUnspent = getNumberFromItem(item, ATTRIBUTE_NAMES.COMMONWEALTH_UNSPENT_FUNDS);
            const providerUnspent = getNumberFromItem(item, ATTRIBUTE_NAMES.PROVIDER_UNSPENT_FUNDS);
            const participantUnspent = getNumberFromItem(item, ATTRIBUTE_NAMES.PARTICIPANT_UNSPENT_FUNDS);
            const previousMonthSpending = getNumberFromItem(item, ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING);

            const totalAvailableBudgetHomeSupport = getNumberFromItem(item, ATTRIBUTE_NAMES.TOTAL_AVAILABLE_HOME_SUPPORT);
            let totalAvailableBudget = totalAvailableBudgetHomeSupport;
            if (!totalAvailableBudget) {
                totalAvailableBudget =
                    availableFundStart +
                    quarterlyAdjustment +
                    primarySupplementAmount +
                    carryoverFunding +
                    commonwealthUnspent +
                    providerUnspent +
                    participantUnspent +
                    previousMonthSpending +
                    unspentReturned;
            }

            const deliveredAmountRaw = getNumberFromItem(item, ATTRIBUTE_NAMES.HOME_SUPPORT_DELIVERED);
            const adjustmentAmount = getNumberFromItem(item, ATTRIBUTE_NAMES.HOME_SUPPORT_ADJUSTMENTS);
            const remainingBalance = getNumberFromItem(item, ATTRIBUTE_NAMES.REMAINING_HOME_SUPPORT_BALANCE);
            const fundClassification = getLabelFromItem(item, ATTRIBUTE_NAMES.FUND_CLASSIFICATION);
            const fundAmount = getNumberFromItem(item, ATTRIBUTE_NAMES.FUND_AMOUNT);
            const fund = getTextFromItem(item, ATTRIBUTE_NAMES.FUND_TEXT);

            const committedATShort = getNumberFromItem(item, ATTRIBUTE_NAMES.COMMITTED_AT_SHORT_TERM);
            const committedATOngoing = getNumberFromItem(item, ATTRIBUTE_NAMES.COMMITTED_AT_ONGOING);
            const committedHM = getNumberFromItem(item, ATTRIBUTE_NAMES.COMMITTED_HOME_MODIFICATION);

            let committedFunds = 0;
            if (categoryCode === 'ATS') {
                committedFunds = committedATShort;
            } else if (categoryCode === 'ATO') {
                committedFunds = committedATOngoing;
            } else if (categoryCode === 'HMB') {
                committedFunds = committedHM;
            }

            return {
                id: item.itemId,
                categoryCode,
                folderName,
                participantName,
                participantProfileId: participantProfileIdValue ? participantProfileIdValue.toString() : null,
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
                deliveredAmount: Math.abs(deliveredAmountRaw) || 0,
                deliveredAmountRaw,
                adjustmentAmount,
                remainingBalance,
                fundClassification,
                fundAmount,
                fund,
                committedFunds,
                fundingStreamId: getFirstReferenceId(item, ATTRIBUTE_NAMES.FUNDING_STREAM)
            };
        };

        // Transform budget items with rate limiting (reduced batch size to prevent 429 errors)
        const transformedAllBudgetItems = await batchProcess(
            allBudgetItems,
            transformBudgetItem,
            { batchSize: 2, delayBetweenBatches: 600, delayBetweenRequests: 150 }
        );

        const normalizeString = (value) => (value || '').toString().trim().toLowerCase();
        const isIdLike = (value) => typeof value === 'string' && value.includes('-');
        const normalizedParticipant = normalizeString(participant);

        const monthLabelLookup = {
            '01': 'January',
            '02': 'February',
            '03': 'March',
            '04': 'April',
            '05': 'May',
            '06': 'June',
            '07': 'July',
            '08': 'August',
            '09': 'September',
            '10': 'October',
            '11': 'November',
            '12': 'December'
        };

        const normalizedMonth = typeof month === 'string' ? month.padStart(2, '0') : null;
        const targetMonthLabel = normalizedMonth && monthLabelLookup[normalizedMonth] ? monthLabelLookup[normalizedMonth] : null;

        const filteredBudgetItems = transformedAllBudgetItems.filter(item => {
            const matchesParticipant = normalizedParticipant
                ? (isIdLike(participant)
                    ? item.participantProfileId === participant
                    : normalizeString(item.participantName) === normalizedParticipant)
                : true;

            const matchesYear = year
                ? normalizeString(item.year) === normalizeString(year)
                : true;

            const matchesMonth = targetMonthLabel
                ? normalizeString(item.month) === normalizeString(targetMonthLabel)
                : true;

            return matchesParticipant && matchesYear && matchesMonth;
        });

        const getCategoryOrderIndex = (code) => {
            const normalizedCode = (code || 'HSQ').toString();
            const idx = BUDGET_CATEGORY_ORDER.indexOf(normalizedCode);
            return idx === -1 ? BUDGET_CATEGORY_ORDER.length : idx;
        };

        filteredBudgetItems.sort((a, b) => {
            const orderDiff = getCategoryOrderIndex(a.categoryCode) - getCategoryOrderIndex(b.categoryCode);
            if (orderDiff !== 0) {
                return orderDiff;
            }
            return (a.folderName || '').localeCompare(b.folderName || '');
        });

        const hasBudgetLimit = budgetLimitParam !== undefined && budgetLimitParam !== null && budgetLimitParam !== '';
        let budgetLimitNumber = hasBudgetLimit ? parseInt(budgetLimitParam, 10) : null;
        if (hasBudgetLimit && (isNaN(budgetLimitNumber) || budgetLimitNumber <= 0)) {
            budgetLimitNumber = 10;
        }
        const budgetPageNumber = hasBudgetLimit
            ? (parseInt(budgetPage, 10) > 0 ? parseInt(budgetPage, 10) : 1)
            : 1;
        const budgetSkip = hasBudgetLimit && budgetLimitNumber
            ? (budgetPageNumber - 1) * budgetLimitNumber
            : 0;
        const paginatedBudgetItems = hasBudgetLimit && budgetLimitNumber
            ? filteredBudgetItems.slice(budgetSkip, budgetSkip + budgetLimitNumber)
            : filteredBudgetItems;

        // Fetch service items (second table) from Master Plan,Shift Planning and Reporting
        const servicePipeline = await buildPipeline('Master Plan,Shift Planning and Reporting', participant, { startDate, endDate }, {}, 'service');
        const hasServiceLimit = serviceLimitParam !== undefined && serviceLimitParam !== null && serviceLimitParam !== '';
        let serviceLimitNumber = hasServiceLimit ? parseInt(serviceLimitParam, 10) : null;
        if (hasServiceLimit && (isNaN(serviceLimitNumber) || serviceLimitNumber <= 0)) {
            serviceLimitNumber = 10;
        }
        const servicePageNumber = hasServiceLimit
            ? (parseInt(servicePage, 10) > 0 ? parseInt(servicePage, 10) : 1)
            : 1;
        const serviceSkip = hasServiceLimit && serviceLimitNumber
            ? (servicePageNumber - 1) * serviceLimitNumber
            : 0;
        const serviceFacetStages = [];
        if (hasServiceLimit && serviceLimitNumber) {
            if (serviceSkip > 0) {
                serviceFacetStages.push({ $skip: serviceSkip });
            }
            serviceFacetStages.push({ $limit: serviceLimitNumber });
        }
        servicePipeline.push(
            { $sort: { updatedAt: -1 } },
            {
                $facet: {
                    items: serviceFacetStages,
                    totalCount: [
                        { $count: 'count' }
                    ]
                }
            }
        );

        let serviceAggResult;
        try {
            // Use allowDiskUse to handle large datasets on memory-constrained servers
            // batchSize helps control memory usage during aggregation
            serviceAggResult = await Item.aggregate(servicePipeline, { 
                allowDiskUse: true,
                batchSize: 1000, // Process in smaller batches to reduce memory pressure
                maxTimeMS: 300000 // 5 minute timeout to prevent hanging
            });
        } catch (aggErr) {
            error('Items-Service', 'Service aggregation pipeline error', {
                message: aggErr.message,
                stack: aggErr.stack,
                workspaceId,
                boardId,
                pipelineLength: servicePipeline.length
            }, extractContextFromReq(req));
            return res.status(500).json({ 
                message: 'Error fetching service items for monthly statement',
                error: aggErr.message 
            });
        }

        const serviceItems = (serviceAggResult[0] && serviceAggResult[0].items) ? serviceAggResult[0].items : [];
        const serviceTotal = (serviceAggResult[0] && serviceAggResult[0].totalCount && serviceAggResult[0].totalCount[0]) ? serviceAggResult[0].totalCount[0].count : 0;

        // Transform service items with specific fields from image (with rate limiting)
        const transformedServiceItems = await batchProcess(
            serviceItems,
            async (item) => {
            const getValue = (attributeName) => {
                return item.data.values.find(v => v.attribute.name === attributeName)?.data;
            };

            // Get participant from Participant Profile
            let participantName = getValue(ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
            const participantProfileValue = getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
            const participantProfileId = Array.isArray(participantProfileValue) ? participantProfileValue[0] : participantProfileValue;
                try {
                    if (participantProfileId) {
                        const participantProfile = await getItemValuesWithRateLimit(workspaceId, boardId, participantProfileId.toString());
                    if (participantProfile && participantProfile.values) {
                        const fullName = participantProfile.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.FULL_NAME)?.data;
                        if (fullName) {
                            participantName = typeof fullName === 'object' ? fullName.name || fullName.toString() : fullName.toString();
                        }
                    }
                }
            } catch (err) {
                // Fallback to participant full name
            }

            // Get Service: second section after "-" of Service Plan ID
            const servicePlanId = getValue(ATTRIBUTE_NAMES.SERVICE_PLAN);
            const servicePlan = servicePlanId?.toString() ? await getItemValuesWithRateLimit(workspaceId, boardId, servicePlanId.toString()) : null;
            let service = undefined;
            if (servicePlan && servicePlan.values) {
                const servicePlanIdValue = servicePlan.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.SERVICE_PLAN_ID)?.data?.toString().trim();
                if (servicePlanIdValue && typeof servicePlanIdValue === 'string' && servicePlanIdValue.includes('-')) {
                    const parts = servicePlanIdValue.split('-');
                    if (parts.length >= 2) {
                        service = parts.slice(1).join('-').trim();
                    }
                } else if (servicePlanIdValue && typeof servicePlanIdValue === 'string') {
                    service = servicePlanIdValue;
                }
            }

            // Get Service Provider based on Delivered by
            const worker = getValue(ATTRIBUTE_NAMES.WORKER_PLANNER)?.toString() || 'N/A';
            const workerName = members.find(m => m.id == worker)?.name || 'Removed User';
            const deliveredByRaw = getValue(ATTRIBUTE_NAMES.DELIVERED_BY);
            const serviceProvider = deliveredByRaw
                ? (typeof deliveredByRaw === 'object' ? deliveredByRaw.name : deliveredByRaw.toString())
                : null;
            // Get dates
            const scheduledStart = getValue(ATTRIBUTE_NAMES.SCHEDULED_START) || null;
            const actualEnd = getValue(ATTRIBUTE_NAMES.ACTUAL_END) || null;
            const scheduledServiceDate = scheduledStart && typeof scheduledStart === 'string'
                ? (scheduledStart.includes('T') ? scheduledStart.split('T')[0] : scheduledStart.split(' ')[0])
                : null;
            const serviceDeliveryDate = actualEnd && typeof actualEnd === 'string'
                ? (actualEnd.includes('T') ? actualEnd.split('T')[0] : actualEnd.split(' ')[0])
                : null;

            // Get other fields
            const transactionStatusRaw = getValue(ATTRIBUTE_NAMES.TRANSACTION_STATUS);
            const transactionStatus = transactionStatusRaw
                ? (typeof transactionStatusRaw === 'object' ? transactionStatusRaw.name : transactionStatusRaw)
                : undefined;
            const committedAtHm = getValue(ATTRIBUTE_NAMES.COMMITTED_AT_HM);
            const committedAtHmForDelivery = committedAtHm !== null && committedAtHm !== undefined
                ? (typeof committedAtHm === 'number' ? committedAtHm : Number(committedAtHm) || 0)
                : undefined;
            const unit = getValue(ATTRIBUTE_NAMES.UNIT) || 'Hour';
            const quantity = Number(getValue(ATTRIBUTE_NAMES.QUANTITY)) || 0;
            const unitPrice = Number(getValue(ATTRIBUTE_NAMES.UNIT_PRICE)) || 0;
            const totalAmount = Number(getValue(ATTRIBUTE_NAMES.TOTAL_AMOUNT)) || 0;
            const govSubsidy = Number(getValue(ATTRIBUTE_NAMES.GOV_SUBSIDY)) || 0;
            const participantContribution = Number(getValue(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)) || 0;
            const fundingSourceRaw = getValue(ATTRIBUTE_NAMES.FUNDING_SOURCE);
            const fundingSource = fundingSourceRaw
                ? (typeof fundingSourceRaw === 'object'
                    ? (fundingSourceRaw.name || fundingSourceRaw.toString())
                    : fundingSourceRaw.toString())
                : 'Home Support';
            const notes = getValue(ATTRIBUTE_NAMES.ADDITIONAL_NOTES) || '';
            
            // Get Care Recipient Identifier (My Aged Care ID Number from Participant Profile)
            let careRecipientIdentifier = undefined;
            if (participantProfileId) {
                try {
                    const participantProfile = await fetchItemValuesCached(participantProfileId.toString());
                    if (participantProfile && participantProfile.values) {
                        const myAgedCareId = participantProfile.values.find(v => 
                            v.attribute.name === ATTRIBUTE_NAMES.MY_AGED_CARE_ID || 
                            v.attribute.name === ATTRIBUTE_NAMES.MY_AGED_CARE_ID_ALT
                        )?.data;
                        if (myAgedCareId) {
                            careRecipientIdentifier = typeof myAgedCareId === 'string' ? myAgedCareId : String(myAgedCareId);
                        }
                    }
                } catch (err) {
                    // Silently fail
                }
            }
            
            // Get Service Identifier from Service Plan
            let serviceIdentifier = '';
            if (servicePlan && servicePlan.values) {
                const serviceIdItemId = servicePlan.values.find(v => 
                    v.attribute.name === 'Service ID / Item ID' || 
                    v.attribute.name === 'Service ID' ||
                    v.attribute.name === 'Item ID'
                )?.data;
                if (serviceIdItemId) {
                    serviceIdentifier = typeof serviceIdItemId === 'string' ? serviceIdItemId : String(serviceIdItemId);
                    // Remove "/" and anything after it
                    if (serviceIdentifier.includes('/')) {
                        serviceIdentifier = serviceIdentifier.split('/')[0].trim();
                    }
                }
            }
            
            // Get Payment Status
            const paymentStatusValue = item.data.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.PAYMENT_STATUS || v.attribute.name === 'Payment Status');
            let paymentStatusFormatted = undefined;
            if (paymentStatusValue) {
                const paymentStatusData = paymentStatusValue.data;
                const labels = paymentStatusValue.attribute?.settings?.labels || [];
                
                if (Array.isArray(paymentStatusData) && paymentStatusData.length > 0) {
                    paymentStatusFormatted = paymentStatusData.map(id => {
                        const label = labels.find(l => l.id === id || (typeof id === 'object' && l.id === id.id));
                        return label ? label.name : (typeof id === 'object' ? id.name : String(id));
                    }).filter(s => s).join(', ');
                } else if (paymentStatusData) {
                    if (typeof paymentStatusData === 'object' && paymentStatusData.id) {
                        const label = labels.find(l => l.id === paymentStatusData.id);
                        paymentStatusFormatted = label ? label.name : (paymentStatusData.name || String(paymentStatusData.id));
                    } else if (typeof paymentStatusData === 'string') {
                        const label = labels.find(l => l.id === paymentStatusData);
                        paymentStatusFormatted = label ? label.name : paymentStatusData;
                    } else {
                        paymentStatusFormatted = String(paymentStatusData);
                    }
                }
            }
            
            // Get Invoice Number
            const invoiceNumber = getValue(ATTRIBUTE_NAMES.INVOICE_NUMBER) || getValue('Generated Invoice Number') || '';
            
            // Get Item ID, Item, Wraparound Item ID, Wraparound Description
            const itemId = getValue('Item ID') || undefined;
            const itemName = getValue('Item') || undefined;
            const wraparoundItemId = getValue('Wraparound Item ID') || undefined;
            const wraparoundDescription = getValue('Wraparound Description') || undefined;
            
            // Get Item or Wraparound
            const itemOrWraparoundRaw = getValue(ATTRIBUTE_NAMES.ITEM_OR_WRAPAROUND);
            let itemOrWraparound = undefined;
            if (itemOrWraparoundRaw) {
                itemOrWraparound = typeof itemOrWraparoundRaw === 'object' ? itemOrWraparoundRaw.name : String(itemOrWraparoundRaw);
            } else if (wraparoundItemId || wraparoundDescription) {
                itemOrWraparound = 'Wraparound';
            } else if (itemId || itemName) {
                itemOrWraparound = 'Item';
            }
            
            // Get Item Description Code
            const itemDescriptionCode = getValue(ATTRIBUTE_NAMES.ITEM_DESCRIPTION_CODE) || undefined;
            
            // Get Item Description
            const itemDescription = getValue(ATTRIBUTE_NAMES.ITEM_DESCRIPTION) || itemName || undefined;
            
            // Get Wraparound Description Code
            const wraparoundDescriptionCode = getValue(ATTRIBUTE_NAMES.WRAPAROUND_DESCRIPTION_CODE) || undefined;
            
            // Get Prescribed Item
            const prescribedItem = getValue('Prescribed Item');
            const prescribedItemValue = prescribedItem === true || prescribedItem === 'true' || prescribedItem === 'Y' ? 'Y' : 'N';
            
            // Get Item Purchased Method
            const itemPurchasedMethod = getValue('Item Purchased Method');
            const itemPurchasedMethodString = itemPurchasedMethod 
                ? (typeof itemPurchasedMethod === 'object' ? itemPurchasedMethod.name : String(itemPurchasedMethod))
                : undefined;
            
            // Get Associated Provider and Associated Provider Invoice No
            const associatedProvider = getValue(ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER);
            const associatedProviderString = associatedProvider 
                ? (typeof associatedProvider === 'object' ? associatedProvider.name : String(associatedProvider))
                : undefined;
            const associatedProviderInvoiceNo = getValue('Associated Provider Invoice No. (if applicable)') || 
                                               getValue('Associated Provider Invoice No') || 
                                               undefined;
            
            // Get Loaned by Organisation Name
            const loanedByOrganisationName = getValue(ATTRIBUTE_NAMES.LOANED_BY_ORGANISATION_NAME) || 
                                           associatedProviderString || 
                                           undefined;
            
            // Get Health Professional Type Code and Health Professional Type Other
            let healthProfessionalTypeCode = undefined;
            let healthProfessionalTypeOther = undefined;
            if (servicePlan && servicePlan.values) {
                const healthProfessionalValue = servicePlan.values.find(v => 
                    v.attribute.name === 'Health Professional' ||
                    v.attribute.name === 'Health Professional Service'
                )?.data;
                if (healthProfessionalValue) {
                    try {
                        const healthProfessionalId = Array.isArray(healthProfessionalValue) 
                            ? healthProfessionalValue[0] 
                            : (typeof healthProfessionalValue === 'object' ? healthProfessionalValue.id : healthProfessionalValue);
                        if (healthProfessionalId) {
                            const healthProfessionalService = await fetchItemValuesCached(healthProfessionalId.toString());
                            if (healthProfessionalService && healthProfessionalService.values) {
                                const hpTypeCode = healthProfessionalService.values.find(v => 
                                    v.attribute.name === 'Health Professional Type Code'
                                )?.data;
                                if (hpTypeCode) {
                                    healthProfessionalTypeCode = typeof hpTypeCode === 'string' ? hpTypeCode : String(hpTypeCode);
                                }
                                
                                const hpTypeOther = healthProfessionalService.values.find(v => 
                                    v.attribute.name === 'Health Professional Type Other'
                                )?.data;
                                if (hpTypeOther) {
                                    healthProfessionalTypeOther = typeof hpTypeOther === 'string' ? hpTypeOther : String(hpTypeOther);
                                }
                            }
                        }
                    } catch (err) {
                        // Silently fail
                    }
                }
            }
            
            // Get Item First Payment flag
            const itemFirstPaymentRaw = getValue('Item First Payment');
            let itemFirstPaymentValue = undefined;
            if (typeof itemFirstPaymentRaw === 'boolean') {
                itemFirstPaymentValue = itemFirstPaymentRaw ? 'Y' : 'N';
            } else if (typeof itemFirstPaymentRaw === 'string') {
                const normalized = itemFirstPaymentRaw.trim().toLowerCase();
                itemFirstPaymentValue = (normalized === 'true' || normalized === 'y' || normalized === 'yes') ? 'Y' : 'N';
            } else if (itemFirstPaymentRaw !== undefined && itemFirstPaymentRaw !== null) {
                itemFirstPaymentValue = String(itemFirstPaymentRaw).trim().toLowerCase() === 'y' ? 'Y' : 'N';
            }
            
            // Get Delivered By Third Party
            const deliveredByThirdPartyRaw = getValue(ATTRIBUTE_NAMES.DELIVERED_BY_THIRD_PARTY);
            let deliveredByThirdParty = undefined;
            if (deliveredByThirdPartyRaw !== undefined && deliveredByThirdPartyRaw !== null) {
                if (typeof deliveredByThirdPartyRaw === 'boolean') {
                    deliveredByThirdParty = deliveredByThirdPartyRaw ? 'true' : 'false';
                } else if (typeof deliveredByThirdPartyRaw === 'string') {
                    const normalized = deliveredByThirdPartyRaw.trim().toLowerCase();
                    deliveredByThirdParty = (normalized === 'true' || normalized === 'y' || normalized === 'yes') ? 'true' : 'false';
                } else {
                    deliveredByThirdParty = String(deliveredByThirdPartyRaw).trim().toLowerCase() === 'y' ? 'true' : 'false';
                }
            }

            return {
                id: item.itemId,
                paymentStatus: paymentStatusFormatted,
                participant,
                service,
                scheduledServiceDate,
                serviceDeliveryDate,
                unit,
                quantity,
                unitPrice,
                totalAmount,
                govSubsidy,
                participantContribution,
                fundingSource,
                notes,
                // CSV export fields
                invoiceNumber,
                careRecipientIdentifier,
                serviceIdentifier,
                deliveredBy: deliveredByString,
                serviceProvider,
                participantProfileId: participantProfileId ? participantProfileId.toString() : null,
                invoiceNumber,
                itemId,
                item: itemName,
                itemOrWraparound,
                itemDescriptionCode,
                itemDescription,
                wraparoundItemId,
                wraparoundDescription,
                wraparoundDescriptionCode,
                prescribedItem: prescribedItemValue,
                itemPurchasedMethod: itemPurchasedMethodString,
                associatedProvider: associatedProviderString,
                associatedProviderInvoiceNo,
                loanedByOrganisationName,
                healthProfessionalTypeCode,
                healthProfessionalTypeOther,
                itemFirstPayment: itemFirstPaymentValue,
                deliveredByThirdParty
            };
            },
            { batchSize: 2, delayBetweenBatches: 600, delayBetweenRequests: 150 }
        );

        const budgetCategoryAggregates = {};
        const createBudgetAggregate = () => ({
            availableFunds: 0,
            remainingBudget: 0,
            serviceDeliveredAmount: 0,
            adjustmentAmount: 0,
            govSubsidyAmount: 0,
            participantContributionAmount: 0,
            committedFunds: 0,
            serviceCount: 0,
            fundingStartDate: null,
            fundingEndDate: null,
            months: new Set(),
            availableFundStart: 0,
            quarterlyAdjustment: 0,
            primarySupplementAmount: 0,
            carryoverFunding: 0,
            unspentReturned: 0,
            commonwealthUnspent: 0,
            providerUnspent: 0,
            participantUnspent: 0,
            previousMonthSpending: 0,
            fundAmount: 0,
            shouldDisplay: false
        });

        transformedServiceItems.forEach(service => {
            const code = determineCategoryCodeForService(service);
            if (!budgetCategoryAggregates[code]) {
                budgetCategoryAggregates[code] = createBudgetAggregate();
            }
            const aggregate = budgetCategoryAggregates[code];
            aggregate.govSubsidyAmount += Number(service.govSubsidy) || 0;
            aggregate.participantContributionAmount += Number(service.participantContribution) || 0;
            aggregate.serviceCount += 1;
        });

        const summaryTotals = transformedServiceItems.reduce((acc, service) => {
            const quantity = Number(service.quantity) || 0;
            const totalAmount = Number(service.totalAmount) || 0;
            const gov = Number(service.govSubsidy) || 0;
            const participantContribution = Number(service.participantContribution) || 0;
            const unit = (service.unit || '').toString().toLowerCase();
            const hours = unit.includes('hour') ? quantity : 0;
            return {
                totalServices: acc.totalServices + 1,
                totalHours: acc.totalHours + hours,
                totalAmount: acc.totalAmount + totalAmount,
                govSubsidy: acc.govSubsidy + gov,
                participantContribution: acc.participantContribution + participantContribution
            };
        }, { totalServices: 0, totalHours: 0, totalAmount: 0, govSubsidy: 0, participantContribution: 0 });

        const summary = {
            ...summaryTotals,
            averageServiceCost: summaryTotals.totalServices > 0
                ? summaryTotals.totalAmount / summaryTotals.totalServices
                : 0
        };

        const budgetTotal = filteredBudgetItems.length;

        filteredBudgetItems.forEach(item => {
            const code = item.categoryCode || 'HSQ';
            if (!budgetCategoryAggregates[code]) {
                budgetCategoryAggregates[code] = createBudgetAggregate();
            }

            const aggregate = budgetCategoryAggregates[code];
            aggregate.availableFunds += item.totalAvailableBudget || 0;
            aggregate.remainingBudget += item.remainingBalance || 0;
            aggregate.serviceDeliveredAmount += item.deliveredAmount || 0;
            aggregate.adjustmentAmount += item.adjustmentAmount || 0;
            aggregate.govSubsidyAmount += item.govSubsidyAmount || 0;
            aggregate.participantContributionAmount += item.participantContributionAmount || 0;
            aggregate.committedFunds += item.committedFunds || 0;
            aggregate.availableFundStart += item.availableFundStart || 0;
            aggregate.quarterlyAdjustment += item.quarterlyAdjustment || 0;
            aggregate.primarySupplementAmount += item.primarySupplementAmount || 0;
            aggregate.carryoverFunding += item.carryoverFunding || 0;
            aggregate.unspentReturned += item.unspentReturned || 0;
            aggregate.commonwealthUnspent += item.commonwealthUnspent || 0;
            aggregate.providerUnspent += item.providerUnspent || 0;
            aggregate.participantUnspent += item.participantUnspent || 0;
            aggregate.previousMonthSpending += item.previousMonthSpending || 0;
            aggregate.fundAmount += item.fundAmount || 0;

            if (item.fundingStartDate) {
                if (!aggregate.fundingStartDate || new Date(item.fundingStartDate) < new Date(aggregate.fundingStartDate)) {
                    aggregate.fundingStartDate = item.fundingStartDate;
                }
            }

            if (item.fundingEndDate) {
                if (!aggregate.fundingEndDate || new Date(item.fundingEndDate) > new Date(aggregate.fundingEndDate)) {
                    aggregate.fundingEndDate = item.fundingEndDate;
                }
            }

            const monthLabel = item.month ? (item.year ? `${item.month} ${item.year}` : item.month) : (item.year || null);
            if (monthLabel) {
                aggregate.months.add(monthLabel);
            }
        });

        Object.values(budgetCategoryAggregates).forEach(aggregate => {
            if (aggregate.months && aggregate.months.size > 0) {
                aggregate.expenditurePeriodLabel = Array.from(aggregate.months).join(', ');
            }
            if (aggregate.fundingStartDate || aggregate.fundingEndDate) {
                aggregate.availableBalanceRangeLabel = [aggregate.fundingStartDate, aggregate.fundingEndDate].filter(Boolean).join(' - ');
            }
            const visibilityFields = [
                aggregate.availableFunds,
                aggregate.remainingBudget,
                aggregate.serviceDeliveredAmount,
                aggregate.adjustmentAmount,
                aggregate.committedFunds,
                aggregate.previousMonthSpending,
                aggregate.fundAmount
            ];
            aggregate.shouldDisplay = visibilityFields.some(value => Math.abs(value || 0) > 0.009);
            delete aggregate.months;
        });

        let participantProfileId = filteredBudgetItems.find(item => item.participantProfileId)?.participantProfileId || null;
        if (!participantProfileId) {
            participantProfileId = transformedServiceItems.find(service => service.participantProfileId)?.participantProfileId || null;
        }
        if (!participantProfileId) {
            const rawServiceWithProfile = serviceItems.find(rawItem =>
                rawItem?.data?.values?.some(v => v.attribute.name === ATTRIBUTE_NAMES.PARTICIPANT_PROFILE && v.data)
            );
            if (rawServiceWithProfile) {
                const profileValue = rawServiceWithProfile.data.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.PARTICIPANT_PROFILE)?.data;
                if (Array.isArray(profileValue) && profileValue.length > 0) {
                    participantProfileId = profileValue[0].toString();
                } else if (profileValue) {
                    participantProfileId = profileValue.toString();
                }
            }
        }

        const extractProfileString = (value) => {
            if (value === null || value === undefined) {
                return '';
            }
            if (typeof value === 'object' && value.name) {
                return value.name;
            }
            return value.toString ? value.toString() : '';
        };

        let participantProfileValues = null;
        let participantFullName = typeof participant === 'string' ? participant : '';
        let participantAddress = '';
        let participantSuburb = '';
        let participantState = '';
        let participantPostcode = '';
        let myAgedCareIdNumber = '';
        let providerIdFromProfile = '';

        if (participantProfileId) {
            participantProfileValues = await fetchItemValuesCached(participantProfileId);
        }

        if (participantProfileValues?.values) {
            const getProfileValue = (attributeName) => {
                const entry = participantProfileValues.values.find(v => v.attribute.name === attributeName);
                if (!entry || entry.data === null || entry.data === undefined) {
                    return '';
                }
                if (Array.isArray(entry.data) && entry.data.length > 0) {
                    return extractProfileString(entry.data[0]);
                }
                return extractProfileString(entry.data);
            };

            participantFullName = getProfileValue(ATTRIBUTE_NAMES.FULL_NAME) ||
                getProfileValue(ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) ||
                participantFullName;
            participantAddress = getProfileValue(ATTRIBUTE_NAMES.ADDRESS) || participantAddress;
            participantSuburb = getProfileValue(ATTRIBUTE_NAMES.SUBURB) || participantSuburb;
            participantState = getProfileValue(ATTRIBUTE_NAMES.STATE) || participantState;
            participantPostcode = getProfileValue(ATTRIBUTE_NAMES.POSTCODE) ||
                getProfileValue(ATTRIBUTE_NAMES.POST_CODE) ||
                participantPostcode;
            myAgedCareIdNumber = getProfileValue(ATTRIBUTE_NAMES.MY_AGED_CARE_ID) ||
                getProfileValue(ATTRIBUTE_NAMES.MY_AGED_CARE_ID_ALT) ||
                myAgedCareIdNumber;
            providerIdFromProfile = getProfileValue(ATTRIBUTE_NAMES.PROVIDER_ID) || providerIdFromProfile;
        }

        let budgetDataFromProfile = null;
        if (participantProfileId) {
            try {
                budgetDataFromProfile = await getMonthlyStatementBudgetData(workspaceId, boardId, participantProfileId);
            } catch (err) {
                warn('Items-Service', 'Failed to fetch budget data from profile', {
                    message: err.message,
                    participantProfileId
                }, extractContextFromReq(req));
            }
        }

        const getQuarterMonths = (monthNum) => {
            const numericMonth = parseInt(monthNum, 10) || 1;
            if (numericMonth >= 1 && numericMonth <= 3) return { start: 'January', end: 'March' };
            if (numericMonth >= 4 && numericMonth <= 6) return { start: 'April', end: 'June' };
            if (numericMonth >= 7 && numericMonth <= 9) return { start: 'July', end: 'September' };
            return { start: 'October', end: 'December' };
        };

        const monthNum = parseInt(month, 10) || 1;
        const yearStr = (year || new Date().getFullYear().toString()).toString();
        const quarterMonths = getQuarterMonths(monthNum);
        const defaultFundingEndDate = new Date(parseInt(yearStr, 10), 11, 31).toISOString();

        const budgetCategories = BUDGET_CATEGORY_CONFIG.map(config => {
            const profileData = budgetDataFromProfile?.[config.profileKey] || {};
            const budgetAggregate = budgetCategoryAggregates[config.code] || createBudgetAggregate();

            const categoryName = config.code === 'HSQ'
                ? `Home Support Quarterly Budget ${quarterMonths.start} ~ ${quarterMonths.end} ${yearStr}`
                : config.folderName;

            return {
                name: categoryName,
                code: config.code,
                availableFunds: budgetAggregate.availableFunds || profileData.totalAvailableBudget || 0,
                remainingBudget: budgetAggregate.remainingBudget || profileData.remainingBalance || 0,
                fundingEndDate: budgetAggregate.fundingEndDate || profileData.fundingEndDate || defaultFundingEndDate,
                committedFunds: budgetAggregate.committedFunds || profileData.committedFunds || 0,
                serviceDeliveredAmount: budgetAggregate.serviceDeliveredAmount || 0,
                govSubsidyAmount: budgetAggregate.govSubsidyAmount || 0,
                participantContributionAmount: budgetAggregate.participantContributionAmount || 0,
                adjustmentAmount: budgetAggregate.adjustmentAmount || 0,
                serviceCount: budgetAggregate.serviceCount || 0,
                quarterStartMonth: config.code === 'HSQ' ? quarterMonths.start : undefined,
                quarterEndMonth: config.code === 'HSQ' ? quarterMonths.end : undefined,
                availableBalanceRangeLabel: budgetAggregate.availableBalanceRangeLabel || undefined,
                expenditurePeriodLabel: budgetAggregate.expenditurePeriodLabel || undefined,
                availableFundStart: budgetAggregate.availableFundStart || profileData.availableFundStart || 0,
                quarterlyAdjustment: budgetAggregate.quarterlyAdjustment || profileData.quarterlyAdjustment || 0,
                primarySupplementAmount: budgetAggregate.primarySupplementAmount || profileData.primarySupplementAmount || 0,
                carryoverFunding: budgetAggregate.carryoverFunding || profileData.carryoverFunding || 0,
                unspentReturned: budgetAggregate.unspentReturned || profileData.unspentReturned || 0,
                commonwealthUnspent: budgetAggregate.commonwealthUnspent || profileData.commonwealthUnspent || 0,
                providerUnspent: budgetAggregate.providerUnspent || profileData.providerUnspent || 0,
                participantUnspent: budgetAggregate.participantUnspent || profileData.participantUnspent || 0,
                previousMonthSpending: budgetAggregate.previousMonthSpending || profileData.previousMonthSpending || 0,
                fundAmount: budgetAggregate.fundAmount || profileData.fundAmount || 0,
                shouldDisplay: Boolean(budgetAggregate.shouldDisplay)
            };
        });

        const providerIdValue = businessProfile?.companyRegistrationId || providerIdFromProfile || null;
        const monthLabelForResponse = targetMonthLabel ||
            (normalizedMonth && monthLabelLookup[normalizedMonth]) ||
            normalizedMonth ||
            '';
        const monthNumberForResponse = normalizedMonth || (typeof month === 'string' ? month : '');
        const participantNameForResponse = participantFullName || (typeof participant === 'string' ? participant : '');

        res.status(200).json({
            budgetItems: {
                items: paginatedBudgetItems,
                total: budgetTotal,
                page: budgetPageNumber,
                limit: budgetLimitNumber
            },
            serviceItems: {
                items: transformedServiceItems,
                total: serviceTotal,
                page: servicePageNumber,
                limit: serviceLimitNumber
            },
            budgetCategories,
            participant: participantNameForResponse,
            participantProfile: participantNameForResponse,
            participantAddress,
            participantSuburb,
            participantState,
            participantPostcode,
            myAgedCareIdNumber,
            providerId: providerIdValue,
            month: monthLabelForResponse,
            monthNumber: monthNumberForResponse,
            year: yearStr,
            summary
        });
    } catch (err) {
        error('Items-Service', 'Failed to fetch monthly statement data', {
            message: err.message
        }, extractContextFromReq(req));
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/:workspaceId/:boardId/update-status', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        const { itemIds, invoiceNumber, status, fileUrl } = req.body;

        if (!workspaceId || !boardId) {
            return res.status(400).json({ message: 'WorkspaceId and BoardId are required' });
        }

        if (!Array.isArray(itemIds) || itemIds.length === 0) {
            return res.status(400).json({ message: 'itemIds must be a non-empty array' });
        }

        const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : null;
        let invoiceIssuedValue;
        if (normalizedStatus === 'invoiced') {
            invoiceIssuedValue = true;
        } else if (normalizedStatus === 'pending' || normalizedStatus === 'not invoiced') {
            invoiceIssuedValue = false;
        }

        const results = [];

        for (const itemId of itemIds) {
            try {
                const item = await Item.findOne({ workspaceId, boardId, itemId }).lean();
                if (!item) {
                    results.push({
                        itemId,
                        updated: false,
                        reason: 'ITEM_NOT_FOUND'
                    });
                    continue;
                }

                const values = Array.isArray(item.data?.values) ? item.data.values : [];
                if (!Array.isArray(values) || values.length === 0) {
                    results.push({
                        itemId,
                        updated: false,
                        reason: 'NO_VALUES_ON_ITEM'
                    });
                    continue;
                }

                let changed = false;
                const missingRequiredAttributes = [];

                const updateAttribute = (attributeName, newData, options = { required: true }) => {
                    const { required } = options;
                    const index = values.findIndex(v => v?.attribute?.name === attributeName);
                    if (index === -1) {
                        if (required) {
                            missingRequiredAttributes.push(attributeName);
                        }
                        return false;
                    }

                    const currentData = values[index].data;
                    const nextData = typeof newData === 'function' ? newData(currentData, values[index]) : newData;
                    if (nextData !== undefined && nextData !== currentData) {
                        values[index] = { ...values[index], data: nextData };
                        changed = true;
                        return true;
                    }
                    return false;
                };

                if (invoiceIssuedValue !== undefined) {
                    updateAttribute('Invoice Issued and Sent', invoiceIssuedValue);
                }

                if (invoiceNumber) {
                    updateAttribute('Generated Invoice Number', invoiceNumber);
                }

                if (fileUrl) {
                    const optionalFileAttributes = [
                        'Invoice File URL',
                        'Invoice PDF Link',
                        'Generated Invoice File URL',
                        'Generated Invoice Link'
                    ];
                    const fileAttrUpdated = optionalFileAttributes.some(attr =>
                        updateAttribute(attr, fileUrl, { required: false })
                    );
                    if (!fileAttrUpdated) {
                        info('Items-Service', 'No matching attribute found for invoice file URL', {
                            itemId,
                            workspaceId,
                            boardId
                        });
                    }
                }

                if (!changed) {
                    results.push({
                        itemId,
                        updated: false,
                        reason: missingRequiredAttributes.length ? 'MISSING_REQUIRED_ATTRIBUTES' : 'NO_CHANGES_REQUIRED',
                        missingAttributes: missingRequiredAttributes
                    });
                    continue;
                }

                item.data = { ...item.data, values };
                item.markModified('data.values');
                await item.save();

                results.push({
                    itemId,
                    updated: true,
                    missingAttributes: missingRequiredAttributes
                });
            } catch (itemErr) {
                error('Items-Service', 'Failed to update invoice status for item', {
                    message: itemErr.message,
                    itemId,
                    workspaceId,
                    boardId
                }, extractContextFromReq(req));
                results.push({
                    itemId,
                    updated: false,
                    reason: 'UPDATE_FAILED',
                    error: itemErr.message
                });
            }
        }

        const updatedCount = results.filter(r => r.updated).length;
        const failedCount = results.length - updatedCount;

        info('Items-Service', 'Invoice statuses updated', {
            workspaceId,
            boardId,
            updatedCount,
            failedCount
        }, extractContextFromReq(req));

        res.status(200).json({
            updatedCount,
            failedCount,
            results
        });
    } catch (err) {
        error('Items-Service', 'Failed to update invoice statuses', {
            message: err.message
        }, extractContextFromReq(req));
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/:workspaceId/:boardId/:itemId', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId, itemId } = req.params;

        if (!itemId || !workspaceId || !boardId) {
            return res.status(400).json({
                message: 'WorkspaceId, BoardId, and ItemId are required'
            });
        }

        const item = await Item.findOne({
            itemId,
            workspaceId,
            boardId
        }).lean();

        if (!item) {
            warn('Items-Service', 'Item not found', {
                workspaceId, boardId, itemId
            }, extractContextFromReq(req));
            return res.status(404).json({ message: 'Item not found' });
        }

        info('Items-Service', 'Successfully fetched item', {
            itemId
        }, extractContextFromReq(req));

        res.status(200).json(item);
    } catch (err) {
        error('Items-Service', 'Failed to fetch item', {
            message: err.message
        }, extractContextFromReq(req));
        res.status(500).json({ message: 'Server error' });
    }
});

export default router;