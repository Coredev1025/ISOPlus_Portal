import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { info, warn } from '../utils/logger.js';
import { getItemValues, ITEM_DELETED } from '../services/isoplus.js';
import { transformItemData } from '../utils/itemTransform.js';

async function getBoardSyncGUID(boardId) {
  const board = await Board.findOne({ boardId }).select('currentSyncGUID').lean();
  return board?.currentSyncGUID || null;
}

export async function deleteWebhookItemFromDatabase(itemId) {
  const item = await Item.findOne({ itemId }).select('boardId workspaceId').lean();
  if (!item) {
    info('Webhook-Handler', 'Item not in database, nothing to delete', { itemId });
    return null;
  }

  await Item.findOneAndDelete({ itemId });
  await Board.findOneAndUpdate({ boardId: item.boardId }, { $inc: { 'syncStats.itemsSynced': -1 } });
  info('Webhook-Handler', 'Item deleted from database (confirmed deleted in ISO+)', {
    itemId,
    boardId: item.boardId,
  });
  return { deleted: true, itemId, boardId: item.boardId, workspaceId: item.workspaceId };
}

async function findExistingWebhookItem(itemId) {
  const item = await Item.findOne({ itemId }).select('boardId workspaceId syncGUID').lean();
  if (!item) return null;
  const currentSyncGUID = await getBoardSyncGUID(item.boardId);
  return { item, boardId: item.boardId, workspaceId: item.workspaceId, currentSyncGUID };
}

async function searchSyncedBoardsForItem(itemId) {
  const boards = await Board.find({ syncData: true }).select('workspaceId boardId currentSyncGUID').lean();
  for (const board of boards) {
    if (!board.workspaceId || !board.boardId) continue;
    try {
      const itemData = await getItemValues(board.workspaceId, board.boardId, itemId);
      if (itemData === ITEM_DELETED) {
        return { itemDeletedInIsoPlus: true, foundBoardId: board.boardId, foundWorkspaceId: board.workspaceId };
      }
      if (itemData) {
        return {
          itemData,
          foundBoardId: board.boardId,
          foundWorkspaceId: board.workspaceId,
          currentSyncGUID: board.currentSyncGUID,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchItemFromKnownBoard(itemId, workspaceId, boardId) {
  try {
    const itemData = await getItemValues(workspaceId, boardId, itemId);
    if (itemData === ITEM_DELETED) return { itemDeletedInIsoPlus: true };
    const currentSyncGUID = await getBoardSyncGUID(boardId);
    return { itemData, currentSyncGUID };
  } catch (err) {
    warn('Webhook-Handler', 'Failed to fetch item from API', {
      itemId,
      boardId,
      workspaceId,
      error: err.message,
    });
    return null;
  }
}

async function upsertWebhookItemFromApi({ itemId, itemData, foundWorkspaceId, foundBoardId, currentSyncGUID }) {
  const rawFolderId = itemData.folder_id || itemData.folder?.id;
  const folderId = rawFolderId != null && rawFolderId !== '' ? String(rawFolderId) : '';
  if (!folderId) {
    info('Webhook-Handler', 'Item has no folder_id; storing empty folderId (aligned with sync worker)', {
      itemId,
      boardId: foundBoardId,
    });
  }

  const transformedData = transformItemData(itemData);
  const now = new Date();
  let item;
  try {
    item = await Item.findOneAndUpdate(
      { itemId },
      {
        $set: {
          workspaceId: foundWorkspaceId,
          boardId: foundBoardId,
          folderId,
          itemId,
          isoPlusItemId: itemId,
          syncGUID: currentSyncGUID,
          data: transformedData,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    if (err?.code === 11000) {
      item = await Item.findOne({ itemId }).lean();
      if (!item) throw err;
      info('Webhook-Handler', 'Item already existed, reused existing record after duplicate key', {
        itemId,
        boardId: item.boardId,
        workspaceId: item.workspaceId,
      });
    } else {
      throw err;
    }
  }

  info('Webhook-Handler', 'Created or updated item from API', {
    itemId,
    boardId: foundBoardId,
    workspaceId: foundWorkspaceId,
    folderId,
    syncGUID: currentSyncGUID,
  });
  return { item, boardId: foundBoardId, workspaceId: foundWorkspaceId, currentSyncGUID };
}

export async function fetchOrCreateWebhookItem(itemId, boardId = null, workspaceId = null) {
  const existing = await findExistingWebhookItem(itemId);
  if (existing) return existing;

  let itemData = null;
  let foundBoardId = boardId;
  let foundWorkspaceId = workspaceId;
  let currentSyncGUID = null;
  let itemDeletedInIsoPlus = false;

  if (!foundBoardId || !foundWorkspaceId) {
    const searchResult = await searchSyncedBoardsForItem(itemId);
    if (searchResult?.itemDeletedInIsoPlus) {
      itemDeletedInIsoPlus = true;
      foundBoardId = searchResult.foundBoardId;
      foundWorkspaceId = searchResult.foundWorkspaceId;
    } else if (searchResult?.itemData) {
      itemData = searchResult.itemData;
      foundBoardId = searchResult.foundBoardId;
      foundWorkspaceId = searchResult.foundWorkspaceId;
      currentSyncGUID = searchResult.currentSyncGUID;
    }
  } else {
    const fetchResult = await fetchItemFromKnownBoard(itemId, foundWorkspaceId, foundBoardId);
    if (fetchResult?.itemDeletedInIsoPlus) {
      itemDeletedInIsoPlus = true;
    } else if (fetchResult?.itemData) {
      itemData = fetchResult.itemData;
      currentSyncGUID = fetchResult.currentSyncGUID;
    }
  }

  if (itemDeletedInIsoPlus) {
    info('Webhook-Handler', 'Item deleted in ISO+ (404), deleting local copy', { itemId, boardId: foundBoardId });
    const deleteResult = await deleteWebhookItemFromDatabase(itemId);
    return deleteResult ? { deleted: true, ...deleteResult } : { deleted: true, itemId };
  }

  if (!itemData) {
    warn('Webhook-Handler', 'Item not found in database or API', { itemId, boardId: foundBoardId });
    return null;
  }

  return upsertWebhookItemFromApi({ itemId, itemData, foundWorkspaceId, foundBoardId, currentSyncGUID });
}
