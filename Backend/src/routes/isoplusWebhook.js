import express from 'express';
import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { info, error, warn } from '../utils/logger.js';
import { getItemValues, ITEM_DELETED } from '../services/isoplus.js';
import { transformItemData, transformValue } from '../utils/itemTransform.js';
import { syncTimeTrackingFromItem } from '../utils/timeTrackSync.js';
import {
  itemDataReferencesId,
  resolveWebhookTransformedValue,
  describeHookPayloadShape,
} from '../utils/isoplusWebhookHelpers.js';
import {
  deleteWebhookItemFromDatabase,
  fetchOrCreateWebhookItem,
} from '../utils/isoplusWebhookItemHelpers.js';
import { updateReferencingWebhookItems } from '../utils/isoplusWebhookReferenceHelpers.js';
import { handleWebhookValueUpdated } from '../utils/isoplusWebhookValueUpdateHelpers.js';
import { mongoEq, mongoEqOrNull } from '../utils/securityHelpers.js';

const fetchOrCreateItem = fetchOrCreateWebhookItem;
const deleteItemFromDatabase = deleteWebhookItemFromDatabase;
const updateReferencingItems = updateReferencingWebhookItems;
const handleValueUpdated = handleWebhookValueUpdated;

const router = express.Router();

router.post('/isoplus', async (req, res) => {
  try {
    const { event, payload } = req.body;
    
    info('Webhook-Handler', 'Received hook event', { 
      event, 
      payloadObject: payload?.object,
      payloadId: payload?.id,
      ...describeHookPayloadShape(payload),
    }, req ?? null);

    if (!event || !payload) {
      warn('Webhook-Handler', 'Invalid hook payload', { 
        body: req.body 
      }, req ?? null);
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid hook payload' 
      });
    }

    switch (event) {
      case 'item.created':
        await handleItemCreated(payload);
        break;
      
      case 'item.updated':
        await handleItemUpdated(payload);
        break;
      
      case 'item.finalized':
        await handleItemFinalized(payload);
        break;
      
      case 'item.deleted':
        await handleItemDeleted(payload);
        break;
      
      case 'value.created':
        await handleValueCreated(payload);
        break;
      
      case 'value.updated':
        await handleValueUpdated(payload);
        break;
      
      case 'comment.created':
        await handleCommentCreated(payload);
        break;
      
      case 'comment.updated':
        await handleCommentUpdated(payload);
        break;
      
      default:
        info('Webhook-Handler', 'Ignoring hook event type', { 
          event
        }, req ?? null);
        return res.status(200).json({ 
          success: true, 
          message: 'Event acknowledged' 
        });
    }

    info('Webhook-Handler', 'Hook processed successfully', { 
      event, 
      payloadId: payload?.id 
    }, req ?? null);

    res.status(200).json({ 
      success: true, 
      message: 'Hook processed successfully' 
    });

  } catch (err) {
    error('Webhook-Handler', 'Failed to process hook', { 
      error: err.message,
      stack: err.stack 
    }, req ?? null);
    
    res.status(200).json({ 
      success: false, 
      message: 'Failed to process hook',
      error: err.message 
    });
  }
});




async function handleItemCreated(payload) {
  try {
    const itemId = mongoEq(payload.id);
    const boardId = mongoEqOrNull(payload.board_id);
    const workspaceId = mongoEqOrNull(payload.workspace_id);
    
    info('Webhook-Handler', 'Processing item.created event', { 
      itemId,
      boardId
    });

    const itemResult = await fetchOrCreateItem(itemId, boardId, workspaceId);
    if (!itemResult) {
      warn('Webhook-Handler', 'Could not fetch or create new item', { itemId });
      return;
    }

    if (itemResult.deleted) {
      warn('Webhook-Handler', 'Newly created item was deleted in ISO+ immediately', { 
        itemId
      });
      return;
    }

    info('Webhook-Handler', 'Item created successfully', { 
      itemId, 
      boardId: itemResult.boardId
    });

  } catch (err) {
    error('Webhook-Handler', 'Failed to handle item.created', { 
      itemId: payload?.id,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

async function handleValueCreated(payload) {
  try {
    const valueId = mongoEq(payload.id);
    const itemId = mongoEq(payload.item_id);
    const attributeId = mongoEq(payload.attribute_id);
    
    info('Webhook-Handler', 'Processing value.created event', { 
      valueId,
      itemId,
      attributeId
    });

    if (!itemId) {
      warn('Webhook-Handler', 'No item_id in value.created payload', { valueId });
      return;
    }

    const itemResult = await fetchOrCreateItem(itemId, mongoEqOrNull(payload.board_id), mongoEqOrNull(payload.workspace_id));
    if (!itemResult) {
      warn('Webhook-Handler', 'Item not found for value create and could not be fetched', { 
        itemId, 
        valueId
      });
      return;
    }

    if (itemResult.deleted) {
      info('Webhook-Handler', 'Item was deleted in ISO+, skipping value create', { 
        itemId, 
        valueId
      });
      return;
    }

    const { boardId, workspaceId } = itemResult;
    if (!boardId) {
      warn('Webhook-Handler', 'No boardId found on item', { itemId, valueId });
      return;
    }

    const board = await Board.findOne({ boardId: mongoEq(boardId), syncData: true }).lean();
    if (!board) {
      info('Webhook-Handler', 'Board not found or sync not enabled', { boardId });
      return;
    }

    const fullItemData = await getItemValues(workspaceId, boardId, itemId);
    
    if (fullItemData === ITEM_DELETED) {
      info('Webhook-Handler', 'Item was deleted in ISO+ during value.created refresh', { 
        itemId, 
        valueId
      });
      await deleteItemFromDatabase(itemId);
      return;
    }
    
    if (fullItemData) {
      const transformedData = transformItemData(fullItemData);
      await Item.findOneAndUpdate(
        { itemId: mongoEq(itemId) },
        {
          $set: {
            data: transformedData,
            syncGUID: null,
            updatedAt: new Date()
          }
        }
      );
      
      const boardMeta = await Board.findOne({ boardId: mongoEq(itemResult.boardId) })
        .select('workspaceId boardId')
        .lean();
      if (boardMeta) {
        syncTimeTrackingFromItem(boardMeta.workspaceId, boardMeta.boardId, itemId, transformedData)
          .catch(ttErr => warn('Webhook-Handler', 'TT sync failed after value.created', { itemId, error: ttErr.message }));
      }
      
      info('Webhook-Handler', 'Value created and item data refreshed', { 
        itemId, 
        valueId,
        boardId
      });
    }

  } catch (err) {
    error('Webhook-Handler', 'Failed to handle value.created', { 
      valueId: payload?.id,
      itemId: payload?.item_id,
      error: err.message 
    });
    throw err;
  }
}

async function handleCommentCreated(payload) {
  try {
    const commentId = payload.id;
    const itemId = payload.item_id;
    
    info('Webhook-Handler', 'Processing comment.created event', { 
      commentId,
      itemId
    });

    info('Webhook-Handler', 'Comment created acknowledged', { 
      commentId,
      itemId
    });

  } catch (err) {
    error('Webhook-Handler', 'Failed to handle comment.created', { 
      commentId: payload?.id,
      itemId: payload?.item_id,
      error: err.message 
    });
    throw err;
  }
}

async function handleCommentUpdated(payload) {
  try {
    const commentId = payload.id;
    const itemId = payload.item_id;
    
    info('Webhook-Handler', 'Processing comment.updated event', { 
      commentId,
      itemId
    });

    info('Webhook-Handler', 'Comment updated acknowledged', { 
      commentId,
      itemId
    });

  } catch (err) {
    error('Webhook-Handler', 'Failed to handle comment.updated', { 
      commentId: payload?.id,
      itemId: payload?.item_id,
      error: err.message 
    });
    throw err;
  }
}


async function handleItemFinalized(payload) {
  try {
    const itemId = mongoEq(payload.id);
    const boardId = mongoEqOrNull(payload.board_id);
    const workspaceId = mongoEqOrNull(payload.workspace_id);
    
    info('Webhook-Handler', 'Processing item.finalized event', { 
      itemId,
      boardId
    });

    const itemResult = await fetchOrCreateItem(itemId, boardId, workspaceId);
    if (!itemResult) {
      warn('Webhook-Handler', 'Could not fetch or create item', { itemId });
      return;
    }

    if (itemResult.deleted) {
      info('Webhook-Handler', 'Item was deleted in ISO+, skipping finalization', { 
        itemId, 
        boardId
      });
      return;
    }

    const { boardId: foundBoardId, currentSyncGUID } = itemResult;

    const board = await Board.findOne({ boardId: mongoEq(foundBoardId), syncData: true })
      .select('currentSyncGUID')
      .lean();
    if (!board) {
      info('Webhook-Handler', 'Board not found or sync not enabled', { boardId: foundBoardId });
      return;
    }

    const syncGUID = null;

    const transformedData = transformItemData(payload);

    await Item.findOneAndUpdate(
      { itemId: mongoEq(itemId) },
      {
        $set: {
          data: transformedData,
          syncGUID: syncGUID,
          updatedAt: new Date()
        }
      },
      { new: true }
    );

    info('Webhook-Handler', 'Item finalized successfully', { 
      itemId, 
      boardId: foundBoardId,
      syncGUID
    });

  } catch (err) {
    error('Webhook-Handler', 'Failed to handle item.finalized', { 
      itemId: payload?.id,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

async function handleItemUpdated(payload) {
  try {
    const itemId = mongoEq(payload.id);
    const boardId = mongoEqOrNull(payload.board_id);
    const workspaceId = mongoEqOrNull(payload.workspace_id);
    
    info('Webhook-Handler', 'Processing item.updated event', { 
      itemId,
      boardId,
      workspaceId
    });

    const itemResult = await fetchOrCreateItem(itemId, boardId, workspaceId);
    if (!itemResult) {
      warn('Webhook-Handler', 'Item not found for item update and could not be fetched', { 
        itemId
      });
      return;
    }

    if (itemResult.deleted) {
      info('Webhook-Handler', 'Item was deleted in ISO+, skipping item update', { 
        itemId
      });
      return;
    }

    const { boardId: foundBoardId, workspaceId: foundWorkspaceId, currentSyncGUID } = itemResult;
    if (!foundBoardId) {
      warn('Webhook-Handler', 'No boardId found on item', { itemId });
      return;
    }

    const board = await Board.findOne({ boardId: mongoEq(foundBoardId), syncData: true })
      .select('currentSyncGUID')
      .lean();
    if (!board) {
      info('Webhook-Handler', 'Board not found or sync not enabled', { boardId: foundBoardId });
      return;
    }

    const fullItemData = await getItemValues(foundWorkspaceId, foundBoardId, itemId);
    
    if (fullItemData === ITEM_DELETED) {
      info('Webhook-Handler', 'Item was deleted in ISO+ during refresh, deleting local copy', { 
        itemId
      });
      await deleteItemFromDatabase(itemId);
      return;
    }
    
    if (!fullItemData) {
      warn('Webhook-Handler', 'Failed to fetch item data for update', { itemId });
      return;
    }

    const transformedData = transformItemData(fullItemData);
    const syncGUID = null;
    
    await Item.findOneAndUpdate(
      { itemId: mongoEq(itemId) },
      {
        $set: {
          data: transformedData,
          syncGUID: syncGUID,
          updatedAt: new Date()
        }
      }
    );
    
    info('Webhook-Handler', 'Item updated successfully', { 
      itemId, 
      boardId: foundBoardId,
      syncGUID
    });

    await updateReferencingItems(itemId, foundWorkspaceId, foundBoardId);

  } catch (err) {
    error('Webhook-Handler', 'Failed to handle item.updated', { 
      itemId: payload?.id,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}


function checkIfItemReferences(itemData, referencedIdStr) {
  return itemDataReferencesId(itemData, referencedIdStr);
}

async function handleItemDeleted(payload) {
  try {
    const itemId = mongoEq(payload.id);
    if (!itemId) {
      warn('Webhook-Handler', 'No item id in item.deleted payload');
      return;
    }
    
    info('Webhook-Handler', 'Processing item.deleted event', { 
      itemId,
    });

    let boardId = mongoEqOrNull(payload.board_id);

    if (!boardId) {
      const item = await Item.findOne({ itemId })
        .select('boardId')
        .lean();
      if (item) {
        boardId = mongoEq(item.boardId);
      }
    }

    if (!boardId) {
      warn('Webhook-Handler', 'No board_id in item.deleted payload and item not found', { itemId });
      return;
    }

    const board = await Board.findOne({ boardId, syncData: true });
    if (!board) {
      info('Webhook-Handler', 'Board not found or sync not enabled', { boardId });
      return;
    }

    const result = await Item.findOneAndDelete({ itemId });

    if (result) {
      await Board.findOneAndUpdate(
        { boardId },
        { 
          $inc: { 
            'syncStats.itemsSynced': -1
          }
        }
      );

      info('Webhook-Handler', 'Item deleted successfully', { 
        itemId, 
        boardId 
      });
    } else {
      info('Webhook-Handler', 'Item not found for deletion (already deleted or never existed)', { 
        itemId, 
        boardId 
      });
    }

  } catch (err) {
    error('Webhook-Handler', 'Failed to handle item.deleted', { 
      itemId: payload?.id,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

export default router;
