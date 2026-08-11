import mongoose from 'mongoose';

// Singleton discriminator. There is exactly one scheduler, so exactly one
// document should ever exist — the unique index on `key` is what enforces
// that, not application logic.
export const SCHEDULER_HEALTH_KEY = 'scheduler';

const schedulerHealthSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: SCHEDULER_HEALTH_KEY,
    },
    // When the clock last fired, whether or not anything was due. This is the
    // primary signal for a missing or misconfigured EventBridge rule — see
    // docs/scheduling.md.
    lastTickAt: {
      type: Date,
      default: null,
    },
    // The last tick's own summary, so a health screen can show context
    // (how many were claimed/dispatched/failed, whether the batch cap was
    // hit) rather than just a bare timestamp.
    claimed: {
      type: Number,
      default: 0,
    },
    dispatched: {
      type: Number,
      default: 0,
    },
    failed: {
      type: Number,
      default: 0,
    },
    capped: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

export default mongoose.model('SchedulerHealth', schedulerHealthSchema);
