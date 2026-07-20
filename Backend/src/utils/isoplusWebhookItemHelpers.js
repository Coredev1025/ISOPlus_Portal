import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { info, warn } from '../utils/logger.js';
import { getItemValues, ITEM_DELETED } from '../services/isoplus.js';
import { transformItemData } from '../utils/itemTransform.js';
import { mongoEq } from './securityHelpers.js';

async function getBoardSyncGUID(boardId) {
  const safeBoardId = mongoEq(boardId);
  if (!safeBoardId) return null;
  const board = await Board.findOne({ boardId: safeBoardId }).select('currentSyncGUID').lean();
  return board?.currentSyncGUID || null;
}

export async function deleteWebhookItemFromDatabase(itemId) {
  const safeItemId = mongoEq(itemId);
  if (!safeItemId) return null;

  const item = await Item.findOne({ itemId: safeItemId }).select('boardId workspaceId').lean();
  if (!item) {
    info('Webhook-Handler', 'Item not in database, nothing to delete', { itemId: safeItemId });
    return null;
  }

  await Item.findOneAndDelete({ itemId: safeItemId });
  await Board.findOneAndUpdate({ boardId: mongoEq(item.boardId) }, { $inc: { 'syncStats.itemsSynced': -1 } });
  info('Webhook-Handler', 'Item deleted from database (confirmed deleted in ISO+)', {
    itemId: safeItemId,
    boardId: item.boardId,
  });
  return { deleted: true, itemId: safeItemId, boardId: item.boardId, workspaceId: item.workspaceId };
}

async function findExistingWebhookItem(itemId) {
  const safeItemId = mongoEq(itemId);
  if (!safeItemId) return null;

  const item = await Item.findOne({ itemId: safeItemId }).select('boardId workspaceId syncGUID').lean();
  if (!item) return null;
  const currentSyncGUID = await getBoardSyncGUID(item.boardId);
  return { item, boardId: item.boardId, workspaceId: item.workspaceId, currentSyncGUID };
}

async function searchSyncedBoardsForItem(itemId) {
  const safeItemId = mongoEq(itemId);
  if (!safeItemId) return null;

  const boards = await Board.find({ syncData: true }).select('workspaceId boardId currentSyncGUID').lean();
  for (const board of boards) {
    if (!board.workspaceId || !board.boardId) continue;
    try {
      const itemData = await getItemValues(
        mongoEq(board.workspaceId),
        mongoEq(board.boardId),
        safeItemId,
      );
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
  const safeItemId = mongoEq(itemId);
  const safeWorkspaceId = mongoEq(workspaceId);
  const safeBoardId = mongoEq(boardId);
  if (!safeItemId || !safeWorkspaceId || !safeBoardId) return null;

  try {
    const itemData = await getItemValues(safeWorkspaceId, safeBoardId, safeItemId);
    if (itemData === ITEM_DELETED) return { itemDeletedInIsoPlus: true };
    const currentSyncGUID = await getBoardSyncGUID(safeBoardId);
    return { itemData, currentSyncGUID };
  } catch (err) {
    warn('Webhook-Handler', 'Failed to fetch item from API', {
      itemId: safeItemId,
      boardId: safeBoardId,
      workspaceId: safeWorkspaceId,
      error: err.message,
    });
    return null;
  }
}

async function upsertWebhookItemFromApi({ itemId, itemData, foundWorkspaceId, foundBoardId, currentSyncGUID }) {
  const safeItemId = mongoEq(itemId);
  const safeWorkspaceId = mongoEq(foundWorkspaceId);
  const safeBoardId = mongoEq(foundBoardId);
  if (!safeItemId || !safeWorkspaceId || !safeBoardId) return null;

  const rawFolderId = itemData.folder_id || itemData.folder?.id;
  const folderId = rawFolderId != null && rawFolderId !== '' ? String(rawFolderId) : '';
  if (!folderId) {
    info('Webhook-Handler', 'Item has no folder_id; storing empty folderId (aligned with sync worker)', {
      itemId: safeItemId,
      boardId: safeBoardId,
    });
  }

  const transformedData = transformItemData(itemData);
  const now = new Date();
  let item;
  try {
    item = await Item.findOneAndUpdate(
      { itemId: safeItemId },
      {
        $set: {
          workspaceId: safeWorkspaceId,
          boardId: safeBoardId,
          folderId,
          itemId: safeItemId,
          isoPlusItemId: safeItemId,
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
      item = await Item.findOne({ itemId: safeItemId }).lean();
      if (!item) throw err;
      info('Webhook-Handler', 'Item already existed, reused existing record after duplicate key', {
        itemId: safeItemId,
        boardId: item.boardId,
        workspaceId: item.workspaceId,
      });
    } else {
      throw err;
    }
  }

  info('Webhook-Handler', 'Created or updated item from API', {
    itemId: safeItemId,
    boardId: safeBoardId,
    workspaceId: safeWorkspaceId,
    folderId,
    syncGUID: currentSyncGUID,
  });
  return { item, boardId: safeBoardId, workspaceId: safeWorkspaceId, currentSyncGUID };
}

function mapApiLookupResult(result, defaults = {}) {
  if (!result) {
    return {
      itemDeletedInIsoPlus: false,
      itemData: null,
      foundBoardId: defaults.foundBoardId ?? null,
      foundWorkspaceId: defaults.foundWorkspaceId ?? null,
      currentSyncGUID: null,
    };
  }
  if (result.itemDeletedInIsoPlus) {
    return {
      itemDeletedInIsoPlus: true,
      itemData: null,
      foundBoardId: result.foundBoardId ?? defaults.foundBoardId ?? null,
      foundWorkspaceId: result.foundWorkspaceId ?? defaults.foundWorkspaceId ?? null,
      currentSyncGUID: null,
    };
  }
  if (result.itemData) {
    return {
      itemDeletedInIsoPlus: false,
      itemData: result.itemData,
      foundBoardId: result.foundBoardId ?? defaults.foundBoardId ?? null,
      foundWorkspaceId: result.foundWorkspaceId ?? defaults.foundWorkspaceId ?? null,
      currentSyncGUID: result.currentSyncGUID ?? null,
    };
  }
  return {
    itemDeletedInIsoPlus: false,
    itemData: null,
    foundBoardId: defaults.foundBoardId ?? null,
    foundWorkspaceId: defaults.foundWorkspaceId ?? null,
    currentSyncGUID: null,
  };
}

async function resolveWebhookItemApiData(safeItemId, safeBoardId, safeWorkspaceId) {
  if (!safeBoardId || !safeWorkspaceId) {
    return mapApiLookupResult(await searchSyncedBoardsForItem(safeItemId));
  }
  const fetchResult = await fetchItemFromKnownBoard(safeItemId, safeWorkspaceId, safeBoardId);
  return mapApiLookupResult(fetchResult, {
    foundBoardId: safeBoardId,
    foundWorkspaceId: safeWorkspaceId,
  });
}

async function handleWebhookItemDeletedInIsoPlus(safeItemId, foundBoardId) {
  info('Webhook-Handler', 'Item deleted in ISO+ (404), deleting local copy', { itemId: safeItemId, boardId: foundBoardId });
  const deleteResult = await deleteWebhookItemFromDatabase(safeItemId);
  return deleteResult ? { deleted: true, ...deleteResult } : { deleted: true, itemId: safeItemId };
}

export async function fetchOrCreateWebhookItem(itemId, boardId = null, workspaceId = null) {
  const safeItemId = mongoEq(itemId);
  if (!safeItemId) return null;

  const existing = await findExistingWebhookItem(safeItemId);
  if (existing) return existing;

  const safeBoardId = boardId ? mongoEq(boardId) : null;
  const safeWorkspaceId = workspaceId ? mongoEq(workspaceId) : null;
  const lookup = await resolveWebhookItemApiData(safeItemId, safeBoardId, safeWorkspaceId);

  if (lookup.itemDeletedInIsoPlus) {
    return handleWebhookItemDeletedInIsoPlus(safeItemId, lookup.foundBoardId);
  }

  if (!lookup.itemData) {
    warn('Webhook-Handler', 'Item not found in database or API', {
      itemId: safeItemId,
      boardId: lookup.foundBoardId ?? safeBoardId,
    });
    return null;
  }

  return upsertWebhookItemFromApi({
    itemId: safeItemId,
    itemData: lookup.itemData,
    foundWorkspaceId: lookup.foundWorkspaceId,
    foundBoardId: lookup.foundBoardId,
    currentSyncGUID: lookup.currentSyncGUID,
  });
}
