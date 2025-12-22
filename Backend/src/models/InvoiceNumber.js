import mongoose from 'mongoose';

const invoiceNumberSchema = new mongoose.Schema({
  itemId: {
    type: String,
    required: true,
    ref: 'Item'
  },
  workspaceId: {
    type: String,
    required: true
  },
  boardId: {
    type: String,
    required: true
  },
  invoiceNumber: {
    type: String,
    required: true
  },
  type: {
    type: String,
    required: true,
    enum: ['PDF', 'Xero']
  },
  pdfLink: {
    type: String,
    default: null
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
invoiceNumberSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Create compound index for efficient queries
invoiceNumberSchema.index({ itemId: 1, type: 1 });
invoiceNumberSchema.index({ workspaceId: 1, boardId: 1 });

export default mongoose.model('InvoiceNumber', invoiceNumberSchema);

