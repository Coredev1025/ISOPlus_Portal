import express from 'express';
import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { info, error, warn, extractContextFromReq } from '../utils/logger.js';
import { getItemValues } from '../services/isoplus.js';

const router = express.Router();

router.post('/isoplus', async (req, res) => {
  try {
    const { event, payload } = req.body;
    
    info('Webhook-Handler', 'Received hook event', { 
      event, 
      payloadObject: payload?.object,
      payloadId: payload?.id
    }, extractContextFromReq(req));

    // Validate hook payload
    if (!event || !payload) {
      warn('Webhook-Handler', 'Invalid hook payload', { 
        body: req.body 
      }, extractContextFromReq(req));
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid hook payload' 
      });
    }

    switch (event) {
      case 'item.updated':
        await handleItemUpdated(payload);
        break;
      
      case 'item.finalized':
        await handleItemFinalized(payload);
        break;
      
      case 'item.deleted':
        await handleItemDeleted(payload);
        break;
      
      case 'value.updated':
        await handleValueUpdated(payload);
        break;
      
      default:
        info('Webhook-Handler', 'Ignoring hook event type', { 
          event
        }, extractContextFromReq(req));
        // Return success for unhandled events to avoid hook deactivation
        return res.status(200).json({ 
          success: true, 
          message: 'Event acknowledged' 
        });
    }

    // Respond with success
    info('Webhook-Handler', 'Hook processed successfully', { 
      event, 
      payloadId: payload?.id 
    }, extractContextFromReq(req));

    res.status(200).json({ 
      success: true, 
      message: 'Hook processed successfully' 
    });

  } catch (err) {
    error('Webhook-Handler', 'Failed to process hook', { 
      error: err.message,
      stack: err.stack 
    }, extractContextFromReq(req));
    
    // Return 200 to avoid hook deactivation on errors
    res.status(200).json({ 
      success: false, 
      message: 'Failed to process hook',
      error: err.message 
    });
  }
});

/**
 * Helper function to fetch and create an item if it doesn't exist
 * Returns the item and board info, or null if not found
 */
async function fetchOrCreateItem(itemId, boardId = null, workspaceId = null) {
  // First check if item exists in database
  let item = await Item.findOne({ itemId: itemId })
    .select('boardId workspaceId')
    .lean();
  if (item) {
    return { item, boardId: item.boardId, workspaceId: item.workspaceId };
  }

  // Item doesn't exist, need to fetch from API
  let itemData = null;
  let foundBoardId = boardId;
  let foundWorkspaceId = workspaceId;

  // If we don't have boardId/workspaceId, search through all boards with sync enabled
  if (!foundBoardId || !foundWorkspaceId) {
    const boards = await Board.find({ syncData: true })
      .select('workspaceId boardId')
      .lean();
    
    for (const board of boards) {
      if (board.workspaceId && board.boardId) {
        try {
          itemData = await getItemValues(board.workspaceId, board.boardId, itemId);
          if (itemData) {
            foundBoardId = board.boardId;
            foundWorkspaceId = board.workspaceId;
            break;
          }
        } catch (err) {
          // Continue to next board if this one fails
          continue;
        }
      }
    }
  } else {
    // We have boardId and workspaceId, try to fetch directly
    try {
      itemData = await getItemValues(foundWorkspaceId, foundBoardId, itemId);
    } catch (err) {
      warn('Webhook-Handler', 'Failed to fetch item from API', { 
        itemId, 
        boardId: foundBoardId,
        workspaceId: foundWorkspaceId,
        error: err.message 
      });
    }
  }

  if (!itemData) {
    warn('Webhook-Handler', 'Item not found in database or API', { 
      itemId,
      boardId: foundBoardId
    });
    return null;
  }

  // Create new item from fetched data
  const folderId = itemData.folder_id || itemData.folder?.id;
  if (!folderId) {
    warn('Webhook-Handler', 'No folder_id in fetched item data', { 
      itemId
    });
    return null;
  }

  // Use findOneAndUpdate with upsert to atomically create or update
  // This prevents duplicate key errors from race conditions
  const now = new Date();
  try {
    item = await Item.findOneAndUpdate(
      { itemId: itemId },
      {
        $set: {
          workspaceId: foundWorkspaceId,
          boardId: foundBoardId,
          folderId: folderId.toString(),
          itemId: itemId,
          isoPlusItemId: itemId,
          data: itemData,
          updatedAt: now
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err?.code === 11000) {
      // Another process inserted the item concurrently; fetch the existing record
      item = await Item.findOne({ itemId }).lean();
      if (!item) {
        throw err;
      }
      info('Webhook-Handler', 'Item already existed, reused existing record after duplicate key', {
        itemId,
        boardId: item.boardId,
        workspaceId: item.workspaceId
      });
    } else {
      throw err;
    }
  }

  info('Webhook-Handler', 'Created or updated item from API', { 
    itemId, 
    boardId: foundBoardId, 
    workspaceId: foundWorkspaceId, 
    folderId 
  });

  return { item, boardId: foundBoardId, workspaceId: foundWorkspaceId };
}

async function handleItemUpdated(payload) {
  try {
    const itemId = payload.id;
    const boardId = payload.board_id;
    const workspaceId = payload.workspace_id;
    
    info('Webhook-Handler', 'Processing item.updated event', { 
      itemId,
      boardId
    });

    // Fetch or create item if it doesn't exist
    const itemResult = await fetchOrCreateItem(itemId, boardId, workspaceId);
    if (!itemResult) {
      warn('Webhook-Handler', 'Could not fetch or create item', { itemId });
      return;
    }

    const { item, boardId: foundBoardId } = itemResult;

    // Check if board has sync enabled
    const board = await Board.findOne({ boardId: foundBoardId, syncData: true });
    if (!board) {
      info('Webhook-Handler', 'Board not found or sync not enabled', { boardId: foundBoardId });
      return;
    }

    // Update item in database with payload data
    item.data = payload;
    item.updatedAt = new Date();
    await item.save();

    info('Webhook-Handler', 'Item updated successfully', { 
      itemId, 
      boardId: foundBoardId 
    });

  } catch (err) {
    error('Webhook-Handler', 'Failed to handle item.updated', { 
      itemId: payload?.id,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

async function handleValueCreated(payload) {
  try {
    info('Webhook-Handler', 'Processing value.created event', { 
      valueId: payload.id,
      attributeId: payload.attribute_id
    });

    info('Webhook-Handler', 'Value created acknowledged', { 
      valueId: payload.id 
    });

  } catch (err) {
    error('Webhook-Handler', 'Failed to handle value.created', { 
      valueId: payload?.id,
      error: err.message 
    });
    throw err;
  }
}

async function handleValueUpdated(payload) {
  try {
    const valueId = payload.id;
    const itemId = payload.item_id;
    const attributeId = payload.attribute_id;
    const isDeleted = payload.deleted === true;
    
    info('Webhook-Handler', 'Processing value.updated event', { 
      valueId,
      itemId,
      attributeId,
      isDeleted
    });

    if (!itemId) {
      warn('Webhook-Handler', 'No item_id in value.updated payload', { valueId });
      return;
    }

    // Fetch or create item if it doesn't exist
    const itemResult = await fetchOrCreateItem(itemId);
    if (!itemResult) {
      warn('Webhook-Handler', 'Item not found for value update and could not be fetched', { 
        itemId, 
        valueId
      });
      return;
    }

    const { item, boardId } = itemResult;
    if (!boardId) {
      warn('Webhook-Handler', 'No boardId found on item', { itemId, valueId });
      return;
    }

    // Check if board has sync enabled
    const board = await Board.findOne({ boardId: boardId, syncData: true });
    if (!board) {
      info('Webhook-Handler', 'Board not found or sync not enabled', { boardId });
      return;
    }

    // Ensure item.data exists
    if (!item.data) {
      item.data = {};
    }
    if (!item.data.values) {
      item.data.values = [];
    }

    // Find the value in the item's data.values array
    const values = item.data.values;
    const valueIndex = values.findIndex(v => 
      v?.id === valueId || v?.attribute?.id === attributeId
    );

    if (isDeleted) {
      // Remove the value if it's marked as deleted
      if (valueIndex !== -1) {
        values.splice(valueIndex, 1);
        item.data.values = values;
        info('Webhook-Handler', 'Value removed from item', { 
          itemId, 
          valueId, 
          attributeId 
        });
      } else {
        info('Webhook-Handler', 'Value not found for deletion', { 
          itemId, 
          valueId, 
          attributeId 
        });
      }
    } else if (valueIndex === -1) {
      // Value doesn't exist, add it
      // We need to preserve the attribute structure from existing values if possible
      // or create a minimal structure
      const existingAttribute = values.find(v => v?.attribute?.id === attributeId)?.attribute;
      
      const newValue = {
        id: valueId,
        attribute: existingAttribute || {
          id: attributeId
        },
        data: payload.data
      };
      
      values.push(newValue);
      item.data.values = values;
      
      info('Webhook-Handler', 'Value added to item (was missing)', { 
        itemId, 
        valueId, 
        attributeId 
      });
    } else {
      // Update existing value
      const existingValue = values[valueIndex];
      values[valueIndex] = {
        ...existingValue,
        data: payload.data,
        // Preserve existing attribute structure
        attribute: existingValue.attribute || { id: attributeId }
      };
      
      item.data.values = values;
      
      info('Webhook-Handler', 'Value updated in item', { 
        itemId, 
        valueId, 
        attributeId 
      });
    }

    // Save the updated item
    item.updatedAt = new Date();
    await item.save();

    info('Webhook-Handler', 'Value updated successfully', { 
      itemId, 
      valueId, 
      boardId, 
      attributeId,
      isDeleted
    });

  } catch (err) {
    error('Webhook-Handler', 'Failed to handle value.updated', { 
      valueId: payload?.id,
      itemId: payload?.item_id,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

async function handleItemFinalized(payload) {
  try {
    const itemId = payload.id;
    const boardId = payload.board_id;
    const workspaceId = payload.workspace_id;
    
    info('Webhook-Handler', 'Processing item.finalized event', { 
      itemId,
      boardId
    });

    // Fetch or create item if it doesn't exist
    const itemResult = await fetchOrCreateItem(itemId, boardId, workspaceId);
    if (!itemResult) {
      warn('Webhook-Handler', 'Could not fetch or create item', { itemId });
      return;
    }

    const { item, boardId: foundBoardId } = itemResult;

    // Check if board has sync enabled
    const board = await Board.findOne({ boardId: foundBoardId, syncData: true });
    if (!board) {
      info('Webhook-Handler', 'Board not found or sync not enabled', { boardId: foundBoardId });
      return;
    }

    // Update item in database with payload data
    item.data = payload;
    item.updatedAt = new Date();
    await item.save();

    info('Webhook-Handler', 'Item finalized successfully', { 
      itemId, 
      boardId: foundBoardId 
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

async function handleItemDeleted(payload) {
  try {
    const itemId = payload.id;
    
    info('Webhook-Handler', 'Processing item.deleted event', { 
      itemId: itemId
    });

    // Try to get boardId from payload first
    let boardId = payload.board_id;

    // If not in payload, try to get from existing item
    if (!boardId) {
      const item = await Item.findOne({ itemId: itemId })
        .select('boardId')
        .lean();
      if (item) {
        boardId = item.boardId;
      }
    }

    if (!boardId) {
      warn('Webhook-Handler', 'No board_id in item.deleted payload and item not found', { itemId });
      return;
    }

    const board = await Board.findOne({ boardId: boardId, syncData: true });
    if (!board) {
      info('Webhook-Handler', 'Board not found or sync not enabled', { boardId });
      return;
    }

    const result = await Item.findOneAndDelete({ itemId: itemId });

    if (result) {
      await Board.findOneAndUpdate(
        { boardId: boardId },
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
