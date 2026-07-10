import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { info, warn } from '../utils/logger.js';
import { getItemValues, ITEM_DELETED } from '../services/isoplus.js';
import { transformItemData } from '../utils/itemTransform.js';
import { itemDataReferencesId } from '../utils/isoplusWebhookHelpers.js';

async function updateSingleReferencingItem(item, referencedIdStr) {
  const referencesItem = itemDataReferencesId(item.data, referencedIdStr);
  if (!referencesItem) return false;

  const itemBoard = await Board.findOne({ boardId: item.boardId, syncData: true }).lean();
  if (!itemBoard) return false;

  const fullItemData = await getItemValues(item.workspaceId, item.boardId, item.itemId);
  if (fullItemData === ITEM_DELETED || !fullItemData) return false;

  const transformedData = transformItemData(fullItemData);
  await Item.findOneAndUpdate(
    { itemId: item.itemId },
    { $set: { data: transformedData, syncGUID: null, updatedAt: new Date() } },
  );

  info('Webhook-Handler', 'Updated referencing item', {
    itemId: item.itemId,
    referencedItemId: referencedIdStr,
    boardId: item.boardId,
  });
  return true;
}

async function processReferencingItemsPage(items, referencedIdStr) {
  let updatedCount = 0;
  for (const item of items) {
    try {
      const updated = await updateSingleReferencingItem(item, referencedIdStr);
      if (updated) updatedCount += 1;
    } catch (itemErr) {
      warn('Webhook-Handler', 'Failed to check/update referencing item', {
        itemId: item.itemId,
        referencedItemId: referencedIdStr,
        error: itemErr.message,
      });
    }
  }
  return updatedCount;
}

export async function updateReferencingWebhookItems(referencedItemId, workspaceId) {
  try {
    const referencedIdStr = referencedItemId.toString();
    const boards = await Board.find({ workspaceId, syncData: true }).select('boardId').lean();
    if (!boards.length) return;

    const boardIds = boards.map((b) => b.boardId);
    const batchSize = 100;
    let processedCount = 0;
    let updatedCount = 0;

    for (const boardIdToCheck of boardIds) {
      let skip = 0;
      while (true) {
        const items = await Item.find({ boardId: boardIdToCheck })
          .select('itemId boardId workspaceId data')
          .skip(skip)
          .limit(batchSize)
          .lean();
        if (!items.length) break;

        updatedCount += await processReferencingItemsPage(items, referencedIdStr);
        processedCount += items.length;
        if (items.length < batchSize) break;
        skip += batchSize;
      }
    }

    if (updatedCount > 0) {
      info('Webhook-Handler', 'Finished updating referencing items', {
        referencedItemId,
        processedCount,
        updatedCount,
      });
    }
  } catch (err) {
    warn('Webhook-Handler', 'Failed to update referencing items', {
      referencedItemId,
      error: err.message,
    });
  }
}
