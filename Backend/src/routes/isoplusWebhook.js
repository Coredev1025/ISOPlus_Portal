import express from 'express';
import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { info, error, warn } from '../utils/logger.js';
import { getItemValues, ITEM_DELETED } from '../services/isoplus.js';
import { transformItemData, transformValue } from '../utils/itemTransform.js';
import { syncTimeTrackingFromItem } from '../utils/timeTrackSync.js';

const router = express.Router();

router.post('/isoplus', async (req, res) => {
  try {
    const { event, payload } = req.body;
    
    info('Webhook-Handler', 'Received hook event', { 
      event, 
      payloadObject: payload?.object,
      payloadId: payload?.id
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
  let item = await Item.findOne({ itemId: itemId })
    .select('boardId workspaceId syncGUID')
    .lean();
  if (item) {
    const currentSyncGUID = await getBoardSyncGUID(item.boardId);
    return { item, boardId: item.boardId, workspaceId: item.workspaceId, currentSyncGUID };
  }

  let itemData = null;
  let foundBoardId = boardId;
  let foundWorkspaceId = workspaceId;
  let currentSyncGUID = null;
  let itemDeletedInIsoPlus = false;

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
          continue;
        }
      }
    }
  } else {
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

  const rawFolderId = itemData.folder_id || itemData.folder?.id;
  const folderId = rawFolderId != null && rawFolderId !== '' ? String(rawFolderId) : '';
  if (!folderId) {
    info('Webhook-Handler', 'Item has no folder_id; storing empty folderId (aligned with sync worker)', {
      itemId,
      boardId: foundBoardId
    });
  }

  const transformedData = transformItemData(itemData);

  const now = new Date();
  try {
    item = await Item.findOneAndUpdate(
      { itemId: itemId },
      {
        $set: {
          workspaceId: foundWorkspaceId,
          boardId: foundBoardId,
          folderId,
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
      
      const boardMeta = await Board.findOne({ boardId: itemResult.boardId })
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

async function handleValueUpdated(payload) {
  try {
    const valueId = payload.id;
    const itemId = payload.item_id;
    const attributeId = payload.attribute_id;
    const attributeName = payload.attribute?.name;
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

        syncTimeTrackingFromItem(workspaceId, boardId, itemId, transformedData)
          .catch(ttErr => warn('Webhook-Handler', 'TT sync failed after value.updated', { itemId, error: ttErr.message }));
        
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
          updateObj.syncGUID = syncGUID;
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

      const attributeType = payload.attribute?.type;
      if (attributeType === 'reference' || attributeType === 'members') {
        await updateReferencingItems(itemId, workspaceId, boardId);
      }
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

async function handleItemUpdated(payload) {
  try {
    const itemId = payload.id;
    const boardId = payload.board_id;
    const workspaceId = payload.workspace_id;
    
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

    const board = await Board.findOne({ boardId: foundBoardId, syncData: true })
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
      { itemId: itemId },
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

async function updateReferencingItems(referencedItemId, workspaceId, boardId) {
  try {
    const referencedIdStr = referencedItemId.toString();
    
    const boards = await Board.find({ 
      workspaceId: workspaceId,
      syncData: true 
    })
      .select('boardId')
      .lean();

    if (boards.length === 0) {
      return;
    }

    const boardIds = boards.map(b => b.boardId);
    
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

        if (items.length === 0) {
          break;
        }

        for (const item of items) {
          try {
            const referencesItem = checkIfItemReferences(item.data, referencedIdStr);
            
            if (referencesItem) {
              const itemBoard = await Board.findOne({ 
                boardId: item.boardId, 
                syncData: true 
              }).lean();
              
              if (!itemBoard) {
                continue;
              }

              const fullItemData = await getItemValues(item.workspaceId, item.boardId, item.itemId);
              
              if (fullItemData === ITEM_DELETED) {
                continue;
              }
              
              if (fullItemData) {
                const transformedData = transformItemData(fullItemData);
                
                await Item.findOneAndUpdate(
                  { itemId: item.itemId },
                  {
                    $set: {
                      data: transformedData,
                      syncGUID: null,
                      updatedAt: new Date()
                    }
                  }
                );
                
                updatedCount++;
                
                info('Webhook-Handler', 'Updated referencing item', {
                  itemId: item.itemId,
                  referencedItemId,
                  boardId: item.boardId
                });
              }
            }
          } catch (itemErr) {
            warn('Webhook-Handler', 'Failed to check/update referencing item', {
              itemId: item.itemId,
              referencedItemId,
              error: itemErr.message
            });
          }
        }

        processedCount += items.length;
        
        if (items.length < batchSize) {
          break;
        }
        
        skip += batchSize;
      }
    }

    if (updatedCount > 0) {
      info('Webhook-Handler', 'Finished updating referencing items', {
        referencedItemId,
        processedCount,
        updatedCount
      });
    }

  } catch (err) {
    warn('Webhook-Handler', 'Failed to update referencing items', {
      referencedItemId,
      error: err.message
    });
  }
}

function checkIfItemReferences(itemData, referencedIdStr) {
  if (!itemData || typeof itemData !== 'object') {
    return false;
  }

  for (const [key, value] of Object.entries(itemData)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === 'string' && value === referencedIdStr) {
      return true;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item === referencedIdStr) {
          return true;
        }
        if (typeof item === 'object' && item !== null && item.id === referencedIdStr) {
          return true;
        }
      }
    }

    if (typeof value === 'object' && value !== null && value.id === referencedIdStr) {
      return true;
    }
  }

  return false;
}

async function handleItemDeleted(payload) {
  try {
    const itemId = payload.id;
    
    info('Webhook-Handler', 'Processing item.deleted event', { 
      itemId: itemId
    });

    let boardId = payload.board_id;

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
