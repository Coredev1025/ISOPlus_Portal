import ScheduledJob from '../models/ScheduledJob.js';
import { buildFanOutSpecs, KIND_INVOICE, KIND_STATEMENT } from '../services/automation/fanOut.js';
import { countRunsForPeriod } from '../services/automation/runs.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';

/** The two kinds a manual dispatch may be requested for, keyed on the request body value. */
export const KIND_FOR_BODY = { invoice: KIND_INVOICE, statement: KIND_STATEMENT };

// Distinguish a manually triggered jobId from the scheduled fan-out's inv:/
// stmt: prefixes (fanOut.js), so a forced re-run cannot collide with — or be
// mistaken for — a scheduled one. Private to this module for the same reason
// fanOut.js keeps its own prefixes unexported: callers work through the
// functions below, never the prefix string itself.
const MANUAL_JOB_PREFIX = 'manual';
const RETRY_JOB_PREFIX = 'retry';

/**
 * The fan-out specs a manual dispatch would enqueue, and how many runs
 * already exist for the period they land on.
 *
 * The timezone comes from the ScheduledJob for this kind/workspace, NOT from
 * AutomationSettings — that model has no timezone field, so reading it there
 * would silently fall back to DEFAULT_TIMEZONE for every workspace not on
 * Sydney time. The period key is formatted in this zone, so the wrong one
 * produces a key that cannot match the scheduled run's, and the duplicate
 * check this function exists to support would compare against nothing.
 */
export async function buildManualDispatch({ kind, workspaceId, boards }) {
  const schedule = await ScheduledJob.findOne({ kind, targetId: workspaceId })
    .select('timezone')
    .lean();

  const specs = buildFanOutSpecs({
    kind,
    workspaceId,
    boards,
    slot: new Date(),
    timezone: schedule?.timezone ?? DEFAULT_TIMEZONE,
  });

  const periodKey = specs[0]?.data.periodKey ?? null;
  const existing = periodKey
    ? await countRunsForPeriod({ workspaceId, kind, periodKey })
    : 0;

  return { specs, periodKey, existing };
}

/**
 * Applies `?force=1`: mints a distinct `manual:` jobId per spec so BullMQ
 * cannot collapse the forced run into the job already recorded for this
 * period — silent dedupe here would mean the button appears to do nothing.
 * Specs pass through unchanged when force is not set.
 */
export function withForceJobIds({ specs, force, existing }) {
  if (!force) return specs;
  return specs.map((spec) => ({
    ...spec,
    opts: { jobId: `${MANUAL_JOB_PREFIX}:${spec.data.boardId}:${spec.data.periodKey}:${existing}` },
  }));
}

/** The re-enqueue spec for one failed run, under a jobId distinct from the original run's. */
export function buildRetrySpec(run) {
  return {
    name: run.kind,
    data: {
      kind: run.kind,
      workspaceId: run.workspaceId,
      boardId: run.boardId,
      periodKey: run.periodKey,
    },
    opts: { jobId: `${RETRY_JOB_PREFIX}:${run.boardId}:${run.periodKey}:${run._id}` },
  };
}
