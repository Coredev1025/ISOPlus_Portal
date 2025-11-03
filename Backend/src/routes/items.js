import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Item from '../models/Item.js';
import { info, error, warn, extractContextFromReq } from '../utils/logger.js';
import { getReferences, getAttribute, getItemValues, getFolder, getMember } from '../services/isoplus.js';

const router = express.Router();

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
                            cond: { $eq: ["$$value.attribute.name", "Scheduled Shift Start Date & Time"] }
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
                            cond: { $eq: ["$$value.attribute.name", "Actual Shift Start Date and Time"] }
                        }
                    },
                    actualEndValue: {
                        $filter: {
                            input: "$data.values",
                            as: "value",
                            cond: { $eq: ["$$value.attribute.name", "Actual Shift End Date and Time"] }
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
                    }
                }
            },
            {
                $addFields: {
                    scheduledStartRaw: { $arrayElemAt: ["$scheduledStartValue.data", 0] },
                    scheduledEndRaw: { $arrayElemAt: ["$scheduledEndValue.data", 0] },
                    actualStartRaw: { $arrayElemAt: ["$actualStartValue.data", 0] },
                    actualEndRaw: { $arrayElemAt: ["$actualEndValue.data", 0] },
                    participantNameRaw: { $arrayElemAt: ["$participantValue.data", 0] },
                    invoiceIssuedRaw: { $ifNull: [{ $arrayElemAt: ["$invoiceIssuedValue.data", 0] }, false] },
                    paymentStatusRaw: { $ifNull: [{ $arrayElemAt: ["$paymentStatusValue.data", 0] }, []] }
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

        // Sort and paginate, with total count
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
                    ]
                }
            }
        );

        const aggResult = await Item.aggregate(pipeline);
        const items = (aggResult[0] && aggResult[0].items) ? aggResult[0].items : [];
        const total = (aggResult[0] && aggResult[0].totalCount && aggResult[0].totalCount[0]) ? aggResult[0].totalCount[0].count : 0;

        // Transform items for frontend display
        const transformedItems = items.map(item => {
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
                notes,
                invoiceNumber
            };
        });

        // Calculate summary data
        const summaryData = transformedItems.reduce((acc, item) => ({
            invoiced: acc.invoiced + (item.status === 'invoiced' ? 1 : 0),
            pending: acc.pending + (item.status === 'pending' ? 1 : 0),
            totalAmount: acc.totalAmount + item.totalAmount,
            totalGovSubsidy: acc.totalGovSubsidy + item.govSubsidy,
            totalParticipantContribution: acc.totalParticipantContribution + item.participantContribution
        }), { invoiced: 0, pending: 0, totalAmount: 0, totalGovSubsidy: 0, totalParticipantContribution: 0 });

        res.status(200).json({
            items: transformedItems,
            total,
            invoiced: summaryData.invoiced,
            pending: summaryData.pending,
            totalAmount: summaryData.totalAmount,
            totalGovSubsidy: summaryData.totalGovSubsidy,
            totalParticipantContribution: summaryData.totalParticipantContribution
        });
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