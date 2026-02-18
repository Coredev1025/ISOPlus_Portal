import mongoose from 'mongoose';

const Schema = mongoose.Schema;

const AuditTrailSchema = new Schema({
    workspaceId: {
        type: String,
        required: true
    },
    // Optional tenant scoping for board-level actions
    boardId: {
        type: String,
        default: ""
    },
    action: {
        type: String,
        required: true
    },
    detail: {
        type: String,
        required: true
    },
    // Who performed the action
    userEmail: {
        type: String,
        default: ""
    },
    userId: {
        type: String,
        default: ""
    },
    userRole: {
        type: String,
        default: ""
    },
    // Where/when it happened
    userIp: {
        type: String,
        default: "127.0.0.1"
    },
    requestId: {
        type: String,
        default: ""
    },
    method: {
        type: String,
        default: ""
    },
    path: {
        type: String,
        default: ""
    },
    statusCode: {
        type: Number,
        default: null
    },
    success: {
        type: Boolean,
        default: true
    },
    // Optional structured details (kept separate from 'detail' string)
    category: {
        type: String,
        default: ""
    },
    entityType: {
        type: String,
        default: ""
    },
    entityId: {
        type: String,
        default: ""
    },
    before: {
        type: Schema.Types.Mixed,
        default: null
    },
    after: {
        type: Schema.Types.Mixed,
        default: null
    },
    errorMessage: {
        type: String,
        default: ""
    },
    errorStack: {
        type: String,
        default: ""
    },
    metadata: {
        type: Schema.Types.Mixed,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

export default mongoose.model('AuditTrail', AuditTrailSchema);