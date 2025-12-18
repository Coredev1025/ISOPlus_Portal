import express from 'express';
import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { info, error, warn, extractContextFromReq } from '../utils/logger.js';
import { getItemValues, ITEM_DELETED } from '../services/isoplus.js';
import { transformItemData, transformValue } from '../utils/itemTransform.js';

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
      case 'item.created':
        await handleItemCreated(payload);
        break;
      
      case 'item.updated':
        await handleValueUpdated(payload);
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

async function getBoardSyncGUID(boardId) {
  const board = await Board.findOne({ boardId })
    .select('currentSyncGUID')
    .lean();
  return board?.currentSyncGUID || null;
}

async function deleteItemFromDatabase(itemId) {
  const item = await Item.findOne({ itemId: itemId })
    .select('boardId workspaceId')
    .lean();
  
  if (!item) {
    info('Webhook-Handler', 'Item not in database, nothing to delete', { itemId });
    return null;
  }

  await Item.findOneAndDelete({ itemId: itemId });
  
  await Board.findOneAndUpdate(
    { boardId: item.boardId },
    { 
      $inc: { 
        'syncStats.itemsSynced': -1
      }
    }
  );

  info('Webhook-Handler', 'Item deleted from database (confirmed deleted in ISO+)', { 
    itemId, 
    boardId: item.boardId 
  });
  
  return { deleted: true, itemId, boardId: item.boardId, workspaceId: item.workspaceId };
}

async function fetchOrCreateItem(itemId, boardId = null, workspaceId = null) {
  // First check if item exists in database
  let item = await Item.findOne({ itemId: itemId })
    .select('boardId workspaceId syncGUID')
    .lean();
  if (item) {
    const currentSyncGUID = await getBoardSyncGUID(item.boardId);
    return { item, boardId: item.boardId, workspaceId: item.workspaceId, currentSyncGUID };
  }

  // Item doesn't exist, need to fetch from API
  let itemData = null;
  let foundBoardId = boardId;
  let foundWorkspaceId = workspaceId;
  let currentSyncGUID = null;
  let itemDeletedInIsoPlus = false;

  // If we don't have boardId/workspaceId, search through all boards with sync enabled
  if (!foundBoardId || !foundWorkspaceId) {
    const boards = await Board.find({ syncData: true })
      .select('workspaceId boardId currentSyncGUID')
      .lean();
    
    for (const board of boards) {
      if (board.workspaceId && board.boardId) {
        try {
          itemData = await getItemValues(board.workspaceId, board.boardId, itemId);
          
          if (itemData === ITEM_DELETED) {
            itemDeletedInIsoPlus = true;
            foundBoardId = board.boardId;
            foundWorkspaceId = board.workspaceId;
            break;
          }
          
          if (itemData) {
            foundBoardId = board.boardId;
            foundWorkspaceId = board.workspaceId;
            currentSyncGUID = board.currentSyncGUID;
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
      
      if (itemData === ITEM_DELETED) {
        itemDeletedInIsoPlus = true;
      } else {
        currentSyncGUID = await getBoardSyncGUID(foundBoardId);
      }
    } catch (err) {
      warn('Webhook-Handler', 'Failed to fetch item from API', { 
        itemId, 
        boardId: foundBoardId,
        workspaceId: foundWorkspaceId,
        error: err.message 
      });
    }
  }

  if (itemDeletedInIsoPlus) {
    info('Webhook-Handler', 'Item deleted in ISO+ (404), deleting local copy', { 
      itemId,
      boardId: foundBoardId
    });
    const deleteResult = await deleteItemFromDatabase(itemId);
    return deleteResult ? { deleted: true, ...deleteResult } : { deleted: true, itemId };
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

  const transformedData = transformItemData(itemData);

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
          syncGUID: currentSyncGUID,
          data: transformedData,
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
    folderId,
    syncGUID: currentSyncGUID
  });

  return { item, boardId: foundBoardId, workspaceId: foundWorkspaceId, currentSyncGUID };
}

async function handleItemCreated(payload) {
  try {
    const itemId = payload.id;
    const boardId = payload.board_id;
    const workspaceId = payload.workspace_id;
    
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
    const valueId = payload.id;
    const itemId = payload.item_id;
    const attributeId = payload.attribute_id;
    
    info('Webhook-Handler', 'Processing value.created event', { 
      valueId,
      itemId,
      attributeId
    });

    if (!itemId) {
      warn('Webhook-Handler', 'No item_id in value.created payload', { valueId });
      return;
    }

    const itemResult = await fetchOrCreateItem(itemId);
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

    const board = await Board.findOne({ boardId: boardId, syncData: true }).lean();
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
        { itemId: itemId },
        {
          $set: {
            data: transformedData,
            syncGUID: null,
            updatedAt: new Date()
          }
        }
      );
      
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

async function handleValueUpdated(payload) {
  try {
    const valueId = payload.id;
    const itemId = payload.item_id;
    const attributeId = payload.attribute_id;
    const attributeName = payload.attribute?.name; // May be present in webhook payload
    const isDeleted = payload.deleted === true;
    
    info('Webhook-Handler', 'Processing value.updated event', { 
      valueId,
      itemId,
      attributeId,
      attributeName,
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

    if (itemResult.deleted) {
      info('Webhook-Handler', 'Item was deleted in ISO+, skipping value update', { 
        itemId, 
        valueId
      });
      return;
    }

    const { boardId, workspaceId, currentSyncGUID } = itemResult;
    if (!boardId) {
      warn('Webhook-Handler', 'No boardId found on item', { itemId, valueId });
      return;
    }

    // Check if board has sync enabled
    const board = await Board.findOne({ boardId: boardId, syncData: true })
      .select('currentSyncGUID')
      .lean();
    if (!board) {
      info('Webhook-Handler', 'Board not found or sync not enabled', { boardId });
      return;
    }

    const syncGUID = null;

    let updateSuccessful = false;
    try {
      const fullItemData = await getItemValues(workspaceId, boardId, itemId);
      
      if (fullItemData === ITEM_DELETED) {
        info('Webhook-Handler', 'Item was deleted in ISO+ during refresh, deleting local copy', { 
          itemId, 
          valueId
        });
        await deleteItemFromDatabase(itemId);
        return;
      }
      
      if (fullItemData) {
        const transformedData = transformItemData(fullItemData);
        
        await Item.findOneAndUpdate(
          { itemId: itemId },
          {
            $set: {
              data: transformedData,
              syncGUID: syncGUID,
              updatedAt: new Date()
            }
          }
        );
        
        info('Webhook-Handler', 'Item data refreshed and transformed', { 
          itemId, 
          valueId, 
          attributeId,
          attributeName: attributeName || 'fetched from API',
          syncGUID
        });
        updateSuccessful = true;
      } else {
        if (attributeName) {
          let transformedValue;
          if (isDeleted) {
            transformedValue = null;
          } else {
            const attributeType = payload.attribute?.type;
            if (attributeType === 'label' && !payload.attribute?.settings?.labels) {
              warn('Webhook-Handler', 'Incomplete label metadata in webhook payload, storing raw data', {
                itemId,
                attributeName,
                attributeType
              });
              transformedValue = payload.data;
            } else {
              transformedValue = transformValue(payload);
            }
          }
          
          const updateObj = {};
          updateObj[`data.${attributeName}`] = transformedValue;
          updateObj.syncGUID = syncGUID; // Update syncGUID for GUID tracking
          updateObj.updatedAt = new Date();
          
          await Item.findOneAndUpdate(
            { itemId: itemId },
            { $set: updateObj }
          );
          
          info('Webhook-Handler', 'Value updated by attribute name (with transformation)', { 
            itemId, 
            valueId, 
            attributeName,
            attributeType: payload.attribute?.type,
            syncGUID
          });
          updateSuccessful = true;
        } else {
          warn('Webhook-Handler', 'Cannot update value - no attribute name and failed to fetch item', { 
            itemId, 
            valueId, 
            attributeId 
          });
        }
      }
    } catch (fetchErr) {
      warn('Webhook-Handler', 'Failed to fetch full item data, skipping update', {
        itemId,
        valueId,
        error: fetchErr.message
      });
    }

    if (updateSuccessful) {
      info('Webhook-Handler', 'Value updated successfully', { 
        itemId, 
        valueId, 
        boardId, 
        attributeId,
        isDeleted,
        syncGUID
      });
    }

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

    if (itemResult.deleted) {
      info('Webhook-Handler', 'Item was deleted in ISO+, skipping finalization', { 
        itemId, 
        boardId
      });
      return;
    }

    const { boardId: foundBoardId, currentSyncGUID } = itemResult;

    // Check if board has sync enabled
    const board = await Board.findOne({ boardId: foundBoardId, syncData: true })
      .select('currentSyncGUID')
      .lean();
    if (!board) {
      info('Webhook-Handler', 'Board not found or sync not enabled', { boardId: foundBoardId });
      return;
    }

    const syncGUID = null;

    const transformedData = transformItemData(payload);

    await Item.findOneAndUpdate(
      { itemId: itemId },
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
