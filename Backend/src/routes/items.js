import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Item from '../models/Item.js';
import Business from '../models/Business.js';
import { info, error, warn, extractContextFromReq } from '../utils/logger.js';
import { getItemValues, getFolder, getMember, getMonthlyStatementBudgetData } from '../services/isoplus.js';

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
    COMMONWEALTH_UNSPENT_FUNDS: 'Commonwealth-held HCP Unspent Funds ($)',
    PROVIDER_UNSPENT_FUNDS: 'Provider-held HCP Unspent Funds ($)',
    PARTICIPANT_UNSPENT_FUNDS: 'Participant Portion HCP Unspent Funds ($)',
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
    COMMITTED_HOME_MODIFICATION: 'Committed HM Funds - to be delivered ($-)'
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
    { code: 'RCP', folderName: FUNDING_SOURCE_TYPES.RESTORATIVE_CARE, profileKey: 'restorativeCare' },
    { code: 'EOL', folderName: FUNDING_SOURCE_TYPES.END_OF_LIFE, profileKey: 'endOfLife' },
    { code: 'ATS', folderName: FUNDING_SOURCE_TYPES.ASSISTIVE_TECH_SHORT, profileKey: 'assistiveTechShortTerm' },
    { code: 'ATO', folderName: FUNDING_SOURCE_TYPES.ASSISTIVE_TECH_ONGOING, profileKey: 'assistiveTechOngoing' },
    { code: 'HMB', folderName: FUNDING_SOURCE_TYPES.HOME_MODIFICATION, profileKey: 'homeModification' }
];

const DELIVERED_BY_TYPES = {
    COMPANY_WORKFORCE: 'company workforce',
    ASSOCIATED_PROVIDERS: 'associated providers'
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

router.get('/:workspaceId/:boardId/invoice-generator', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        const { members } = await getMember(req.session.Authorization, workspaceId);
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
            limit: limitParam
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

        // Build aggregation pipeline
        const pipeline = [];

        // Base match - only from Master Plan,Shift Planning and Reporting
        const baseMatch = { workspaceId, boardId };
        const folderIds = await getFolderIds('Master Plan,Shift Planning and Reporting', workspaceId, boardId);
        if (folderIds && folderIds.length > 0) {
            baseMatch.folderId = { $in: folderIds };
        }
        pipeline.push({ $match: baseMatch });

        // Use the same aggregation pipeline structure
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
                    participantValue: {
                        $filter: {
                            input: "$data.values",
                            as: "value",
                            cond: { $eq: ["$$value.attribute.name", "Participant Full Name"] }
                        }
                    },
                    invoiceIssuedValue: {
                        $filter: {
                            input: "$data.values",
                            as: "value",
                            cond: { $eq: ["$$value.attribute.name", "Invoice Issued and Sent"] }
                        }
                    },
                    paymentStatusValue: {
                        $filter: {
                            input: "$data.values",
                            as: "value",
                            cond: { $eq: ["$$value.attribute.name", "Payment Status"] }
                        }
                    },
                    transactionStatusValue: {
                        $filter: {
                            input: "$data.values",
                            as: "value",
                            cond: { $eq: ["$$value.attribute.name", ATTRIBUTE_NAMES.TRANSACTION_STATUS] }
                        }
                    },
                    totalAmountValue: {
                        $filter: {
                            input: "$data.values",
                            as: "value",
                            cond: { $eq: ["$$value.attribute.name", ATTRIBUTE_NAMES.TOTAL_AMOUNT] }
                        }
                    },
                    govSubsidyValue: {
                        $filter: {
                            input: "$data.values",
                            as: "value",
                            cond: { $eq: ["$$value.attribute.name", ATTRIBUTE_NAMES.GOV_SUBSIDY] }
                        }
                    },
                    participantContributionValue: {
                        $filter: {
                            input: "$data.values",
                            as: "value",
                            cond: { $eq: ["$$value.attribute.name", ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION] }
                        }
                    },
                    actualEndValue: {
                        $filter: {
                            input: "$data.values",
                            as: "value",
                            cond: { $eq: ["$$value.attribute.name", ATTRIBUTE_NAMES.ACTUAL_END] }
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
                    participantNameRaw: {
                        $let: {
                            vars: { firstVal: { $arrayElemAt: ["$participantValue", 0] } },
                            in: { $ifNull: ["$$firstVal.data", null] }
                        }
                    },
                    invoiceIssuedRaw: {
                        $let: {
                            vars: { firstVal: { $arrayElemAt: ["$invoiceIssuedValue", 0] } },
                            in: { $ifNull: [{ $ifNull: ["$$firstVal.data", false] }, false] }
                        }
                    },
                    paymentStatusRaw: {
                        $let: {
                            vars: { firstVal: { $arrayElemAt: ["$paymentStatusValue", 0] } },
                            in: { $ifNull: [{ $ifNull: ["$$firstVal.data", []] }, []] }
                        }
                    },
                    paymentStatusAttribute: {
                        $let: {
                            vars: { firstVal: { $arrayElemAt: ["$paymentStatusValue", 0] } },
                            in: { $ifNull: ["$$firstVal.attribute", null] }
                        }
                    },
                    transactionStatusRaw: {
                        $let: {
                            vars: { firstVal: { $arrayElemAt: ["$transactionStatusValue", 0] } },
                            in: { $ifNull: ["$$firstVal.data", null] }
                        }
                    },
                    transactionStatusAttribute: {
                        $let: {
                            vars: { firstVal: { $arrayElemAt: ["$transactionStatusValue", 0] } },
                            in: { $ifNull: ["$$firstVal.attribute", null] }
                        }
                    },
                    totalAmountRaw: {
                        $let: {
                            vars: {
                                firstVal: { $arrayElemAt: ["$totalAmountValue", 0] }
                            },
                            in: {
                                $cond: {
                                    if: { $ne: ["$$firstVal", null] },
                                    then: {
                                        $cond: {
                                            if: { $ne: ["$$firstVal.data", null] },
                                            then: "$$firstVal.data",
                                            else: 0
                                        }
                                    },
                                    else: 0
                                }
                            }
                        }
                    },
                    govSubsidyRaw: {
                        $let: {
                            vars: {
                                firstVal: { $arrayElemAt: ["$govSubsidyValue", 0] }
                            },
                            in: {
                                $cond: {
                                    if: { $ne: ["$$firstVal", null] },
                                    then: {
                                        $cond: {
                                            if: { $ne: ["$$firstVal.data", null] },
                                            then: "$$firstVal.data",
                                            else: 0
                                        }
                                    },
                                    else: 0
                                }
                            }
                        }
                    },
                    participantContributionRaw: {
                        $let: {
                            vars: {
                                firstVal: { $arrayElemAt: ["$participantContributionValue", 0] }
                            },
                            in: {
                                $cond: {
                                    if: { $ne: ["$$firstVal", null] },
                                    then: {
                                        $cond: {
                                            if: { $ne: ["$$firstVal.data", null] },
                                            then: "$$firstVal.data",
                                            else: 0
                                        }
                                    },
                                    else: 0
                                }
                            }
                        }
                    },
                    actualEndRaw: {
                        $let: {
                            vars: { firstVal: { $arrayElemAt: ["$actualEndValue", 0] } },
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
                    },
                    invoicedFlag: {
                        $or: [
                            { $toBool: "$invoiceIssuedRaw" },
                            {
                                $in: [
                                    "Paid",
                                    {
                                        $map: {
                                            input: "$paymentStatusRaw",
                                            as: "p",
                                            in: "$$p.name"
                                        }
                                    }
                                ]
                            }
                        ]
                    },
                    totalAmountNum: {
                        $cond: {
                            if: {
                                $in: [
                                    { $type: "$totalAmountRaw" },
                                    ["int", "long", "double", "decimal128"]
                                ]
                            },
                            then: { $ifNull: ["$totalAmountRaw", 0] },
                            else: {
                                $let: {
                                    vars: {
                                        match: {
                                            $regexFind: {
                                                input: { $ifNull: ["$totalAmountRaw", "0"] },
                                                regex: "-?\\d+(?:\\.\\d+)?"
                                            }
                                        }
                                    },
                                    in: {
                                        $cond: {
                                            if: { $ne: ["$$match", null] },
                                            then: {
                                                $convert: {
                                                    input: "$$match.match",
                                                    to: "double",
                                                    onError: 0,
                                                    onNull: 0
                                                }
                                            },
                                            else: 0
                                        }
                                    }
                                }
                            }
                        }
                    },
                    govSubsidyNum: {
                        $cond: {
                            if: {
                                $in: [
                                    { $type: "$govSubsidyRaw" },
                                    ["int", "long", "double", "decimal128"]
                                ]
                            },
                            then: { $ifNull: ["$govSubsidyRaw", 0] },
                            else: {
                                $let: {
                                    vars: {
                                        match: {
                                            $regexFind: {
                                                input: { $ifNull: ["$govSubsidyRaw", "0"] },
                                                regex: "-?\\d+(?:\\.\\d+)?"
                                            }
                                        }
                                    },
                                    in: {
                                        $cond: {
                                            if: { $ne: ["$$match", null] },
                                            then: {
                                                $convert: {
                                                    input: "$$match.match",
                                                    to: "double",
                                                    onError: 0,
                                                    onNull: 0
                                                }
                                            },
                                            else: 0
                                        }
                                    }
                                }
                            }
                        }
                    },
                    participantContributionNum: {
                        $cond: {
                            if: {
                                $in: [
                                    { $type: "$participantContributionRaw" },
                                    ["int", "long", "double", "decimal128"]
                                ]
                            },
                            then: { $ifNull: ["$participantContributionRaw", 0] },
                            else: {
                                $let: {
                                    vars: {
                                        match: {
                                            $regexFind: {
                                                input: { $ifNull: ["$participantContributionRaw", "0"] },
                                                regex: "-?\\d+(?:\\.\\d+)?"
                                            }
                                        }
                                    },
                                    in: {
                                        $cond: {
                                            if: { $ne: ["$$match", null] },
                                            then: {
                                                $convert: {
                                                    input: "$$match.match",
                                                    to: "double",
                                                    onError: 0,
                                                    onNull: 0
                                                }
                                            },
                                            else: 0
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            {
                // Convert label IDs to label names for transaction status and payment status
                $addFields: {
                    transactionStatusNames: {
                        $cond: [
                            { $eq: [{ $type: "$transactionStatusRaw" }, "array"] },
                            {
                                // Map array of label IDs to label names
                                $map: {
                                    input: "$transactionStatusRaw",
                                    as: "labelId",
                                    in: {
                                        $let: {
                                            vars: {
                                                label: {
                                                    $arrayElemAt: [
                                                        {
                                                            $filter: {
                                                                input: { $ifNull: ["$transactionStatusAttribute.settings.labels", []] },
                                                                as: "l",
                                                                cond: { $eq: ["$$l.id", "$$labelId"] }
                                                            }
                                                        },
                                                        0
                                                    ]
                                                }
                                            },
                                            in: { $ifNull: ["$$label.name", "$$labelId"] }
                                        }
                                    }
                                }
                            },
                            {
                                $cond: [
                                    { $eq: [{ $type: "$transactionStatusRaw" }, "object"] },
                                    {
                                        // If it's an object with id, look it up
                                        $let: {
                                            vars: {
                                                label: {
                                                    $arrayElemAt: [
                                                        {
                                                            $filter: {
                                                                input: { $ifNull: ["$transactionStatusAttribute.settings.labels", []] },
                                                                as: "l",
                                                                cond: { $eq: ["$$l.id", "$transactionStatusRaw.id"] }
                                                            }
                                                        },
                                                        0
                                                    ]
                                                }
                                            },
                                            in: { $ifNull: ["$$label.name", { $ifNull: ["$transactionStatusRaw.name", ""] }] }
                                        }
                                    },
                                    {
                                        // If it's a string (label ID), look it up
                                        $let: {
                                            vars: {
                                                label: {
                                                    $arrayElemAt: [
                                                        {
                                                            $filter: {
                                                                input: { $ifNull: ["$transactionStatusAttribute.settings.labels", []] },
                                                                as: "l",
                                                                cond: { $eq: ["$$l.id", "$transactionStatusRaw"] }
                                                            }
                                                        },
                                                        0
                                                    ]
                                                }
                                            },
                                            in: { $ifNull: ["$$label.name", { $convert: { input: "$transactionStatusRaw", to: "string", onError: "", onNull: "" } }] }
                                        }
                                    }
                                ]
                            }
                        ]
                    },
                    paymentStatusNames: {
                        $cond: [
                            { $eq: [{ $type: "$paymentStatusRaw" }, "array"] },
                            {
                                // Map array of label IDs to label names
                                $map: {
                                    input: "$paymentStatusRaw",
                                    as: "labelId",
                                    in: {
                                        $let: {
                                            vars: {
                                                label: {
                                                    $arrayElemAt: [
                                                        {
                                                            $filter: {
                                                                input: { $ifNull: ["$paymentStatusAttribute.settings.labels", []] },
                                                                as: "l",
                                                                cond: { $eq: ["$$l.id", "$$labelId"] }
                                                            }
                                                        },
                                                        0
                                                    ]
                                                }
                                            },
                                            in: { $ifNull: ["$$label.name", "$$labelId"] }
                                        }
                                    }
                                }
                            },
                            {
                                $cond: [
                                    { $eq: [{ $type: "$paymentStatusRaw" }, "object"] },
                                    {
                                        // If it's an object with id, look it up
                                        $let: {
                                            vars: {
                                                label: {
                                                    $arrayElemAt: [
                                                        {
                                                            $filter: {
                                                                input: { $ifNull: ["$paymentStatusAttribute.settings.labels", []] },
                                                                as: "l",
                                                                cond: { $eq: ["$$l.id", "$paymentStatusRaw.id"] }
                                                            }
                                                        },
                                                        0
                                                    ]
                                                }
                                            },
                                            in: { $ifNull: ["$$label.name", { $ifNull: ["$paymentStatusRaw.name", ""] }] }
                                        }
                                    },
                                    ""
                                ]
                            }
                        ]
                    }
                }
            }
        );

        // Dynamic matches based on filters
        const andConditions = [];

        if (status && status !== 'all') {
            andConditions.push(status === 'invoiced' ? { invoicedFlag: true } : { invoicedFlag: { $ne: true } });
        }

        if (startDate) {
            andConditions.push({ scheduledStartDate: { $gte: new Date(startDate) } });
        }
        if (endDate) {
            andConditions.push({ scheduledStartDate: { $lte: new Date(endDate) } });
        }

        if (serviceDeliveryStart) {
            andConditions.push({ actualEndDate: { $gte: new Date(serviceDeliveryStart) } });
        }
        if (serviceDeliveryEnd) {
            andConditions.push({ actualEndDate: { $lte: new Date(serviceDeliveryEnd) } });
        }

        if (participant) {
            andConditions.push({ participantNameRaw: { $regex: participant, $options: 'i' } });
        }

        if (transactionStatusFilter && transactionStatusFilter !== 'all') {
            // Validate regex pattern to prevent errors
            try {
                new RegExp(transactionStatusFilter);
                // Use the converted label names array
                andConditions.push({
                    $expr: {
                        $cond: [
                            { $eq: [{ $type: "$transactionStatusNames" }, "array"] },
                            {
                                // If array, check if any label name matches
                                $gt: [
                                    {
                                        $size: {
                                            $filter: {
                                                input: "$transactionStatusNames",
                                                as: "tsName",
                                                cond: {
                                                    $regexMatch: {
                                                        input: { $convert: { input: "$$tsName", to: "string", onError: "", onNull: "" } },
                                                        regex: transactionStatusFilter,
                                                        options: 'i'
                                                    }
                                                }
                                            }
                                        }
                                    },
                                    0
                                ]
                            },
                            {
                                // If not array (single value), check directly
                                $regexMatch: {
                                    input: { $convert: { input: "$transactionStatusNames", to: "string", onError: "", onNull: "" } },
                                    regex: transactionStatusFilter,
                                    options: 'i'
                                }
                            }
                        ]
                    }
                });
            } catch (regexErr) {
                warn('Items-Service', 'Invalid transaction status regex pattern', {
                    pattern: transactionStatusFilter,
                    error: regexErr.message
                }, extractContextFromReq(req));
            }
        }

        if (paymentStatusFilter && paymentStatusFilter !== 'all') {
            // Validate regex pattern to prevent errors
            try {
                new RegExp(paymentStatusFilter);
                // Use the converted label names array
                andConditions.push({
                    $expr: {
                        $cond: [
                            { $eq: [{ $type: "$paymentStatusNames" }, "array"] },
                            {
                                // If array, check if any label name matches
                                $gt: [
                                    {
                                        $size: {
                                            $filter: {
                                                input: "$paymentStatusNames",
                                                as: "psName",
                                                cond: {
                                                    $regexMatch: {
                                                        input: { $convert: { input: "$$psName", to: "string", onError: "", onNull: "" } },
                                                        regex: paymentStatusFilter,
                                                        options: 'i'
                                                    }
                                                }
                                            }
                                        }
                                    },
                                    0
                                ]
                            },
                            {
                                // If not array (single value or empty), check directly
                                $cond: [
                                    { $ne: ["$paymentStatusNames", ""] },
                                    {
                                        $regexMatch: {
                                            input: { $convert: { input: "$paymentStatusNames", to: "string", onError: "", onNull: "" } },
                                            regex: paymentStatusFilter,
                                            options: 'i'
                                        }
                                    },
                                    false // Empty payment status doesn't match any filter
                                ]
                            }
                        ]
                    }
                });
            } catch (regexErr) {
                warn('Items-Service', 'Invalid payment status regex pattern', {
                    pattern: paymentStatusFilter,
                    error: regexErr.message
                }, extractContextFromReq(req));
            }
        }

        if (andConditions.length > 0) {
            pipeline.push({ $match: { $and: andConditions } });
        }

        // Sort and paginate, with total count and totals
        // Build items facet stages
        const itemsFacetStages = [];
        if (applyPagination && limitNumber) {
            if (skip > 0) {
                itemsFacetStages.push({ $skip: skip });
            }
            itemsFacetStages.push({ $limit: limitNumber });
        } else {
            // When no pagination, use empty match to return all items (MongoDB requires at least one stage)
            itemsFacetStages.push({ $match: {} });
        }
        
        pipeline.push(
            { $sort: { updatedAt: -1 } },
            {
                $facet: {
                    items: itemsFacetStages,
                    totalCount: [
                        { $count: 'count' }
                    ],
                    totals: [
                        {
                            $group: {
                                _id: null,
                                totalAmount: { $sum: "$totalAmountNum" },
                                totalGovSubsidy: { $sum: "$govSubsidyNum" },
                                totalParticipantContribution: { $sum: "$participantContributionNum" },
                                invoicedCount: {
                                    $sum: {
                                        $cond: [{ $eq: ["$invoicedFlag", true] }, 1, 0]
                                    }
                                },
                                pendingCount: {
                                    $sum: {
                                        $cond: [{ $eq: ["$invoicedFlag", true] }, 0, 1]
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        );

        let aggResult;
        try {
            aggResult = await Item.aggregate(pipeline);
        } catch (aggErr) {
            error('Items-Service', 'Aggregation pipeline error', {
                message: aggErr.message,
                stack: aggErr.stack,
                pipeline: JSON.stringify(pipeline, null, 2)
            }, extractContextFromReq(req));
            return res.status(500).json({ 
                message: 'Error fetching invoice generator data',
                error: aggErr.message 
            });
        }
        
        const items = (aggResult[0] && aggResult[0].items) ? aggResult[0].items : [];
        const total = (aggResult[0] && aggResult[0].totalCount && aggResult[0].totalCount[0]) ? aggResult[0].totalCount[0].count : 0;

        // Get totals from aggregation
        const totalsData = (aggResult[0] && aggResult[0].totals && aggResult[0].totals[0]) ? aggResult[0].totals[0] : {
            totalAmount: 0,
            totalGovSubsidy: 0,
            totalParticipantContribution: 0,
            invoicedCount: 0,
            pendingCount: 0
        };

        // Transform items
        const transformedItems = await Promise.all(items.map(async item => {
            const getValue = (attributeName) => {
                return item.data.values.find(v => v.attribute.name === attributeName)?.data;
            };

            const participant = getValue(ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
            const scheduledStart = getValue(ATTRIBUTE_NAMES.SCHEDULED_START) || null;
            const worker = getValue(ATTRIBUTE_NAMES.WORKER_PLANNER)?.toString() || 'N/A';
            const workerName = members.find(m => m.id == worker)?.name || 'N/A';
            const unit = getValue(ATTRIBUTE_NAMES.UNIT) || 'Hours';
            const quantity = Number(getValue(ATTRIBUTE_NAMES.QUANTITY)) || 0;
            const unitPrice = Number(getValue(ATTRIBUTE_NAMES.UNIT_PRICE)) || 0;
            const totalAmount = Number(getValue(ATTRIBUTE_NAMES.TOTAL_AMOUNT)) || 0;
            const govSubsidy = Number(getValue(ATTRIBUTE_NAMES.GOV_SUBSIDY)) || 0;
            const participantContribution = Number(getValue(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)) || 0;
            const notes = getValue(ATTRIBUTE_NAMES.ADDITIONAL_NOTES) || '';

            // Get Service: second section after "-" of Service Plan ID
            const servicePlanId = getValue(ATTRIBUTE_NAMES.SERVICE_PLAN);
            const servicePlan = servicePlanId?.toString() ? await getItemValues(workspaceId, boardId, servicePlanId.toString()) : null;
            let service = undefined;
            let serviceIdentifier = undefined; // For CSV export: Service ID / Item ID from Aged Care Pricing
            let servicePlanName = undefined; // For CSV export: to check if contains "Wraparound"
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
                
                // Get Service Identifier from Service ID / Item ID attribute (from Aged Care Pricing folders)
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
                
                // Get Service Plan name to check for "Wraparound"
                const servicePlanNameValue = servicePlan.values.find(v => 
                    v.attribute.name === 'Name' || 
                    v.attribute.name === 'Service Plan Name' ||
                    v.attribute.name === 'Title'
                )?.data;
                if (servicePlanNameValue) {
                    servicePlanName = typeof servicePlanNameValue === 'string' ? servicePlanNameValue : String(servicePlanNameValue);
                }
            }
            
            const invoiceNumber = getValue('Generated Invoice Number') || '';
            
            // Get Care Recipient Identifier (My Aged Care ID Number from Participant Profile/Intake)
            let careRecipientIdentifier = undefined;
            const participantProfileValue = getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
            if (participantProfileValue) {
                try {
                    const participantProfileId = Array.isArray(participantProfileValue) 
                        ? participantProfileValue[0] 
                        : (typeof participantProfileValue === 'object' ? participantProfileValue.id : participantProfileValue);
                    if (participantProfileId) {
                        const participantProfile = await getItemValues(workspaceId, boardId, participantProfileId.toString());
                        if (participantProfile && participantProfile.values) {
                            const myAgedCareId = participantProfile.values.find(v => 
                                v.attribute.name === ATTRIBUTE_NAMES.MY_AGED_CARE_ID || 
                                v.attribute.name === ATTRIBUTE_NAMES.MY_AGED_CARE_ID_ALT
                            )?.data;
                            if (myAgedCareId) {
                                careRecipientIdentifier = typeof myAgedCareId === 'string' ? myAgedCareId : String(myAgedCareId);
                            }
                        }
                    }
                } catch (err) {
                    warn('Items-Service', 'Failed to fetch My Aged Care ID from participant profile', {
                        error: err.message
                    }, extractContextFromReq(req));
                }
            }
            
            // Get Delivered By value
            const deliveredBy = getValue(ATTRIBUTE_NAMES.DELIVERED_BY);
            const deliveredByString = deliveredBy 
                ? (typeof deliveredBy === 'object' ? deliveredBy.name : String(deliveredBy))
                : undefined;
            
            // Get Item ID, Item, Wraparound Item ID, Wraparound Description
            const itemId = getValue('Item ID') || undefined;
            const itemName = getValue('Item') || undefined;
            const wraparoundItemId = getValue('Wraparound Item ID') || undefined;
            const wraparoundDescription = getValue('Wraparound Description') || undefined;
            
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
            
            // Get Health Professional Type Code and Health Professional Type Other
            // These come from the Health Professional Pricing folder of the selected Health Professional Service
            // The Health Professional Service is in the "Health Professional" Reference attribute of the Participant Service Plan
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
                            const healthProfessionalService = await getItemValues(workspaceId, boardId, healthProfessionalId.toString());
                            if (healthProfessionalService && healthProfessionalService.values) {
                                // Get Health Professional Type Code from Health Professional Pricing folder
                                const hpTypeCode = healthProfessionalService.values.find(v => 
                                    v.attribute.name === 'Health Professional Type Code'
                                )?.data;
                                if (hpTypeCode) {
                                    healthProfessionalTypeCode = typeof hpTypeCode === 'string' ? hpTypeCode : String(hpTypeCode);
                                }
                                
                                // Get Health Professional Type Other (free text if "Other" is selected)
                                const hpTypeOther = healthProfessionalService.values.find(v => 
                                    v.attribute.name === 'Health Professional Type Other'
                                )?.data;
                                if (hpTypeOther) {
                                    healthProfessionalTypeOther = typeof hpTypeOther === 'string' ? hpTypeOther : String(hpTypeOther);
                                }
                            }
                        }
                    } catch (err) {
                        warn('Items-Service', 'Failed to fetch Health Professional information', {
                            error: err.message
                        }, extractContextFromReq(req));
                    }
                }
            }

            // Get file URL from various possible attribute names
            const fileUrl = getValue('Invoice File URL') || 
                          getValue('Invoice PDF Link') || 
                          getValue('Generated Invoice File URL') || 
                          getValue('Generated Invoice Link') || 
                          undefined;

            // Get status
            const invoiceIssued = getValue('Invoice Issued and Sent') || false;
            const paymentStatusValueForCheck = item.data.values.find(v => v.attribute.name === 'Payment Status');
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

            // Get additional fields
            const actualEnd = getValue(ATTRIBUTE_NAMES.ACTUAL_END) || null;
            const serviceDeliveryDate = actualEnd && typeof actualEnd === 'string' 
                ? (actualEnd.includes('T') ? actualEnd.split('T')[0] : actualEnd.split(' ')[0]) 
                : null;
            const scheduledServiceDate = scheduledStart && typeof scheduledStart === 'string'
                ? (scheduledStart.includes('T') ? scheduledStart.split('T')[0] : scheduledStart.split(' ')[0])
                : null;
            
            // Get transaction status - need to look up label name from attribute settings
            const transactionStatusValue = item.data.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.TRANSACTION_STATUS);
            let transactionStatus = undefined;
            if (transactionStatusValue) {
                const transactionStatusData = transactionStatusValue.data;
                const labels = transactionStatusValue.attribute?.settings?.labels || [];
                
                if (Array.isArray(transactionStatusData) && transactionStatusData.length > 0) {
                    // Map label IDs to label names
                    transactionStatus = transactionStatusData.map(id => {
                        const label = labels.find(l => l.id === id || (typeof id === 'object' && l.id === id.id));
                        return label ? label.name : (typeof id === 'object' ? id.name : String(id));
                    }).join(', ');
                } else if (transactionStatusData) {
                    // Single value - could be ID string, object with id/name, or already a name
                    if (typeof transactionStatusData === 'object' && transactionStatusData.id) {
                        const label = labels.find(l => l.id === transactionStatusData.id);
                        transactionStatus = label ? label.name : (transactionStatusData.name || String(transactionStatusData.id));
                    } else if (typeof transactionStatusData === 'string') {
                        const label = labels.find(l => l.id === transactionStatusData);
                        transactionStatus = label ? label.name : transactionStatusData;
                    } else {
                        transactionStatus = String(transactionStatusData);
                    }
                }
            }

            // Format payment status - need to look up label names from attribute settings
            const paymentStatusValue = item.data.values.find(v => v.attribute.name === 'Payment Status');
            let paymentStatusFormatted = undefined;
            if (paymentStatusValue) {
                const paymentStatusData = paymentStatusValue.data;
                const labels = paymentStatusValue.attribute?.settings?.labels || [];
                
                if (Array.isArray(paymentStatusData) && paymentStatusData.length > 0) {
                    // Map label IDs to label names
                    paymentStatusFormatted = paymentStatusData.map(id => {
                        const label = labels.find(l => l.id === id || (typeof id === 'object' && l.id === id.id));
                        return label ? label.name : (typeof id === 'object' ? id.name : String(id));
                    }).filter(s => s).join(', ');
                } else if (paymentStatusData) {
                    // Single value
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

            // Get Funding Source - it's a reference type, need to fetch referenced items
            // Use a helper function with timeout to prevent 504 errors
            const fetchFundingSourceName = async (refItemId, timeoutMs = 5000) => {
                if (!refItemId || typeof refItemId !== 'string' || refItemId.trim() === '') {
                    return null;
                }
                
                try {
                    // Create a timeout promise
                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('Timeout')), timeoutMs);
                    });
                    
                    // Race between the API call and timeout
                    const refItem = await Promise.race([
                        getItemValues(workspaceId, boardId, refItemId.toString()),
                        timeoutPromise
                    ]);
                    
                    if (refItem && refItem.values) {
                        // Try to find a name attribute (could be "Name", "Title", "Funding Source Name", etc.)
                        const nameValue = refItem.values.find(v => 
                            v.attribute.name === 'Name' || 
                            v.attribute.name === 'Title' ||
                            v.attribute.name === 'Funding Source Name' ||
                            v.attribute.name === 'Full Name'
                        );
                        if (nameValue && nameValue.data) {
                            return typeof nameValue.data === 'object' && nameValue.data.name 
                                ? nameValue.data.name 
                                : String(nameValue.data);
                        }
                        // Fallback: use the first text attribute
                        const textValue = refItem.values.find(v => 
                            v.attribute.type === 'text' && v.data
                        );
                        if (textValue && textValue.data) {
                            return String(textValue.data);
                        }
                    }
                    return null;
                } catch (err) {
                    // Silently fail - don't log every timeout to avoid spam
                    if (err.message !== 'Timeout') {
                        warn('Items-Service', 'Failed to fetch funding source item', {
                            refId: refItemId,
                            error: err.message
                        }, extractContextFromReq(req));
                    }
                    return null;
                }
            };
            
            let fundingSource = undefined;
            const fundingSourceValue = item.data.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.FUNDING_SOURCE);
            if (fundingSourceValue && fundingSourceValue.data) {
                const fundingSourceData = fundingSourceValue.data;
                if (Array.isArray(fundingSourceData) && fundingSourceData.length > 0) {
                    // Fetch all referenced items and get their names
                    // Use Promise.allSettled to prevent one failure from stopping all
                    const fundingSourceResults = await Promise.allSettled(
                        fundingSourceData.map(async (refId) => {
                            const refItemId = typeof refId === 'object' ? refId.id || refId : refId;
                            if (!refItemId) return null;
                            return await fetchFundingSourceName(refItemId.toString());
                        })
                    );
                    const fundingSourceNames = fundingSourceResults
                        .filter(result => result.status === 'fulfilled' && result.value)
                        .map(result => result.value);
                    fundingSource = fundingSourceNames.length > 0 ? fundingSourceNames.join(', ') : undefined;
                } else if (fundingSourceData) {
                    // Single reference
                    const refItemId = typeof fundingSourceData === 'object' ? fundingSourceData.id || fundingSourceData : fundingSourceData;
                    if (refItemId) {
                        fundingSource = await fetchFundingSourceName(refItemId.toString());
                    }
                }
            }

            return {
                id: item.itemId,
                status: invoiceStatus,
                participant,
                scheduledStart,
                scheduledServiceDate,
                serviceDeliveryDate,
                worker: workerName,
                unit,
                quantity,
                unitPrice,
                totalAmount,
                govSubsidy,
                participantContribution,
                service,
                // serviceCategory,
                notes,
                invoiceNumber,
                transactionStatus,
                paymentStatus: paymentStatusFormatted,
                fundingSource,
                fileUrl,
                // CSV export fields
                careRecipientIdentifier,
                serviceIdentifier,
                deliveredBy: deliveredByString,
                servicePlan: servicePlanName,
                itemId,
                item: itemName,
                wraparoundItemId,
                wraparoundDescription,
                prescribedItem: prescribedItemValue,
                itemPurchasedMethod: itemPurchasedMethodString,
                associatedProvider: associatedProviderString,
                associatedProviderInvoiceNo,
                healthProfessionalTypeCode,
                healthProfessionalTypeOther
            };
        }));

        res.status(200).json({
            items: transformedItems,
            total,
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
        let businessName = null;
        try {
            const business = await Business.findOne({ workspaceId: workspaceId.toString() });
            businessName = business?.name || null;
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
            const participantIntakeItems = await Item.find({ workspaceId: workspaceId, boardId: boardId, folderId: { $in: participantIntakeFolderIds } })
            participantIntakeIds = participantIntakeItems.map(item => item.data.values.find(v => v.attribute.name.includes(ATTRIBUTE_NAMES.FULL_NAME))?.data == participant ? item.itemId : null).filter(id => id !== null);
        }

        const budgetPipelineForTotals = await buildPipeline(budgetFolderNames, participantIntakeIds[0] ? participantIntakeIds[0] : null, {}, { folderList }, 'budget');
        budgetPipelineForTotals.push({ $sort: { updatedAt: -1 } });
        const allBudgetItemsResult = await Item.aggregate(budgetPipelineForTotals);
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

        const getAttributeEntry = (item, attributeName) => {
            return item?.data?.values?.find(v => v.attribute.name === attributeName) || null;
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
                const values = await getItemValues(workspaceId, boardId, targetItemId);
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

            const committedFunds = committedATShort + committedATOngoing + committedHM;

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

        const transformedAllBudgetItems = await Promise.all(allBudgetItems.map(transformBudgetItem));

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

        const serviceAggResult = await Item.aggregate(servicePipeline);

        const serviceItems = (serviceAggResult[0] && serviceAggResult[0].items) ? serviceAggResult[0].items : [];
        const serviceTotal = (serviceAggResult[0] && serviceAggResult[0].totalCount && serviceAggResult[0].totalCount[0]) ? serviceAggResult[0].totalCount[0].count : 0;

        // Transform service items with specific fields from image
        const transformedServiceItems = await Promise.all(serviceItems.map(async item => {
            const getValue = (attributeName) => {
                return item.data.values.find(v => v.attribute.name === attributeName)?.data;
            };

            // Get participant from Participant Profile
            let participantName = getValue(ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
            const participantProfileValue = getValue(ATTRIBUTE_NAMES.PARTICIPANT_PROFILE);
            const participantProfileId = Array.isArray(participantProfileValue) ? participantProfileValue[0] : participantProfileValue;
            try {
                if (participantProfileId) {
                    const participantProfile = await getItemValues(workspaceId, boardId, participantProfileId.toString());
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
            const servicePlan = servicePlanId?.toString() ? await getItemValues(workspaceId, boardId, servicePlanId.toString()) : null;
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

            return {
                id: item.itemId,
                participant: participantName,
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
                notes,
                participantProfileId: participantProfileId ? participantProfileId.toString() : null
            };
        }));

        const budgetTotal = filteredBudgetItems.length;

        const budgetCategoryAggregates = {};
        filteredBudgetItems.forEach(item => {
            const code = item.categoryCode || 'HSQ';
            if (!budgetCategoryAggregates[code]) {
                budgetCategoryAggregates[code] = {
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
                    months: new Set()
                };
            }

            const aggregate = budgetCategoryAggregates[code];
            aggregate.availableFunds += item.totalAvailableBudget || 0;
            aggregate.remainingBudget += item.remainingBalance || 0;
            aggregate.serviceDeliveredAmount += item.deliveredAmount || 0;
            aggregate.adjustmentAmount += item.adjustmentAmount || 0;
            aggregate.govSubsidyAmount += item.govSubsidyAmount || 0;
            aggregate.participantContributionAmount += item.participantContributionAmount || 0;
            aggregate.committedFunds += item.committedFunds || 0;
            aggregate.serviceCount += 1;

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
        const yearStr = year || new Date().getFullYear().toString();
        const quarterMonths = getQuarterMonths(monthNum);
        const defaultFundingEndDate = new Date(parseInt(yearStr, 10), 11, 31).toISOString();

        const budgetCategories = BUDGET_CATEGORY_CONFIG.map(config => {
            const profileData = budgetDataFromProfile?.[config.profileKey] || {};
            const budgetAggregate = budgetCategoryAggregates[config.code] || {};

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
                expenditurePeriodLabel: budgetAggregate.expenditurePeriodLabel || undefined
            };
        });

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
            budgetCategories
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
                const item = await Item.findOne({ workspaceId, boardId, itemId });
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
        });

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