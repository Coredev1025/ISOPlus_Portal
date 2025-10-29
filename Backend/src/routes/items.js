import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Item from '../models/Item.js';
import { info, error, warn, extractContextFromReq } from '../utils/logger.js';
import { getFolder } from '../services/isoplus.js';

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
router.get('/:workspaceId/:boardId', authenticateToken, async (req, res) => {
    try {
        const { workspaceId, boardId } = req.params;

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

        // Build base query
        const query = {
            workspaceId,
            boardId
        };

        // Add status filter if provided
        if (status && status !== 'all') {
            if (!query['data.values']) {
                query['data.values'] = { $all: [] };
            }
            
            // Handle invoice status
            const statusCondition = {
                $elemMatch: {
                    'attribute.name': 'Invoice Issued and Sent',
                    'data': status === 'invoiced'
                }
            };
            query['data.values'].$all.push(statusCondition);
        }

        const folderIds = await getFolderIds(folderName, workspaceId, boardId);
        if(folderIds && folderIds.length > 0) {
            query.folderId = { $in: folderIds };
        }

        if (startDate || endDate) {
            if (!query['data.values']) {
                query['data.values'] = { $all: [] };
            }
            // Filter for Scheduled Start Date
            query['data.values'].$all.push({
                $elemMatch: {
                    'attribute.name': 'Scheduled Shift Start Date & Time',
                    'data': startDate ? {
                        $gte: new Date(startDate)
                    } : {
                        $lte: new Date(endDate)
                    }
                }
            });
            // Filter for Scheduled End Date
            query['data.values'].$all.push({
                $elemMatch: {
                    'attribute.name': 'Scheduled Shift End Date & Time',
                    'data': endDate ? {
                        $lte: new Date(endDate)
                    } : {
                        $gte: new Date(startDate)
                    }
                }
            });
        }

        if (deliveryStartDate || deliveryEndDate) {
            if (!query['data.values']) {
                query['data.values'] = { $all: [] };
            }
            // Filter for Actual Start Date
            query['data.values'].$all.push({
                $elemMatch: {
                    'attribute.name': 'Actual Shift Start Date and Time',
                    'data': deliveryStartDate ? {
                        $gte: new Date(deliveryStartDate)
                    } : {
                        $lte: new Date(deliveryEndDate)
                    }
                }
            });
            // Filter for Actual End Date
            query['data.values'].$all.push({
                $elemMatch: {
                    'attribute.name': 'Actual Shift End Date and Time',
                    'data': deliveryEndDate ? {
                        $lte: new Date(deliveryEndDate)
                    } : {
                        $gte: new Date(deliveryStartDate)
                    }
                }
            });
        }

        if (participant) {
            if (!query['data.values']) {
                query['data.values'] = { $all: [] };
            }
            query['data.values'].$all.push({
                $elemMatch: {
                    'attribute.name': 'Participant Full Name',
                    'data': {
                        $regex: participant,
                        $options: 'i'  // case-insensitive matching
                    }
                }
            });
        }

        // Calculate pagination
        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Find items matching the criteria
        const items = await Item.find(query)
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        // Get total count of matching records
        const total = await Item.countDocuments(query);

        // Transform items for frontend display
        const transformedItems = items.map(item => {
            const getValue = (attributeName) => {
                return item.data.values.find(v => v.attribute.name === attributeName)?.data;
            };

            // Get status
            const invoiceIssued = getValue('Invoice Issued and Sent') || false;
            const paymentStatus = getValue('Payment Status') || [];
            const status = invoiceIssued || (Array.isArray(paymentStatus) && paymentStatus.some(p => p.name === 'Paid'))
                ? 'invoiced'
                : 'pending';

            // Get participant name and scheduled start
            const participant = getValue('Participant Full Name') || '';
            const scheduledStart = getValue('Scheduled Shift Start Date & Time');
            
            // Get worker information
            const worker = getValue('Worker/Planner')?.toString() || 'N/A';
            
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
                worker,
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

export default router;