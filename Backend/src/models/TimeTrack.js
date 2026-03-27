import mongoose from 'mongoose';

const TimeTrackSchema = new mongoose.Schema({
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
    itemId: {
        type: String,
        required: true,
        index: true
    },
    Task: {
        type: String,
        required: true
    },
    started_at: {
        type: Date,
        default: null
    },
    ended_at: {
        type: Date,
        default: null
    },
    Duration: {
        type: Number,
        default: null
    },
    User: {
        type: String,
        required: true
    },
    UserId: {
        type: String,
        default: null
    },
    UserName: {
        type: String,
        default: null
    },
    Location: {
        lat: { type: Number, default: null },
        lng: { type: Number, default: null },
        address: { type: String, default: null }
    },
    notes: {
        type: String,
        default: null
    },
    isoPlusSynced: {
        type: Boolean,
        default: false
    }
});

TimeTrackSchema.index({ workspaceId: 1, boardId: 1 });
TimeTrackSchema.index({ itemId: 1, User: 1, ended_at: 1 });

export default mongoose.model('TimeTrack', TimeTrackSchema);