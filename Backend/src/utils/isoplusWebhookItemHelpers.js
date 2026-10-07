import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { info, warn } from '../utils/logger.js';
import { getItemValues, ITEM_DELETED } from '../services/isoplus.js';
import { transformItemData } from '../utils/itemTransform.js';
import { mongoEq } from './securityHelpers.js';
import { ISOPLUS_ITEM_LOOKUP_CONCURRENCY, ISOPLUS_ITEM_SCAN_MAX_RETRIES } from '../constants/isoplusItemLookup.js';
import {
  IsoPlusRateLimitedError,
  createConcurrencyLimiter,
  createInFlightDeduper,
} from './isoplusRateLimitHelpers.js';

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

const itemLookupLimit = createConcurrencyLimiter(ISOPLUS_ITEM_LOOKUP_CONCURRENCY);
const dedupeItemSearch = createInFlightDeduper();

const SCAN_READ_OPTIONS = { throwOnRateLimit: true, maxRetries: ISOPLUS_ITEM_SCAN_MAX_RETRIES };
const limitedGetItemValues = (workspaceId, boardId, itemId) =>
  itemLookupLimit(() => getItemValues(workspaceId, boardId, itemId, undefined, SCAN_READ_OPTIONS));

const RATE_LIMITED = Symbol('RATE_LIMITED');
const UNKNOWN = Symbol('UNKNOWN');

/** One board's answer: item data, ITEM_DELETED, RATE_LIMITED, or UNKNOWN (null or any other failure). */
async function probeBoard(board, safeItemId) {
  try {
    const itemData = await limitedGetItemValues(mongoEq(board.workspaceId), mongoEq(board.boardId), safeItemId);
    return itemData || UNKNOWN;
  } catch (err) {
    return err instanceof IsoPlusRateLimitedError ? RATE_LIMITED : UNKNOWN;
  }
}

async function scanBoardsForItem(safeItemId) {
  const boards = await Board.find({ syncData: true }).select('workspaceId boardId currentSyncGUID').lean();
  // A 404 from one board means the item is not on THAT board (KAN-281). Only when
  // every board answered, and none was rate limited or errored, is it deleted.
  let notFoundOn = null;
  let incomplete = false;
  for (const board of boards.filter((b) => b.workspaceId && b.boardId)) {
    const answer = await probeBoard(board, safeItemId);
    if (answer === RATE_LIMITED) {
      warn('Webhook-Handler', 'ISO+ is rate limiting, stopping the board scan for this item', { itemId: safeItemId });
      return null;
    }
    if (answer === ITEM_DELETED) notFoundOn = notFoundOn ?? board;
    else if (answer === UNKNOWN) incomplete = true;
    else {
      return {
        itemData: answer,
        foundBoardId: board.boardId,
        foundWorkspaceId: board.workspaceId,
        currentSyncGUID: board.currentSyncGUID,
      };
    }
  }
  if (!notFoundOn || incomplete) return null;
  return { itemDeletedInIsoPlus: true, foundBoardId: notFoundOn.boardId, foundWorkspaceId: notFoundOn.workspaceId };
}

function searchSyncedBoardsForItem(itemId) {
  const safeItemId = mongoEq(itemId);
  if (!safeItemId) return Promise.resolve(null);
  return dedupeItemSearch(safeItemId, () => scanBoardsForItem(safeItemId));
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
