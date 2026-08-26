import mongoose from 'mongoose';

import {
  RUN_QUEUED,
  RUN_STATUSES,
  RUN_TRIGGERS,
  TRIGGER_SCHEDULE,
} from '../constants/systemHealth.js';

/**
 * One automation run, per board per slot.
 *
 * Written at fan-out and closed by the worker. Keyed on `jobId`, which is the
 * same string BullMQ dedupes on (`inv:<boardId>:<periodKey>`), so a retried
 * at-least-once dispatch updates the row it already created instead of adding
 * a second one — and so "retry this run" names exactly one queue job.
 *
 * finishedAt/durationMs/recipient stay null until a run actually terminates.
 * A skipped run leaves all three null: nothing ran, and nobody was written to.
 */
const automationRunSchema = new mongoose.Schema(
  {
    workspaceId: { type: String, required: true },
    boardId: { type: String, required: true },
    kind: { type: String, required: true },
    periodKey: { type: String, required: true },
    jobId: { type: String, required: true },

    status: { type: String, required: true, enum: RUN_STATUSES, default: RUN_QUEUED },
    skipReason: { type: String, default: null },
    trigger: { type: String, required: true, enum: RUN_TRIGGERS, default: TRIGGER_SCHEDULE },

    startedAt: { type: Date, required: true, default: () => new Date() },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },

    recipient: { type: String, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

// The drill-down and client panel both read one workspace newest-first.
automationRunSchema.index({ workspaceId: 1, startedAt: -1 });
// The overview counts by outcome within a time window.
automationRunSchema.index({ status: 1, startedAt: -1 });
// The overview's window query (`{ startedAt: { $gte: from } }`) has no status
// predicate, so neither compound index above can serve it — without this, every
// poll collection-scans a week of runs across all clients.
automationRunSchema.index({ startedAt: -1 });
// The idempotency join. Unique, so a double fan-out cannot record twice.
automationRunSchema.index({ jobId: 1 }, { unique: true });

export default mongoose.model('AutomationRun', automationRunSchema);
