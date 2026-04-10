import mongoose from 'mongoose';

const boardSchema = new mongoose.Schema({
  boardId: {
    type: String,
    ref: 'Board',
    required: true
  },
  name: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  color: {
    type: String,
  },
  og_image: {
    type: String,
  },
  label: {
    type: String,
    default: 'No Label'
  },
  attribute: {
    id: {
      type: String,
      ref: 'Attribute Id',
      required: false
    },
    name: {
      type: String,
      ref: 'Attribute Name',
      required: false
    }
  },
  pdfAttribute: {
    id: {
      type: String,
      ref: 'PDF Attribute Id',
      required: false
    },
    name: {
      type: String,
      ref: 'PDF Attribute Name',
      required: false
    }
  },
  syncData: {
    type: Boolean,
    default: false
  },
  syncStatus: {
    type: String,
    enum: [
      'disabled',              // Sync not enabled
      'sync_enabled',          // User enabled sync, waiting for validation
      'board_validation',      // Validating board structure
      'board_valid',          // Board validated, ready for sync
      'board_invalid',        // Board validation failed
      'data_backlog_sync',    // Initial sync of all data
      'realtime_sync',        // Listening to webhooks for real-time updates
      'manual_triggered_sync', // Manual re-sync triggered
      'sync_stopped',         // Sync stopped
      'sync_cancelled',       // Sync cancelled
      'failed'                // Sync failed
    ],
    default: 'disabled'
  },
  syncJobId: {
    type: String,
    default: null
  },
  lastSyncedAt: {
    type: Date,
    default: null
  },
  lastSyncError: {
    type: String,
    default: null
  },
  validationErrors: {
    type: [String],
    default: []
  },
  syncStats: {
    foldersProcessed: {
      type: Number,
      default: 0
    },
    itemsSynced: {
      type: Number,
      default: 0
    },
    itemsCreated: {
      type: Number,
      default: 0
    },
    itemsUpdated: {
      type: Number,
      default: 0
    },
    lastBacklogSyncAt: {
      type: Date,
      default: null
    },
    retryCount: {
      type: Number,
      default: 0
    }
  },
  hookId: {
    type: String,
    default: null
  },
  hookSecret: {
    type: String,
    default: null
  },
  workspaceId: {
    type: String,
    default: null
  },
  currentSyncGUID: {
    type: String,
    default: null
  },
  timeTrackStartAttributeId: {
    type: String,
    default: null
  },
  timeTrackEndAttributeId: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

boardSchema.index({ boardId: 1 });
boardSchema.index({ workspaceId: 1 });
boardSchema.index({ workspaceId: 1, boardId: 1 });

export default mongoose.model('Board', boardSchema);