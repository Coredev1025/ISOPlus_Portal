import mongoose from 'mongoose';

import { isValidSchedule } from '../services/scheduler/nextRun.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';

// A cron/timezone pair is only valid together — 'not-a-cron' is invalid on its
// own, but so is a well-formed cron paired with a timezone Intl does not
// recognise. Both fields validate against the combination so either one being
// edited in isolation is still caught.
function cronIsValid(value) {
  return isValidSchedule(value, this.timezone);
}

function timezoneIsValid(value) {
  return isValidSchedule(this.cron, value);
}

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
    // Validated together with timezone via isValidSchedule (nextRun.js) — the
    // same check upsertSchedule already runs before writing, now enforced for
    // any write, including ones that bypass that service function.
    cron: {
      type: String,
      required: true,
      validate: {
        validator: cronIsValid,
        message: (props) => `"${props.value}" is not a valid cron expression`,
      },
    },
    timezone: {
      type: String,
      required: true,
      default: DEFAULT_TIMEZONE,
      validate: {
        validator: timezoneIsValid,
        message: (props) => `"${props.value}" is not a valid IANA timezone`,
      },
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
