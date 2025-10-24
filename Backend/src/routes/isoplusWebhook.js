import express from 'express';
import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { info, error, warn, extractContextFromReq } from '../utils/logger.js';

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
      
      case 'item.deleted':
        await handleItemDeleted(payload);
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

async function handleItemUpdated(payload) {
  try {
    const itemId = payload.id;
    
    info('Webhook-Handler', 'Processing item.updated event', { 
      itemId 
    });

    const boardId = payload.board_id;

    if (!boardId) {
      warn('Webhook-Handler', 'No board_id in item.updated payload', { itemId });
      return;
    }

    // Check if board has sync enabled
    const board = await Board.findOne({ boardId: boardId, syncData: true });
    if (!board) {
      info('Webhook-Handler', 'Board not found or sync not enabled', { boardId });
      return;
    }

    // Update item in database
    const result = await Item.findOneAndUpdate(
      { itemId: itemId },
      {
        $set: {
          data: payload,
          updatedAt: new Date()
        }
      },
      { new: true }
    );

    if (result) {
      info('Webhook-Handler', 'Item updated successfully', { 
        itemId, 
        boardId 
      });
    } else {
      warn('Webhook-Handler', 'Item not found for update', { itemId });
    }

  } catch (err) {
    error('Webhook-Handler', 'Failed to handle item.updated', { 
      itemId: payload?.id,
      error: err.message 
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
    info('Webhook-Handler', 'Processing value.updated event', { 
      valueId: payload.id,
      attributeId: payload.attribute_id
    });

    // Similar to value.created, acknowledge the event
    info('Webhook-Handler', 'Value updated acknowledged', { 
      valueId: payload.id 
    });

  } catch (err) {
    error('Webhook-Handler', 'Failed to handle value.updated', { 
      valueId: payload?.id,
      error: err.message 
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

    const boardId = payload.board_id;

    if (!boardId) {
      warn('Webhook-Handler', 'No board_id in item.deleted payload', { itemId });
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
      warn('Webhook-Handler', 'Item not found for deletion', { 
        itemId, 
        boardId 
      });
    }

  } catch (err) {
    error('Webhook-Handler', 'Failed to handle item.deleted', { 
      itemId: payload?.id,
      error: err.message 
    });
    throw err;
  }
}

export default router;
