import mongoose from 'mongoose';

const syncExecutionSchema = new mongoose.Schema({
  syncGUID: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  boardId: {
    type: String,
    required: true,
    index: true
  },
  
  workspaceId: {
    type: String,
    required: true
  },

  syncType: {
    type: String,
    required: true,
    enum: ['data_backlog_sync', 'manual_triggered_sync', 'realtime_sync', 'board_validation']
  },
  
  status: {
    type: String,
    required: true,
    enum: ['started', 'in-progress', 'completed', 'failed', 'timeout'],
    default: 'started'
  },
  
  triggeredBy: {
    type: String,
    default: 'system'
  },
  
  jobId: {
    type: String,
    default: null
  },
  
  startTime: {
    type: Date,
    required: true,
    default: Date.now
  },
  
  endTime: {
    type: Date,
    default: null
  },
  
  duration: {
    type: Number,
    default: null
  },
  
  progress: {
    currentPage: {
      type: Number,
      default: 0
    },
    totalPages: {
      type: Number,
      default: 0
    },
    currentFolder: {
      type: String,
      default: null
    },
    foldersProcessed: {
      type: Number,
      default: 0
    },
    totalFolders: {
      type: Number,
      default: 0
    }
  },
  
  counters: {
    itemsProcessed: {
      type: Number,
      default: 0
    },
    itemsInserted: {
      type: Number,
      default: 0
    },
    itemsUpdated: {
      type: Number,
      default: 0
    },
    itemsDeleted: {
      type: Number,
      default: 0
    },
    itemsFailed: {
      type: Number,
      default: 0
    }
  },
  
  lastUpdatedAt: {
    type: Date,
    default: null
  },
  
  lastUpdatedItem: {
    type: String,
    default: null
  },
  
  error: {
    message: {
      type: String,
      default: null
    },
    stack: {
      type: String,
      default: null
    },
    details: {
      type: Object,
      default: null
    }
  },
  
  retryCount: {
    type: Number,
    default: 0
  },
  
  lastSyncedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

syncExecutionSchema.index({ boardId: 1, createdAt: -1 });

syncExecutionSchema.index({ status: 1, startTime: 1 });

syncExecutionSchema.index(
  { createdAt: 1 }, 
  { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { status: 'completed' } }
);

syncExecutionSchema.statics.createSyncExecution = async function(data) {
  const syncExecution = new this({
    syncGUID: data.syncGUID,
    boardId: data.boardId,
    workspaceId: data.workspaceId,
    syncType: data.syncType,
    triggeredBy: data.triggeredBy || 'system',
    jobId: data.jobId,
    status: 'started',
    startTime: new Date()
  });
  
  return syncExecution.save();
};

syncExecutionSchema.statics.updateProgress = async function(syncGUID, progress, counters = {}) {
  return this.findOneAndUpdate(
    { syncGUID },
    {
      $set: {
        status: 'in-progress',
        progress,
        lastUpdatedAt: new Date(),
        ...(counters.itemsProcessed !== undefined && { 'counters.itemsProcessed': counters.itemsProcessed }),
        ...(counters.itemsInserted !== undefined && { 'counters.itemsInserted': counters.itemsInserted }),
        ...(counters.itemsUpdated !== undefined && { 'counters.itemsUpdated': counters.itemsUpdated }),
        ...(counters.itemsFailed !== undefined && { 'counters.itemsFailed': counters.itemsFailed }),
        ...(counters.lastUpdatedItem && { lastUpdatedItem: counters.lastUpdatedItem })
      }
    },
    { new: true }
  );
};

syncExecutionSchema.statics.markCompleted = async function(syncGUID, counters = {}) {
  const endTime = new Date();
  const syncExec = await this.findOne({ syncGUID });
  const duration = syncExec ? endTime - syncExec.startTime : 0;
  
  return this.findOneAndUpdate(
    { syncGUID },
    {
      $set: {
        status: 'completed',
        endTime,
        duration,
        lastSyncedAt: endTime,
        ...(counters.itemsProcessed !== undefined && { 'counters.itemsProcessed': counters.itemsProcessed }),
        ...(counters.itemsInserted !== undefined && { 'counters.itemsInserted': counters.itemsInserted }),
        ...(counters.itemsUpdated !== undefined && { 'counters.itemsUpdated': counters.itemsUpdated }),
        ...(counters.itemsDeleted !== undefined && { 'counters.itemsDeleted': counters.itemsDeleted })
      }
    },
    { new: true }
  );
};

syncExecutionSchema.statics.markFailed = async function(syncGUID, errorInfo) {
  const endTime = new Date();
  const syncExec = await this.findOne({ syncGUID });
  const duration = syncExec ? endTime - syncExec.startTime : 0;
  
  return this.findOneAndUpdate(
    { syncGUID },
    {
      $set: {
        status: 'failed',
        endTime,
        duration,
        error: {
          message: errorInfo.message || 'Unknown error',
          stack: errorInfo.stack || null,
          details: errorInfo.details || null
        }
      }
    },
    { new: true }
  );
};

syncExecutionSchema.statics.markTimeout = async function(syncGUID) {
  const endTime = new Date();
  const syncExec = await this.findOne({ syncGUID });
  const duration = syncExec ? endTime - syncExec.startTime : 0;
  
  return this.findOneAndUpdate(
    { syncGUID },
    {
      $set: {
        status: 'timeout',
        endTime,
        duration,
        lastSyncedAt: null,
        error: {
          message: 'Sync operation timed out (exceeded 20 minutes)',
          stack: null,
          details: { timeoutThreshold: 20 * 60 * 1000 }
        }
      }
    },
    { new: true }
  );
};

syncExecutionSchema.statics.getLatestForBoard = async function(boardId) {
  return this.findOne({ boardId }).sort({ createdAt: -1 });
};

syncExecutionSchema.statics.hasRunningSync = async function(boardId) {
  const runningSync = await this.findOne({
    boardId,
    status: { $in: ['started', 'in-progress'] }
  });
  return !!runningSync;
};

export default mongoose.model('SyncExecution', syncExecutionSchema);

