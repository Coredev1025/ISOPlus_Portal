import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { info, warn, error } from '../utils/logger.js';
import { getItemValues, ITEM_DELETED } from '../services/isoplus.js';
import { transformItemData, transformValue } from '../utils/itemTransform.js';
import { syncTimeTrackingFromItem } from '../utils/timeTrackSync.js';
import { resolveWebhookTransformedValue } from '../utils/isoplusWebhookHelpers.js';
import { deleteWebhookItemFromDatabase, fetchOrCreateWebhookItem } from '../utils/isoplusWebhookItemHelpers.js';
import { updateReferencingWebhookItems } from '../utils/isoplusWebhookReferenceHelpers.js';
import { mongoEq } from '../utils/securityHelpers.js';

async function refreshItemDataFromApi(workspaceId, boardId, itemId, valueId) {
  const safeWorkspaceId = mongoEq(workspaceId);
  const safeBoardId = mongoEq(boardId);
  const safeItemId = mongoEq(itemId);
  if (!safeWorkspaceId || !safeBoardId || !safeItemId) return { refreshed: false };

  const fullItemData = await getItemValues(safeWorkspaceId, safeBoardId, safeItemId);
  if (fullItemData === ITEM_DELETED) {
    info('Webhook-Handler', 'Item was deleted in ISO+ during refresh, deleting local copy', { itemId: safeItemId, valueId });
    await deleteWebhookItemFromDatabase(safeItemId);
    return { deleted: true };
  }
  if (!fullItemData) return { refreshed: false };

  const transformedData = transformItemData(fullItemData);
  await Item.findOneAndUpdate(
    { itemId: safeItemId },
    { $set: { data: transformedData, syncGUID: null, updatedAt: new Date() } },
  );
  syncTimeTrackingFromItem(safeWorkspaceId, safeBoardId, safeItemId, transformedData)
    .catch((ttErr) => warn('Webhook-Handler', 'TT sync failed after value.updated', { itemId: safeItemId, error: ttErr.message }));
  return { refreshed: true, transformedData };
}

async function updateItemByAttributeName(itemId, payload, isDeleted, attributeName) {
  const safeItemId = mongoEq(itemId);
  if (!safeItemId) return false;

  const transformedValue = resolveWebhookTransformedValue(payload, isDeleted, transformValue, warn);
  const updateObj = {
    [`data.${attributeName}`]: transformedValue,
    syncGUID: null,
    updatedAt: new Date(),
  };
  await Item.findOneAndUpdate({ itemId: safeItemId }, { $set: updateObj });
  return true;
}

export async function handleWebhookValueUpdated(payload) {
  try {
    const valueId = mongoEq(payload.id);
    const itemId = mongoEq(payload.item_id);
    const attributeId = mongoEq(payload.attribute_id);
    const attributeName = payload.attribute?.name;
    const isDeleted = payload.deleted === true;

    info('Webhook-Handler', 'Processing value.updated event', {
      valueId,
      itemId,
      attributeId,
      attributeName,
      isDeleted,
    });

    if (!itemId) {
      warn('Webhook-Handler', 'No item_id in value.updated payload', { valueId });
      return;
    }

    const itemResult = await fetchOrCreateWebhookItem(itemId);
    if (!itemResult) {
      warn('Webhook-Handler', 'Item not found for value update and could not be fetched', { itemId, valueId });
      return;
    }
    if (itemResult.deleted) {
      info('Webhook-Handler', 'Item was deleted in ISO+, skipping value update', { itemId, valueId });
      return;
    }

    const { boardId, workspaceId } = itemResult;
    if (!boardId) {
      warn('Webhook-Handler', 'No boardId found on item', { itemId, valueId });
      return;
    }

    const board = await Board.findOne({ boardId: mongoEq(boardId), syncData: true }).select('currentSyncGUID').lean();
    if (!board) {
      info('Webhook-Handler', 'Board not found or sync not enabled', { boardId });
      return;
    }

    let updateSuccessful = false;
    try {
      const refreshResult = await refreshItemDataFromApi(workspaceId, boardId, itemId, valueId);
      if (refreshResult.deleted) return;
      if (refreshResult.refreshed) {
        info('Webhook-Handler', 'Item data refreshed and transformed', {
          itemId,
          valueId,
          attributeId,
          attributeName: attributeName || 'fetched from API',
        });
        updateSuccessful = true;
      } else if (attributeName) {
        await updateItemByAttributeName(itemId, payload, isDeleted, attributeName);
        info('Webhook-Handler', 'Value updated by attribute name (with transformation)', {
          itemId,
          valueId,
          attributeName,
          attributeType: payload.attribute?.type,
        });
        updateSuccessful = true;
      } else {
        warn('Webhook-Handler', 'Cannot update value - no attribute name and failed to fetch item', {
          itemId,
          valueId,
          attributeId,
        });
      }
    } catch (fetchErr) {
      warn('Webhook-Handler', 'Failed to fetch full item data, skipping update', {
        itemId,
        valueId,
        error: fetchErr.message,
      });
    }

    if (!updateSuccessful) return;

    info('Webhook-Handler', 'Value updated successfully', { itemId, valueId, boardId, attributeId, isDeleted });
    const attributeType = payload.attribute?.type;
    if (attributeType === 'reference' || attributeType === 'members') {
      await updateReferencingWebhookItems(itemId, workspaceId);
    }
  } catch (err) {
    error('Webhook-Handler', 'Failed to handle value.updated', {
      valueId: payload?.id,
      itemId: payload?.item_id,
      error: err.message,
      stack: err.stack,
    });
    throw err;
  }
}
