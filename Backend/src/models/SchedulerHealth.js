import mongoose from 'mongoose';

import { SCHEDULER_HEALTH_KEY } from '../constants/scheduler.js';

const schedulerHealthSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: SCHEDULER_HEALTH_KEY,
    },
    // When the clock last fired, whether or not anything was due. This is the
    // whole point of the collection and the primary signal for a missing or
    // misconfigured EventBridge rule — see docs/scheduling.md. The tick's
    // counts are not mirrored here: they are already in the tick's log line
    // and on the ScheduledJob rows themselves, and nothing reads a second copy.
    lastTickAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

export default mongoose.model('SchedulerHealth', schedulerHealthSchema);
