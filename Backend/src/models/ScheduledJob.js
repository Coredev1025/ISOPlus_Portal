import mongoose from 'mongoose';

const scheduledJobSchema = new mongoose.Schema(
  {
    // Registry key. Not an enum: kinds are registered in code, and a schema
    // enum here would mean a migration every time a feature adds one.
    kind: {
      type: String,
      required: true,
    },
    // Whatever the handler needs to identify its work — a boardId for
    // board_sync, a workspaceId for invoice_issuance. The handler interprets it.
    targetId: {
      type: String,
      required: true,
    },
    workspaceId: {
      type: String,
      default: null,
    },
    cron: {
      type: String,
      required: true,
    },
    timezone: {
      type: String,
      required: true,
      default: 'Australia/Sydney',
    },
    enabled: {
      type: Boolean,
      required: true,
      default: true,
    },
    // The claim key. Indexed with `enabled` because that pair is the only
    // query the tick makes.
    nextRunAt: {
      type: Date,
      required: true,
    },
    lastRunAt: {
      type: Date,
      default: null,
    },
    lastError: {
      type: String,
      default: null,
    },
    // Slots skipped on recovery. Alert on this being non-zero.
    missedRuns: {
      type: Number,
      default: 0,
    },
    consecutiveFailures: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

scheduledJobSchema.index({ enabled: 1, nextRunAt: 1 });
scheduledJobSchema.index({ kind: 1, targetId: 1 }, { unique: true });

export default mongoose.model('ScheduledJob', scheduledJobSchema);
