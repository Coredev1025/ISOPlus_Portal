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
  // ── The invoiced marker (invoice selection spec, section 3.2) ────────────
  // Which invoice has claimed this item. Its presence is what stops a second
  // run billing the same work: selection skips any item that carries one.
  //
  // Top-level, NOT a key inside `data`, and that is the whole point. Sync
  // rewrites `data` wholesale on every run — `$set: { data: transformedData }`
  // in syncWorkerBacklogHelpers.buildBacklogBulkOp — so a marker kept in there
  // would be erased by the next sync and the item billed again. Sync never
  // touches these three fields.
  //
  // Written by utils/invoicedMarker.js, and by every path that allocates an
  // invoice number, through utils/invoicePdfSupport.js saveInvoiceNumber.
  // Declared here because Mongoose strict mode silently drops a $set for a
  // path the schema does not know.
  invoicedBy: {
    type: String,
    default: null
  },
  // The period the claiming run covered, as the scheduler's period key. Kept
  // for support questions ("why was this on the January invoice") and for the
  // migration's reverse.
  invoicedPeriodKey: {
    type: String,
    default: null
  },
  // When the claim was made. Distinct from updatedAt, which sync moves on
  // every pass whether or not anything about the billing changed.
  invoicedAt: {
    type: Date,
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

