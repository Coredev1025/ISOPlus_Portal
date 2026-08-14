import AutomationRun from '../../models/AutomationRun.js';
import {
  RUN_QUEUED,
  RUN_RUNNING,
  RUN_SKIPPED,
  RUN_SUCCEEDED,
  RUN_FAILED,
  TRIGGER_SCHEDULE,
} from '../../constants/systemHealth.js';

/**
 * One queued row per fan-out spec.
 *
 * `$setOnInsert` only, deliberately: a redispatch of the same slot must not
 * reopen a run that already finished. The jobId is the same key BullMQ dedupes
 * on, so the second dispatch enqueues nothing — recording it as freshly queued
 * would contradict the queue.
 *
 * `ordered: false` so one duplicate does not abandon the rest of the batch.
 * Returns the number of rows actually inserted, which is what the caller logs.
 */
export async function recordQueuedRuns({ specs, trigger = TRIGGER_SCHEDULE }) {
  if (!specs?.length) return 0;

  const operations = specs.map(({ data, opts }) => ({
    updateOne: {
      filter: { jobId: opts.jobId },
      update: {
        $setOnInsert: {
          jobId: opts.jobId,
          workspaceId: data.workspaceId,
          boardId: data.boardId,
          kind: data.kind,
          periodKey: data.periodKey,
          status: RUN_QUEUED,
          trigger,
          startedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  const result = await AutomationRun.bulkWrite(operations, { ordered: false });
  return result.upsertedCount ?? 0;
}

/**
 * Close a run.
 *
 * Guarded on the row not already being terminal, so a late duplicate delivery
 * cannot overwrite the outcome that was recorded first. A jobId with no row is
 * a no-op rather than an error: the worker must not fail a job because its
 * bookkeeping row was pruned or never written.
 */
async function closeRun(jobId, fields) {
  const run = await AutomationRun.findOne({ jobId }).lean();
  if (!run) return;

  const finishedAt = new Date();
  await AutomationRun.updateOne(
    { jobId, status: { $in: [RUN_QUEUED, RUN_RUNNING] } },
    {
      $set: {
        finishedAt,
        durationMs: fields.measureDuration
          ? finishedAt.getTime() - new Date(run.startedAt).getTime()
          : null,
        ...fields.set,
      },
    },
  );
}

export function markRunSkipped({ jobId, skipReason }) {
  // No duration: nothing ran, and "0ms" would read as an instant success.
  return closeRun(jobId, { measureDuration: false, set: { status: RUN_SKIPPED, skipReason } });
}

export function markRunSucceeded({ jobId, recipient = null }) {
  return closeRun(jobId, {
    measureDuration: true,
    set: { status: RUN_SUCCEEDED, recipient, error: null },
  });
}

export function markRunFailed({ jobId, error }) {
  return closeRun(jobId, {
    measureDuration: true,
    set: { status: RUN_FAILED, error: String(error ?? 'unknown error') },
  });
}

/** How many runs already exist for one workspace/kind/period. */
export function countRunsForPeriod({ workspaceId, kind, periodKey }) {
  return AutomationRun.countDocuments({ workspaceId, kind, periodKey });
}
