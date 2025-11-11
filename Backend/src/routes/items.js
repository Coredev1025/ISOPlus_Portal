import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Item from '../models/Item.js';
import Business from '../models/Business.js';
import { info, error, warn, extractContextFromReq } from '../utils/logger.js';
import { getItemValues, getFolder, getMember, getMonthlyStatementBudgetData } from '../services/isoplus.js';
import fs from 'fs';

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
            page = 1,
            limit = 10
        } = req.query;

        if (!workspaceId || !boardId) {
            return res.status(400).json({
                message: 'WorkspaceId and boardId are required'
            });
        }

        // Calculate pagination
        const skip = (parseInt(page) - 1) * parseInt(limit);

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
                    }
                }
            },
            {
                $addFields: {
                    scheduledStartDate: {
                        $dateFromString: { dateString: "$scheduledStartRaw", onError: null }
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

        if (participant) {
            andConditions.push({ participantNameRaw: { $regex: participant, $options: 'i' } });
        }

        if (andConditions.length > 0) {
            pipeline.push({ $match: { $and: andConditions } });
        }

        // Sort and paginate, with total count and totals
        pipeline.push(
            { $sort: { updatedAt: -1 } },
            {
                $facet: {
                    items: [
                        { $skip: skip },
                        { $limit: parseInt(limit) }
                    ],
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

        const aggResult = await Item.aggregate(pipeline);
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

            // Get service information
            const servicePlanId = getValue(ATTRIBUTE_NAMES.SERVICE_PLAN);
            const servicePlan = servicePlanId?.toString() ? await getItemValues(workspaceId, boardId, servicePlanId.toString()) : null;
            const service = servicePlan && servicePlan.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.SERVICE_PLAN_ID)?.data?.toString().trim() ? servicePlan.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.SERVICE_PLAN_ID)?.data?.toString().trim() : undefined;
            const serviceCategoryId = servicePlan && servicePlan.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.SERVICE_CATEGORY)?.data?.toString().trim() ? servicePlan.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.SERVICE_CATEGORY)?.data?.toString().trim() : undefined;
            const serviceCategory = serviceCategoryId && servicePlan.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.SERVICE_CATEGORY)?.attribute?.settings?.labels?.find(l => l.id === serviceCategoryId)?.name || undefined;
            const invoiceNumber = getValue('Generated Invoice Number') || '';

            // Get status
            const invoiceIssued = getValue('Invoice Issued and Sent') || false;
            const paymentStatus = getValue('Payment Status') || [];
            const invoiceStatus = invoiceIssued || (Array.isArray(paymentStatus) && paymentStatus.some(p => p.name.includes('Paid')))
                ? 'invoiced'
                : 'pending';

            return {
                id: item.itemId,
                status: invoiceStatus,
                participant,
                scheduledStart,
                worker: workerName,
                unit,
                quantity,
                unitPrice,
                totalAmount,
                govSubsidy,
                participantContribution,
                service,
                serviceCategory,
                notes,
                invoiceNumber
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
            budgetLimit = 10,
            servicePage = 1,
            serviceLimit = 10
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
                if (participantFilter) {
                    andConditions.push({ participantNameRaw: { $regex: participantFilter, $options: 'i' } });
                }
                if (dateFilter && dateFilter.startDate) {
                    andConditions.push({ scheduledStartDate: { $gte: new Date(dateFilter.startDate) } });
                }
                if (dateFilter && dateFilter.endDate) {
                    andConditions.push({ scheduledStartDate: { $lte: new Date(dateFilter.endDate) } });
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

        const budgetPageNumber = parseInt(budgetPage, 10) > 0 ? parseInt(budgetPage, 10) : 1;
        const budgetLimitNumber = parseInt(budgetLimit, 10) > 0 ? parseInt(budgetLimit, 10) : 10;
        const budgetSkip = (budgetPageNumber - 1) * budgetLimitNumber;
        const paginatedBudgetItems = filteredBudgetItems.slice(budgetSkip, budgetSkip + budgetLimitNumber);

        // Fetch service items (second table) from Master Plan,Shift Planning and Reporting
        const servicePipeline = await buildPipeline('Master Plan,Shift Planning and Reporting', participant, { startDate, endDate }, {}, 'service');
        const serviceSkip = (parseInt(servicePage) - 1) * parseInt(serviceLimit);
        servicePipeline.push(
            { $sort: { updatedAt: -1 } },
            {
                $facet: {
                    items: [
                        { $skip: serviceSkip },
                        { $limit: parseInt(serviceLimit) }
                    ],
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
                if (servicePlanIdValue && servicePlanIdValue.includes('-')) {
                    const parts = servicePlanIdValue.split('-');
                    if (parts.length >= 2) {
                        service = parts.slice(1).join('-').trim();
                    }
                } else if (servicePlanIdValue) {
                    service = servicePlanIdValue;
                }
            }

            // Get Service Provider based on Delivered by
            const worker = getValue(ATTRIBUTE_NAMES.WORKER_PLANNER)?.toString() || 'N/A';
            const workerName = members.find(m => m.id == worker)?.name || 'Removed User';
            const deliveredByRaw = getValue(ATTRIBUTE_NAMES.DELIVERED_BY);
            const deliveredBy = deliveredByRaw
                ? (typeof deliveredByRaw === 'object' ? deliveredByRaw.name : deliveredByRaw.toString())
                : null;
            let serviceProvider = workerName;
            if (deliveredBy && (deliveredBy.toLowerCase().includes(DELIVERED_BY_TYPES.COMPANY_WORKFORCE) || deliveredBy.toLowerCase() === DELIVERED_BY_TYPES.COMPANY_WORKFORCE)) {
                serviceProvider = businessName || workerName;
            } else if (deliveredBy && (deliveredBy.toLowerCase().includes(DELIVERED_BY_TYPES.ASSOCIATED_PROVIDERS) || deliveredBy.toLowerCase() === DELIVERED_BY_TYPES.ASSOCIATED_PROVIDERS)) {
                const associatedProvider = getValue(ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER);
                serviceProvider = associatedProvider
                    ? (typeof associatedProvider === 'object' ? associatedProvider.name : associatedProvider.toString())
                    : workerName;
            } else {
                serviceProvider = getValue(ATTRIBUTE_NAMES.SERVICE_PROVIDER)?.toString() || workerName;
            }

            // Get dates
            const scheduledStart = getValue(ATTRIBUTE_NAMES.SCHEDULED_START) || null;
            const actualEnd = getValue(ATTRIBUTE_NAMES.ACTUAL_END) || null;
            const scheduledServiceDate = scheduledStart ? (scheduledStart.includes('T') ? scheduledStart.split('T')[0] : scheduledStart.split(' ')[0]) : null;
            const serviceDeliveryDate = actualEnd ? (actualEnd.includes('T') ? actualEnd.split('T')[0] : actualEnd.split(' ')[0]) : null;

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
                page: parseInt(servicePage),
                limit: parseInt(serviceLimit)
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