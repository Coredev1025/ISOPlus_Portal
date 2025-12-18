import mongoose from 'mongoose';

const itemSchema = new mongoose.Schema({
  workspaceId: {
    type: String,
    required: true,
    index: true
  },
  boardId: {
    type: String,
    required: true,
    index: true
  },
  folderId: {
    type: String,
    required: true,
    index: true
  },
  itemId: {
    type: String,
    required: true,
    unique: true
  },
  isoPlusItemId: {
    type: String,
    default: null
  },
  syncGUID: {
    type: String,
    default: null,
    index: true
  },
  data: {
    type: Object,
    default: {}
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

itemSchema.index({ workspaceId: 1, boardId: 1 });
itemSchema.index({ workspaceId: 1, boardId: 1, folderId: 1 });
itemSchema.index({ boardId: 1, syncGUID: 1 });

itemSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  if (this.itemId) {
    this.isoPlusItemId = this.itemId;
  }
  next();
});

export default mongoose.model('Item', itemSchema);

