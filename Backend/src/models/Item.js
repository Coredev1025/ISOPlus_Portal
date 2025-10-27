import mongoose from 'mongoose';

const itemSchema = new mongoose.Schema({
  workspaceId: {
    type: String,
    required: true
  },
  boardId: {
    type: String,
    required: true
  },
  folderId: {
    type: String,
    required: true
  },
  itemId: {
    type: String,
    required: true,
    unique: true
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

// Update the updatedAt field before saving
itemSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model('Item', itemSchema);

