import mongoose from 'mongoose';

import { isValidSchedule } from '../services/scheduler/nextRun.js';
import { DEFAULT_TIMEZONE, PROBE_CRON } from '../constants/scheduler.js';
import { AUTOMATION_UNITS } from '../constants/automation.js';

// A cron/timezone pair is only valid together — 'not-a-cron' is invalid on its
// own, but so is a well-formed cron paired with a timezone Intl does not
// recognise. Both fields validate against the combination so either one being
// edited in isolation is still caught.
//
// Only meaningful for cron jobs. A picker schedule has no cron to validate,
// and returning true there lets the exactly-one check own that case.
function cronIsValid(value) {
  if (value === null || value === undefined) return true;
  return isValidSchedule(value, this.timezone);
}

// A picker schedule still needs a real IANA zone, but isValidSchedule needs a
// cron to parse. Probe with a trivially valid expression (PROBE_CRON, shared
// with timezone.js via constants/scheduler.js) so the timezone is checked in
// isolation.
function timezoneIsValid(value) {
  return isValidSchedule(this.cron ?? PROBE_CRON, value);
}

function exactlyOneSchedule() {
  const hasCron = Boolean(this.cron);
  const hasPicker = Boolean(this.schedule?.every?.unit);
  return hasCron !== hasPicker;
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
    // Validated together with timezone via isValidSchedule (nextRun.js), and
    // exactly one of cron / schedule is enforced by the pre('validate') hook
    // below. cron is the traditional expression; schedule is the picker
    // shape (every {n, unit} anchored on startDate) that cron cannot express,
    // e.g. "every 2 weeks".
    //
    // IMPORTANT: this validation runs on document middleware (.validate() /
    // .save()), which today means only the unit tests. Every production
    // write — upsertSchedule/disableSchedule in services/scheduler/schedules.js,
    // plus outcome.js and tick.js — uses findOneAndUpdate/updateOne, neither
    // of which triggers document middleware or passes runValidators. So this
    // schema does NOT protect the real write path. upsertSchedule already
    // knows this and calls isValidSchedule explicitly before writing; any
    // caller that writes schedule via an update must do the equivalent
    // exactly-one check itself rather than relying on this hook.
    cron: {
      type: String,
      default: null,
      validate: {
        validator: cronIsValid,
        message: (props) => `"${props.value}" is not a valid cron expression`,
      },
    },
    schedule: {
      type: new mongoose.Schema(
        {
          every: {
            n: { type: Number, required: true, min: 1 },
            unit: { type: String, required: true, enum: AUTOMATION_UNITS },
          },
          runOn: { type: mongoose.Schema.Types.Mixed, default: null },
          runAt: { type: String, required: true, default: '09:00' },
          startDate: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
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

// cron and schedule are mutually exclusive representations of the same
// concept — see the module comment on cronIsValid/timezoneIsValid for why
// cron cannot express the picker shape. Enforced here rather than as a field
// validator because it depends on both fields together.
scheduledJobSchema.pre('validate', function assertExactlyOne(next) {
  if (!exactlyOneSchedule.call(this)) {
    next(new Error('ScheduledJob: exactly one of cron or schedule is required'));
    return;
  }
  next();
});

scheduledJobSchema.index({ enabled: 1, nextRunAt: 1 });
scheduledJobSchema.index({ kind: 1, targetId: 1 }, { unique: true });

export default mongoose.model('ScheduledJob', scheduledJobSchema);
