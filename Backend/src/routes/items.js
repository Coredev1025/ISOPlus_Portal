import express from 'express';
import fs from 'fs';
import { authenticateToken } from '../middleware/auth.js';
import Item from '../models/Item.js';
import Business from '../models/Business.js';
import { info, error, warn, extractContextFromReq } from '../utils/logger.js';
import { getReferences, getAttribute, getItemValues, getFolder, getMember, getMonthlyStatementBudgetData } from '../services/isoplus.js';

const router = express.Router();

// Constants for monthly statement feature
const MONTHLY_STATEMENT_FOLDER_NAME = 'Master Plan,Shift Planning and Reporting';
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
    PROVIDER_ID: 'Provider ID'
};

const FUNDING_SOURCE_TYPES = {
    HOME_SUPPORT: 'home support',
    RESTORATIVE_CARE: 'restorative care',
    END_OF_LIFE: 'end-of-life',
    ASSISTIVE_TECH_SHORT: 'assistive',
    ASSISTIVE_TECH_ONGOING: 'assistive',
    HOME_MODIFICATION: 'modification'
};

const DELIVERED_BY_TYPES = {
    COMPANY_WORKFORCE: 'company workforce',
    ASSOCIATED_PROVIDERS: 'associated providers'
};

const getFolderIds = async (folderName, workspaceId, boardId) => {
    const { folder } = await getFolder(workspaceId, boardId);

    let folderids = [], folderNames = folderName.toLowerCase().split(',');

    if (folder && folder.length > 0) {
        try {
            const filteredFolders = await Promise.all(
                folder.map(async folderElement => {
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

// Get items for a specific workspace and board
router.get('/:workspaceId/:boardId/:type', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId, type } = req.params;
        const { members } = await getMember(req.session.Authorization, workspaceId);
        const {
            status = '',
            participant = '',
            startDate,
            endDate,
            deliveryStartDate,
            deliveryEndDate,
            page = 1,
            limit = 10,
            folderName = ''
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

        // Base match
        const baseMatch = { workspaceId, boardId };

        const folderIds = await getFolderIds(folderName, workspaceId, boardId);
        if (folderIds && folderIds.length > 0) {
            baseMatch.folderId = { $in: folderIds };
        }
        pipeline.push({ $match: baseMatch });

        // Extract values from data.values
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
                    scheduledEndValue: {
                        $filter: {
                            input: "$data.values",
                            as: "value",
                            cond: { $eq: ["$$value.attribute.name", "Scheduled Shift End Date & Time"] }
                        }
                    },
                    actualStartValue: {
                        $filter: {
                            input: "$data.values",
                            as: "value",
                            cond: { $eq: ["$$value.attribute.name", "Actual Shift Start Date & Time"] }
                        }
                    },
                    actualEndValue: {
                        $filter: {
                            input: "$data.values",
                            as: "value",
                            cond: { $eq: ["$$value.attribute.name", "Actual Shift End Date & Time"] }
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
                    scheduledEndRaw: { 
                        $let: {
                            vars: { firstVal: { $arrayElemAt: ["$scheduledEndValue", 0] } },
                            in: { $ifNull: ["$$firstVal.data", null] }
                        }
                    },
                    actualStartRaw: { 
                        $let: {
                            vars: { firstVal: { $arrayElemAt: ["$actualStartValue", 0] } },
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
                    scheduledEndDate: {
                        $dateFromString: { dateString: "$scheduledEndRaw", onError: null }
                    },
                    actualStartDate: {
                        $dateFromString: { dateString: "$actualStartRaw", onError: null }
                    },
                    actualEndDate: {
                        $dateFromString: { dateString: "$actualEndRaw", onError: null }
                    }
                }
            },
            {
                $addFields: {
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
            andConditions.push({ scheduledEndDate: { $lte: new Date(endDate) } });
        }

        if (deliveryStartDate) {
            andConditions.push({ actualStartDate: { $gte: new Date(deliveryStartDate) } });
        }
        if (deliveryEndDate) {
            andConditions.push({ actualEndDate: { $lte: new Date(deliveryEndDate) } });
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

        fs.writeFileSync('pipeline.txt', JSON.stringify(pipeline, null, 2));
        const aggResult = await Item.aggregate(pipeline);        
        fs.writeFileSync('aggResult.txt', JSON.stringify(aggResult, null, 2));
        // console.log("aggreate Result====================> \n", aggResult[0].totalCount, aggResult[0].totals)
        const items = (aggResult[0] && aggResult[0].items) ? aggResult[0].items : [];
        const total = (aggResult[0] && aggResult[0].totalCount && aggResult[0].totalCount[0]) ? aggResult[0].totalCount[0].count : 0;
        
        // Get totals from aggregation (calculated from ALL matching items, not just paginated)
        const totalsData = (aggResult[0] && aggResult[0].totals && aggResult[0].totals[0]) ? aggResult[0].totals[0] : {
            totalAmount: 0,
            totalGovSubsidy: 0,
            totalParticipantContribution: 0,
            invoicedCount: 0,
            pendingCount: 0
        };
        
        // Debug logging to verify totals calculation
        if (type === 'invoiceparticipanttax' || type === 'monthlystatement' || type === 'monthlyStatement') {
            info('Items-Service', 'Aggregation totals calculated', {
                totalItems: total,
                totalsData: totalsData,
                workspaceId,
                boardId,
                type
            }, extractContextFromReq(req));
        }

        // Transform items for frontend display
        let transformedItems = [];
        let participantProfile = null; // For monthly statement type
        let budgetCategories = []; // For monthly statement type

        if (type === 'invoiceparticipanttax') {
            transformedItems = await Promise.all(items.map(async item => {
                const getValue = (attributeName) => {
                    return item.data.values.find(v => v.attribute.name === attributeName)?.data;
                };

                // Get status
                const invoiceIssued = getValue('Invoice Issued and Sent') || false;
                const paymentStatus = getValue('Payment Status') || [];
                const status = invoiceIssued || (Array.isArray(paymentStatus) && paymentStatus.some(p => p.name.includes('Paid')))
                    ? 'invoiced'
                    : 'pending';

                // Get participant name and scheduled start
                const participant = getValue('Participant Full Name') || '';
                const scheduledStart = getValue('Scheduled Shift Start Date & Time');

                // Get worker information
                const worker = getValue('Worker/Planner')?.toString() || 'N/A';
                const workerName = members.find(m => m.id == worker)?.name || 'N/A';

                // Get unit and quantity
                const unit = getValue('Unit') || 'Hours';
                const quantity = Number(getValue('Quantity')) || 0;

                // Get financial values
                const unitPrice = Number(getValue('Unit Price ($)')) || 0;
                const totalAmount = Number(getValue('Total Amount ($)')) || 0;
                const govSubsidy = Number(getValue('Government Subsidy ($)')) || 0;
                const participantContribution = Number(getValue('Participant Contribution ($)')) || 0;

                // Get notes and invoice number
                const servicePlanId = getValue('Service Plan');
                const servicePlan = servicePlanId?.toString() ? await getItemValues(workspaceId, boardId, servicePlanId.toString()) : null;
                const service = servicePlan && servicePlan.values.find(v => v.attribute.name === "Service Plan ID")?.data?.toString().trim() ? servicePlan.values.find(v => v.attribute.name === "Service Plan ID")?.data?.toString().trim() : undefined;
                const serviceCategoryId = servicePlan && servicePlan.values.find(v => v.attribute.name === "Service Category")?.data?.toString().trim() ? servicePlan.values.find(v => v.attribute.name === "Service Category")?.data?.toString().trim() : undefined;
                const serviceCategory = serviceCategoryId && servicePlan.values.find(v => v.attribute.name === "Service Category")?.attribute?.settings?.labels?.find(l => l.id === serviceCategoryId)?.name || undefined;
                const notes = getValue('Additional Notes') || '';
                const invoiceNumber = getValue('Generated Invoice Number') || '';

                return {
                    id: item.itemId,
                    status,
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
        } else if (type === 'monthlystatement' || type === 'monthlyStatement') {
            // Fetch business name once for all items (used for Company Workforce service provider)
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

            transformedItems = await Promise.all(items.map(async item => {
                const getValue = (attributeName) => {
                    return item.data.values.find(v => v.attribute.name === attributeName)?.data;
                };

                // Get dates
                const scheduledStart = getValue(ATTRIBUTE_NAMES.SCHEDULED_START) || null;
                const actualStart = getValue(ATTRIBUTE_NAMES.ACTUAL_START) || null;
                const actualEnd = getValue(ATTRIBUTE_NAMES.ACTUAL_END) || null;

                // Get participant
                const participant = getValue(ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';

                // Get worker/service provider
                const worker = getValue(ATTRIBUTE_NAMES.WORKER_PLANNER)?.toString() || 'N/A';
                const workerName = members.find(m => m.id == worker)?.name || 'Removed User';

                // Determine service provider based on "Delivered by" field
                const deliveredByRaw = getValue(ATTRIBUTE_NAMES.DELIVERED_BY);
                const deliveredBy = deliveredByRaw
                    ? (typeof deliveredByRaw === 'object' ? deliveredByRaw.name : deliveredByRaw.toString())
                    : null;

                let serviceProvider = workerName; // default fallback

                if (deliveredBy && (deliveredBy.toLowerCase().includes(DELIVERED_BY_TYPES.COMPANY_WORKFORCE) || deliveredBy.toLowerCase() === DELIVERED_BY_TYPES.COMPANY_WORKFORCE)) {
                    // Use business name for Company Workforce (fetched once before the loop)
                    serviceProvider = businessName || workerName;
                } else if (deliveredBy && (deliveredBy.toLowerCase().includes(DELIVERED_BY_TYPES.ASSOCIATED_PROVIDERS) || deliveredBy.toLowerCase() === DELIVERED_BY_TYPES.ASSOCIATED_PROVIDERS)) {
                    // Use Associated Provider value
                    const associatedProvider = getValue(ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER);
                    serviceProvider = associatedProvider
                        ? (typeof associatedProvider === 'object' ? associatedProvider.name : associatedProvider.toString())
                        : workerName;
                } else {
                    // Fallback to Service Provider field or worker name
                    serviceProvider = getValue(ATTRIBUTE_NAMES.SERVICE_PROVIDER)?.toString() || workerName;
                }

                // Get unit and quantity
                const unit = getValue(ATTRIBUTE_NAMES.UNIT) || 'Hour';
                const quantity = Number(getValue(ATTRIBUTE_NAMES.QUANTITY)) || 0;

                // Get financial values
                const unitPrice = Number(getValue(ATTRIBUTE_NAMES.UNIT_PRICE)) || 0;
                const totalAmount = Number(getValue(ATTRIBUTE_NAMES.TOTAL_AMOUNT)) || 0;
                const govSubsidy = Number(getValue(ATTRIBUTE_NAMES.GOV_SUBSIDY)) || 0;
                const participantContribution = Number(getValue(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)) || 0;

                // Get service information
                const servicePlanId = getValue(ATTRIBUTE_NAMES.SERVICE_PLAN);
                const servicePlan = servicePlanId?.toString() ? await getItemValues(workspaceId, boardId, servicePlanId.toString()) : null;
                const service = servicePlan && servicePlan.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.SERVICE_PLAN_ID)?.data?.toString().trim() ? servicePlan.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.SERVICE_PLAN_ID)?.data?.toString().trim() : undefined;
                const serviceCategoryId = servicePlan && servicePlan.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.SERVICE_CATEGORY)?.data?.toString().trim() ? servicePlan.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.SERVICE_CATEGORY)?.data?.toString().trim() : undefined;
                const serviceCategory = serviceCategoryId && servicePlan.values.find(v => v.attribute.name === ATTRIBUTE_NAMES.SERVICE_CATEGORY)?.attribute?.settings?.labels?.find(l => l.id === serviceCategoryId)?.name || undefined;
                const taskNameValue = getValue(ATTRIBUTE_NAMES.TASK_NAME);
                const taskName = taskNameValue && taskNameValue.toString().trim() ? taskNameValue.toString().trim() : undefined;
                const notes = getValue(ATTRIBUTE_NAMES.ADDITIONAL_NOTES) || '';

                // Get status and funding source
                const transactionStatusRaw = getValue(ATTRIBUTE_NAMES.TRANSACTION_STATUS);
                const transactionStatus = transactionStatusRaw
                    ? (typeof transactionStatusRaw === 'object' ? transactionStatusRaw.name : transactionStatusRaw)
                    : undefined;

                // Handle funding source - it might be an object (label) or a string
                const fundingSourceRaw = getValue(ATTRIBUTE_NAMES.FUNDING_SOURCE);
                const fundingSource = fundingSourceRaw
                    ? (typeof fundingSourceRaw === 'object'
                        ? (fundingSourceRaw.name || fundingSourceRaw.toString())
                        : fundingSourceRaw.toString())
                    : 'Home Support';

                return {
                    id: item.itemId,
                    participant,
                    scheduledStart,
                    actualStart,
                    actualEnd,
                    worker: workerName,
                    unit,
                    quantity,
                    unitPrice,
                    totalAmount,
                    govSubsidy,
                    participantContribution,
                    notes,
                    taskName,
                    transactionStatus,
                    fundingSource,
                    service,
                    serviceCategory,
                    serviceProvider
                };
            }));

            // Fetch participant profile data and budget data from the first item's references
            // Since all items in a monthly statement are for the same participant,
            // we only need to fetch it once
            let participantProfileItemId = null;
            if (items.length > 0) {
                try {
                    const firstItem = items[0];
                    const getValueFromItem = (attributeName) => {
                        const value = firstItem.data.values?.find(v => v.attribute?.name === attributeName);
                        if (!value) return null;
                        const data = value.data;
                        // Handle state which might be a label object
                        if (attributeName === 'State' && typeof data === 'object' && data[0]) {
                            const stateId = data[0].toString();
                            const stateLabel = value.attribute?.settings?.labels?.find(l => l.id === stateId);
                            return stateLabel ? stateLabel.name : (data.toString() || null);
                        }
                        return data ? data.toString() : null;
                    };

                    // First, try to get participant profile from referenced items
                    const references = await getReferences(workspaceId, boardId, firstItem.itemId);

                    if (references && references.data && references.data.length > 0) {
                        // Find the Participant Profile reference
                        for (const reference of references.data) {
                            const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
                            if (attribute && attribute.name === ATTRIBUTE_NAMES.PARTICIPANT_PROFILE) {
                                participantProfileItemId = reference.to_item_id;
                                const participantProfileItem = await getItemValues(workspaceId, boardId, reference.to_item_id);
                                if (participantProfileItem && participantProfileItem.values) {
                                    const values = participantProfileItem.values;

                                    const getProfileValue = (attributeName) => {
                                        const value = values.find(v => v.attribute?.name === attributeName);
                                        if (!value) return null;
                                        const data = value.data;
                                        // Handle state which might be a label object
                                        if (attributeName === ATTRIBUTE_NAMES.STATE && typeof data === 'object' && data[0]) {
                                            const stateId = data[0].toString();
                                            const stateLabel = value.attribute?.settings?.labels?.find(l => l.id === stateId);
                                            return stateLabel ? stateLabel.name : (data.toString() || null);
                                        }
                                        return data ? data.toString() : null;
                                    };

                                    participantProfile = {
                                        fullName: getProfileValue(ATTRIBUTE_NAMES.FULL_NAME) || getProfileValue(ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || null,
                                        address: getProfileValue(ATTRIBUTE_NAMES.ADDRESS) || null,
                                        suburb: getProfileValue(ATTRIBUTE_NAMES.SUBURB) || null,
                                        postcode: getProfileValue(ATTRIBUTE_NAMES.POSTCODE) || getProfileValue(ATTRIBUTE_NAMES.POST_CODE) || null,
                                        state: getProfileValue(ATTRIBUTE_NAMES.STATE) || null,
                                        myAgedCareIdNumber: getProfileValue(ATTRIBUTE_NAMES.MY_AGED_CARE_ID) || getProfileValue(ATTRIBUTE_NAMES.MY_AGED_CARE_ID_ALT) || null,
                                        providerId: getProfileValue(ATTRIBUTE_NAMES.PROVIDER_ID) || null
                                    };
                                    break; // Found the profile, no need to continue
                                }
                            }
                        }
                    }

                    // Fallback: Try to get participant profile attributes directly from the service item
                    // (in case they're stored directly on the item rather than in a referenced item)
                    if (!participantProfile || Object.keys(participantProfile).length === 0) {
                        participantProfile = {
                            fullName: getValueFromItem(ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || getValueFromItem(ATTRIBUTE_NAMES.FULL_NAME) || null,
                            address: getValueFromItem('Participant Address') || getValueFromItem(ATTRIBUTE_NAMES.ADDRESS) || null,
                            suburb: getValueFromItem('Participant Suburb') || getValueFromItem(ATTRIBUTE_NAMES.SUBURB) || null,
                            postcode: getValueFromItem('Participant Postcode') || getValueFromItem(ATTRIBUTE_NAMES.POSTCODE) || getValueFromItem(ATTRIBUTE_NAMES.POST_CODE) || null,
                            state: getValueFromItem('Participant State') || getValueFromItem(ATTRIBUTE_NAMES.STATE) || null,
                            myAgedCareIdNumber: getValueFromItem(ATTRIBUTE_NAMES.MY_AGED_CARE_ID) || getValueFromItem(ATTRIBUTE_NAMES.MY_AGED_CARE_ID_ALT) || null,
                            providerId: getValueFromItem(ATTRIBUTE_NAMES.PROVIDER_ID) || null
                        };
                    }

                    // Only include defined values (remove null/undefined)
                    if (participantProfile) {
                        Object.keys(participantProfile).forEach(key => {
                            if (participantProfile[key] === null || participantProfile[key] === undefined || participantProfile[key] === '') {
                                delete participantProfile[key];
                            }
                        });

                        // If we got no fields, set to null
                        if (Object.keys(participantProfile).length === 0) {
                            participantProfile = null;
                        }
                    }
                } catch (profileError) {
                    // Log but don't fail - participant profile is optional
                    warn('Items-Service', 'Failed to fetch participant profile', {
                        message: profileError.message,
                        itemId: items[0]?.itemId
                    }, extractContextFromReq(req));
                    participantProfile = null;
                }
            }

            // Fetch budget data from funding streams
            let budgetData = {
                homeSupport: {},
                restorativeCare: {},
                endOfLife: {},
                assistiveTechShortTerm: {},
                assistiveTechOngoing: {},
                homeModification: {}
            };

            if (participantProfileItemId) {
                try {
                    budgetData = await getMonthlyStatementBudgetData(workspaceId, boardId, participantProfileItemId);
                } catch (budgetError) {
                    warn('Items-Service', 'Failed to fetch budget data', {
                        message: budgetError.message,
                        participantProfileItemId
                    }, extractContextFromReq(req));
                    // Continue with empty budget data objects
                }
            }

            // Calculate budget categories from real data
            try {
                // Get month and year from query params for quarter calculation
                const month = req.query.month || new Date().getMonth() + 1;
                const year = req.query.year || new Date().getFullYear();
                const monthNumber = typeof month === 'string' ? parseInt(month) : month;

                // Helper to get quarter months
                const getQuarterMonths = (monthNum) => {
                    if (monthNum >= 1 && monthNum <= 3) {
                        return { start: 'January', end: 'March', startNumber: 1, endNumber: 3 };
                    }
                    if (monthNum >= 4 && monthNum <= 6) {
                        return { start: 'April', end: 'June', startNumber: 4, endNumber: 6 };
                    }
                    if (monthNum >= 7 && monthNum <= 9) {
                        return { start: 'July', end: 'September', startNumber: 7, endNumber: 9 };
                    }
                    return { start: 'October', end: 'December', startNumber: 10, endNumber: 12 };
                };
                const quarter = getQuarterMonths(monthNumber);
                const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
                const getMonthName = (num) => monthNames[((num - 1) % 12 + 12) % 12];
                const formatCurrencyNumber = (value) => isNaN(value) ? 0 : Number(value);

                const calculateMetrics = (services, fundingSourceMatch) => {
                    return services.reduce((acc, service) => {
                        const fundingSource = service.fundingSource || '';
                        const serviceCategory = service.serviceCategory || '';
                        const notes = (service.notes || '').toString().toLowerCase();
                        const taskName = (service.taskName || '').toString().toLowerCase();
                        if (fundingSourceMatch(fundingSource, serviceCategory, notes, taskName)) {
                            acc.totalAmount += formatCurrencyNumber(service.totalAmount || 0);
                            acc.govSubsidy += formatCurrencyNumber(service.govSubsidy || 0);
                            acc.participantContribution += formatCurrencyNumber(service.participantContribution || 0);
                            acc.serviceCount += 1;
                        }
                        return acc;
                    }, {
                        totalAmount: 0,
                        govSubsidy: 0,
                        participantContribution: 0,
                        serviceCount: 0
                    });
                };

                // Helper to match funding sources
                const isHomeSupport = (fundingSource, serviceCategory, notes, taskName) => {
                    const fs = (fundingSource || '').toLowerCase();
                    const sc = (serviceCategory || '').toLowerCase();
                    // Check service category first - exact match for "Home Support (HS)"
                    if (sc.includes('home support')) return true;
                    if (sc.includes('hs') && !sc.includes('health professional')) return true; // HS but not a health professional variant
                    // Fallback to funding source
                    return fs.includes(FUNDING_SOURCE_TYPES.HOME_SUPPORT) || fs.includes('hs');
                };

                const isRestorativeCare = (fundingSource, serviceCategory, notes, taskName) => {
                    const fs = (fundingSource || '').toLowerCase();
                    const sc = (serviceCategory || '').toLowerCase();
                    return fs.includes(FUNDING_SOURCE_TYPES.RESTORATIVE_CARE) || sc.includes('restorative care');
                };

                const isEndOfLife = (fundingSource, serviceCategory, notes, taskName) => {
                    const fs = (fundingSource || '').toLowerCase();
                    const sc = (serviceCategory || '').toLowerCase();
                    const n = (notes || '').toLowerCase();
                    const tn = (taskName || '').toLowerCase();
                    return fs.includes(FUNDING_SOURCE_TYPES.END_OF_LIFE) ||
                        fs.includes('end of life') ||
                        sc.includes('end of life') ||
                        n.includes('end of life') ||
                        tn.includes('end of life');
                };

                const isAssistiveTechShortTerm = (fundingSource, serviceCategory, notes, taskName) => {
                    const fs = (fundingSource || '').toLowerCase();
                    const sc = (serviceCategory || '').toLowerCase();
                    const n = (notes || '').toLowerCase();
                    const tn = (taskName || '').toLowerCase();
                    // Check service category first - exact match for "Assistive Technology (AT) - Short-term"
                    // Also check for variations like "AT - Short-term", "Assistive Technology - Short-term", etc.
                    if (sc.includes('assistive technology') && sc.includes('short-term')) return true;
                    if (sc.includes('assistive technology') && sc.includes('short term')) return true;
                    if (sc.includes('at') && sc.includes('short-term')) return true;
                    if (sc.includes('at') && sc.includes('short term')) return true;
                    // Fallback to funding source, notes, or task name
                    return (fs.includes('assistive') && fs.includes('short')) ||
                        (sc.includes('assistive') && sc.includes('short')) ||
                        (n.includes('assistive') && n.includes('short')) ||
                        (tn.includes('assistive') && tn.includes('short'));
                };

                const isAssistiveTechOngoing = (fundingSource, serviceCategory, notes, taskName) => {
                    const fs = (fundingSource || '').toLowerCase();
                    const sc = (serviceCategory || '').toLowerCase();
                    const n = (notes || '').toLowerCase();
                    const tn = (taskName || '').toLowerCase();
                    // Check service category first - exact match for "Assistive Technology (AT) - Ongoing"
                    // Also check for variations like "AT - Ongoing", "Assistive Technology - Ongoing", etc.
                    if (sc.includes('assistive technology') && sc.includes('ongoing')) return true;
                    if (sc.includes('at') && sc.includes('ongoing')) return true;
                    // Fallback to funding source, notes, or task name
                    return (fs.includes('assistive') && fs.includes('ongoing')) ||
                        (sc.includes('assistive') && sc.includes('ongoing')) ||
                        (n.includes('assistive') && n.includes('ongoing')) ||
                        (tn.includes('assistive') && tn.includes('ongoing'));
                };

                const isHomeModification = (fundingSource, serviceCategory, notes, taskName) => {
                    const fs = (fundingSource || '').toLowerCase();
                    const sc = (serviceCategory || '').toLowerCase();
                    const n = (notes || '').toLowerCase();
                    const tn = (taskName || '').toLowerCase();
                    // Check service category first - exact match for "Home Modification (HM)"
                    // Also check for variations like "HM", "Home Modification", etc.
                    if (sc.includes('home modification')) return true;
                    if (sc.includes('hm') && !sc.includes('health professional')) return true; // HM but not HM Health Professional
                    // Fallback to funding source, notes, or task name
                    return fs.includes('modification') ||
                        fs.includes('home modification') ||
                        sc.includes('modification') ||
                        n.includes('modification') ||
                        tn.includes('modification');
                };

                // Calculate Home Support Quarterly Budget
                // Formula from PDF: Available Balance = {Remaining Home Support Balance as at the End of the Month ($)}
                // U expenditure = [{Service Delivered During the Month ($-)} + {Adjustments from Previous Months [Charges($-)/Refund($)]}]
                const homeSupportMetrics = calculateMetrics(transformedItems, isHomeSupport);
                const homeSupportAdjustments = 0; // TODO: Fetch from Adjustments from Previous Months [Charges($-)/Refund($)] attribute
                const homeSupportExpenditure = homeSupportMetrics.totalAmount + homeSupportAdjustments;
                const homeSupportBudget = budgetData.homeSupport || {};
                // According to PDF: Available Funds = Remaining Home Support Balance as at the End of the Month ($)
                const homeSupportAvailable = homeSupportBudget.remainingBalance || 0;
                const monthAfterSelected = monthNumber === 12 ? 1 : monthNumber + 1;
                const availableBalanceRangeLabel = (monthNumber >= quarter.endNumber || monthAfterSelected > quarter.endNumber)
                    ? 'Next quarter'
                    : `${getMonthName(monthAfterSelected)}-${quarter.end} ${year}`;

                budgetCategories.push({
                    name: `Home Support Quarterly Budget ${quarter.start}-${quarter.end} ${year}`,
                    code: 'HSQ',
                    availableFunds: homeSupportAvailable,
                    expenditure: homeSupportExpenditure,
                    remainingBudget: homeSupportAvailable - homeSupportExpenditure,
                    fundingEndDate: homeSupportBudget.fundingEndDate || null,
                    quarterStartMonth: quarter.start,
                    quarterEndMonth: quarter.end,
                    serviceDeliveredAmount: homeSupportMetrics.totalAmount,
                    govSubsidyAmount: homeSupportMetrics.govSubsidy,
                    participantContributionAmount: homeSupportMetrics.participantContribution,
                    adjustmentAmount: homeSupportAdjustments,
                    serviceCount: homeSupportMetrics.serviceCount,
                    availableBalanceRangeLabel,
                    expenditurePeriodLabel: 'U: The selected month'
                });

                // Restorative Care Pathway Budget
                // Formula from PDF: Available Funds = {Total Available Budget for Restorative Care ($)}
                // U expenditure = [{Service Delivered During the Month ($-)} + {Adjustments from Previous Months [Charges($-)/Refund($)]}]
                const rcpMetrics = calculateMetrics(transformedItems, isRestorativeCare);
                const rcpAdjustments = 0; // TODO: Fetch from Adjustments from Previous Months [Charges($-)/Refund($)] attribute
                const rcpExpenditure = rcpMetrics.totalAmount + rcpAdjustments;
                const rcpBudget = budgetData.restorativeCare || {};
                // According to PDF: Available Funds = Total Available Budget for Restorative Care ($)
                const rcpAvailable = rcpBudget.totalAvailableBudget || 0;
                budgetCategories.push({
                    name: 'Restorative Care Pathway Budget',
                    code: 'RCP',
                    availableFunds: rcpAvailable,
                    expenditure: rcpExpenditure,
                    remainingBudget: rcpAvailable - rcpExpenditure,
                    fundingEndDate: rcpBudget.fundingEndDate || null,
                    serviceDeliveredAmount: rcpMetrics.totalAmount,
                    govSubsidyAmount: rcpMetrics.govSubsidy,
                    participantContributionAmount: rcpMetrics.participantContribution,
                    adjustmentAmount: rcpAdjustments,
                    serviceCount: rcpMetrics.serviceCount,
                    availableBalanceRangeLabel: 'A: Funding End Date',
                    expenditurePeriodLabel: 'U: The selected month'
                });

                // End-of-Life Pathway
                // Formula from PDF: Available Funds = {Total Available Budget for End-of-Life Care ($)}
                // U expenditure = [{Service Delivered During the Month ($-)} + {Adjustments from Previous Months [Charges($-)/Refund($)]}]
                const eolMetrics = calculateMetrics(transformedItems, isEndOfLife);
                const eolAdjustments = 0; // TODO: Fetch from Adjustments from Previous Months [Charges($-)/Refund($)] attribute
                const eolExpenditure = eolMetrics.totalAmount + eolAdjustments;
                const eolBudget = budgetData.endOfLife || {};
                // According to PDF: Available Funds = Total Available Budget for End-of-Life Care ($)
                const eolAvailable = eolBudget.totalAvailableBudget || 0;
                budgetCategories.push({
                    name: 'End-of-Life Pathway',
                    code: 'EOL',
                    availableFunds: eolAvailable,
                    expenditure: eolExpenditure,
                    remainingBudget: eolAvailable - eolExpenditure,
                    fundingEndDate: eolBudget.fundingEndDate || null,
                    serviceDeliveredAmount: eolMetrics.totalAmount,
                    govSubsidyAmount: eolMetrics.govSubsidy,
                    participantContributionAmount: eolMetrics.participantContribution,
                    adjustmentAmount: eolAdjustments,
                    serviceCount: eolMetrics.serviceCount,
                    availableBalanceRangeLabel: 'A: Funding End Date',
                    expenditurePeriodLabel: 'U: The selected month'
                });

                // Assistive Technology - Short-term Budget
                // Formula from PDF: Available Funds = {Remaining AT - Short-term Balance for Allocation Period ($)}
                // U expenditure = [{Service Delivered During the Month ($-)} + {Adjustments from Previous Months [Charges($-)/Refund($)]}]
                const atsMetrics = calculateMetrics(transformedItems, isAssistiveTechShortTerm);
                const atsAdjustments = 0; // TODO: Fetch from Adjustments from Previous Months [Charges($-)/Refund($)] attribute
                const atsExpenditure = atsMetrics.totalAmount + atsAdjustments;
                const atsBudget = budgetData.assistiveTechShortTerm || {};
                // According to PDF: Available Funds = Remaining AT - Short-term Balance for Allocation Period ($)
                const atsAvailable = atsBudget.remainingBalance || 0;
                budgetCategories.push({
                    name: 'Assistive Technology - Short-term Budget',
                    code: 'ATS',
                    availableFunds: atsAvailable,
                    expenditure: atsExpenditure,
                    remainingBudget: atsAvailable - atsExpenditure,
                    fundingEndDate: atsBudget.fundingEndDate || null,
                    committedFunds: atsBudget.committedFunds || 0,
                    serviceDeliveredAmount: atsMetrics.totalAmount,
                    govSubsidyAmount: atsMetrics.govSubsidy,
                    participantContributionAmount: atsMetrics.participantContribution,
                    adjustmentAmount: atsAdjustments,
                    serviceCount: atsMetrics.serviceCount,
                    availableBalanceRangeLabel: 'A: Funding End Date',
                    expenditurePeriodLabel: 'U: The selected month'
                });

                // Assistive Technology - Ongoing Budget
                // Formula from PDF: Available Funds = {Remaining AT Ongoing Balance for Allocation Period ($)}
                // U expenditure = [{Service Delivered During the Month ($-)} + {Adjustments from Previous Months [Charges($-)/Refund($)]}]
                const atoMetrics = calculateMetrics(transformedItems, isAssistiveTechOngoing);
                const atoAdjustments = 0; // TODO: Fetch from Adjustments from Previous Months [Charges($-)/Refund($)] attribute
                const atoExpenditure = atoMetrics.totalAmount + atoAdjustments;
                const atoBudget = budgetData.assistiveTechOngoing || {};
                // According to PDF: Available Funds = Remaining AT Ongoing Balance for Allocation Period ($)
                const atoAvailable = atoBudget.remainingBalance || 0;
                budgetCategories.push({
                    name: 'Assistive Technology - Ongoing Budget',
                    code: 'ATO',
                    availableFunds: atoAvailable,
                    expenditure: atoExpenditure,
                    remainingBudget: atoAvailable - atoExpenditure,
                    fundingEndDate: atoBudget.fundingEndDate || null,
                    committedFunds: atoBudget.committedFunds || 0,
                    serviceDeliveredAmount: atoMetrics.totalAmount,
                    govSubsidyAmount: atoMetrics.govSubsidy,
                    participantContributionAmount: atoMetrics.participantContribution,
                    adjustmentAmount: atoAdjustments,
                    serviceCount: atoMetrics.serviceCount,
                    availableBalanceRangeLabel: 'A: Funding End Date',
                    expenditurePeriodLabel: 'U: The selected month'
                });

                // Home Modification Budget
                // Formula from PDF: Available Funds = {Remaining HM Balance for Allocation Period ($)}
                // U expenditure = [{Service Delivered During the Month ($-)} + {Adjustments from Previous Months [Charges($-)/Refund($)]}]
                const hmbMetrics = calculateMetrics(transformedItems, isHomeModification);
                const hmbAdjustments = 0; // TODO: Fetch from Adjustments from Previous Months [Charges($-)/Refund($)] attribute
                const hmbExpenditure = hmbMetrics.totalAmount + hmbAdjustments;
                const hmbBudget = budgetData.homeModification || {};
                // According to PDF: Available Funds = Remaining HM Balance for Allocation Period ($)
                const hmbAvailable = hmbBudget.remainingBalance || 0;
                budgetCategories.push({
                    name: 'Home Modification Budget',
                    code: 'HMB',
                    availableFunds: hmbAvailable,
                    expenditure: hmbExpenditure,
                    remainingBudget: hmbAvailable - hmbExpenditure,
                    fundingEndDate: hmbBudget.fundingEndDate || null,
                    committedFunds: hmbBudget.committedFunds || 0,
                    serviceDeliveredAmount: hmbMetrics.totalAmount,
                    govSubsidyAmount: hmbMetrics.govSubsidy,
                    participantContributionAmount: hmbMetrics.participantContribution,
                    adjustmentAmount: hmbAdjustments,
                    serviceCount: hmbMetrics.serviceCount,
                    availableBalanceRangeLabel: 'A: Funding End Date',
                    expenditurePeriodLabel: 'U: The selected month'
                });
            } catch (budgetError) {
                warn('Items-Service', 'Failed to calculate budget categories', {
                    message: budgetError.message
                }, extractContextFromReq(req));
                // Continue without budget categories - frontend can handle empty array
            }
        }

        // Use totals from aggregation (calculated from ALL matching items in query, not just paginated subset)
        let summaryData;
        if (type === 'monthlystatement' || type === 'monthlyStatement') {
            // For monthly statements, invoiced/pending are not applicable (always 0)
            summaryData = {
                invoiced: 0, // Monthly statements don't track invoiced status per item
                pending: 0, // Monthly statements don't track pending status per item
                totalAmount: totalsData.totalAmount || 0,
                totalGovSubsidy: totalsData.totalGovSubsidy || 0,
                totalParticipantContribution: totalsData.totalParticipantContribution || 0
            };
        } else {
            // For other types (like invoiceparticipanttax), use counts from aggregation
            summaryData = {
                invoiced: totalsData.invoicedCount || 0,
                pending: totalsData.pendingCount || 0,
                totalAmount: totalsData.totalAmount || 0,
                totalGovSubsidy: totalsData.totalGovSubsidy || 0,
                totalParticipantContribution: totalsData.totalParticipantContribution || 0
            };
        }

        // Build response object
        const response = {
            items: transformedItems,
            total,
            invoiced: summaryData.invoiced,
            pending: summaryData.pending,
            totalAmount: summaryData.totalAmount,
            totalGovSubsidy: summaryData.totalGovSubsidy,
            totalParticipantContribution: summaryData.totalParticipantContribution
        };

        // Add participant profile if available (for monthly statement type)
        if ((type === 'monthlystatement' || type === 'monthlyStatement') && participantProfile) {
            response.participantProfile = participantProfile;
        }

        // Add budget categories if available (for monthly statement type)
        if ((type === 'monthlystatement' || type === 'monthlyStatement') && budgetCategories && budgetCategories.length > 0) {
            response.budgetCategories = budgetCategories;
        }

        res.status(200).json(response);
    } catch (err) {
        error('Items-Service', 'Failed to fetch items', {
            message: err.message
        }, extractContextFromReq(req));
        res.status(500).json({ message: 'Server error' });
    }
});

// Get a specific item by ID
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

// Bulk update item invoice status and number
router.post('/:workspaceId/:boardId/update-status', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;
        const { itemIds, invoiceNumber, status } = req.body || {};

        if (!workspaceId || !boardId) {
            return res.status(400).json({ message: 'WorkspaceId and BoardId are required' });
        }

        if (!Array.isArray(itemIds) || itemIds.length === 0) {
            return res.status(400).json({ message: 'itemIds must be a non-empty array' });
        }

        if (!invoiceNumber || typeof invoiceNumber !== 'string') {
            return res.status(400).json({ message: 'invoiceNumber is required' });
        }

        // Currently we only support setting to invoiced; accept payload for future-proofing
        const setInvoiced = status === 'invoiced' || status === true || status === 'true';

        const items = await Item.find({
            workspaceId,
            boardId,
            itemId: { $in: itemIds }
        });

        if (!items || items.length === 0) {
            return res.status(404).json({ message: 'No matching items found' });
        }

        let updatedCount = 0;

        for (const item of items) {
            const values = (item.data && Array.isArray(item.data.values)) ? item.data.values : [];

            const upsertAttribute = (attributeName, value) => {
                const existingIdx = values.findIndex(v => v && v.attribute && v.attribute.name === attributeName);
                if (existingIdx >= 0) {
                    values[existingIdx].data = value;
                } else {
                    values.push({ attribute: { name: attributeName }, data: value });
                }
            };

            upsertAttribute('Invoice Issued and Sent', !!setInvoiced);
            upsertAttribute('Generated Invoice Number', String(invoiceNumber));

            // Persist updated values back
            if (!item.data) item.data = {};
            item.data.values = values;
            item.markModified('data');
            await item.save();
            updatedCount += 1;
        }

        info('Items-Service', 'Updated item statuses', {
            workspaceId,
            boardId,
            updatedCount
        }, extractContextFromReq(req));

        return res.status(200).json({ message: 'Items updated successfully', updated: updatedCount });
    } catch (err) {
        error('Items-Service', 'Failed to update item statuses', {
            message: err.message
        }, extractContextFromReq(req));
        return res.status(500).json({ message: 'Server error' });
    }
});

export default router;