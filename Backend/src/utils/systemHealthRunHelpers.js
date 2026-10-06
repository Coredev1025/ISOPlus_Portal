import ScheduledJob from '../models/ScheduledJob.js';
import { buildFanOutSpecs } from '../services/automation/fanOut.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../constants/automation.js';
import { countRunsForPeriod } from '../services/automation/runs.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';

/** The two kinds a manual dispatch may be requested for, keyed on the request body value. */
export const KIND_FOR_BODY = { invoice: KIND_INVOICE, statement: KIND_STATEMENT };

// Distinguish a manually triggered jobId from the scheduled fan-out's inv:/
// stmt: prefixes (fanOut.js), so a forced re-run cannot collide with — or be
// mistaken for — a scheduled one. Private to this module for the same reason
// fanOut.js keeps its own prefixes unexported: callers work through the
// functions below, never the prefix string itself.
//
// The discriminator goes IN the prefix, not on the end. BullMQ accepts a
// colon-joined custom id only at exactly three parts (Job.validateOptions:
// `jobId.includes(':') && jobId.split(':').length !== 3` throws "Custom Id
// cannot contain :"). The scheduled fan-out clears that bar by having exactly
// two colons; appending a fourth segment threw at enqueue time and made both
// Retry and the forced re-run answer 500 on every call.
const MANUAL_JOB_PREFIX = 'manual';
const RETRY_JOB_PREFIX = 'retry';

/**
 * The fan-out specs a manual dispatch would enqueue, and how many runs
 * already exist for the period they land on.
 *
 * Timezone and picker both come from the ScheduledJob for this kind/workspace,
 * not from AutomationSettings — that model has no timezone field. The period
 * key is formatted in this zone, so the wrong one produces a key that cannot
 * match the scheduled run's. The picker is what tells a statement run whether
 * it covers a week, a quarter or last calendar month: omitting it made Run now
 * fall through `coversOneCalendarMonth`'s missing-schedule default and date
 * every manual statement as 1–31 of the previous month, with invoices from the
 * real cadence sitting in the opening balance and an empty particulars table.
 */
export async function buildManualDispatch({ kind, workspaceId, boards }) {
  const job = await ScheduledJob.findOne({ kind, targetId: workspaceId })
    .select('timezone schedule')
    .lean();

  const specs = buildFanOutSpecs({
    kind,
    workspaceId,
    boards,
    slot: new Date(),
    timezone: job?.timezone ?? DEFAULT_TIMEZONE,
    schedule: job?.schedule,
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
    // Spread, not replace: a future fanOut.js option (attempts, backoff,
    // removeOnComplete) must survive a forced re-run, not just jobId.
    opts: { ...spec.opts, jobId: `${MANUAL_JOB_PREFIX}-${existing}:${spec.data.boardId}:${spec.data.periodKey}` },
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
      // buildFanOutSpecs emits `slot` on every scheduled spec; a retry omitting
      // it would leave job.data.slot undefined once Epic 5.6/5.7 reads it.
      //
      // Note this is the ORIGINAL RUN'S START, not the slot it was scheduled
      // for — AutomationRun records startedAt at enqueue time and never stores
      // the slot. periodKey is copied from the run and is authoritative: a
      // reader must not recompute the period from this slot, because the two
      // disagree whenever the original dispatch crossed a minute boundary
      // (automationPeriodKey is minute-granular). Storing the real slot on
      // AutomationRun is the proper fix and is out of scope here.
      slot: run.startedAt,
    },
    opts: { jobId: `${RETRY_JOB_PREFIX}-${run._id}:${run.boardId}:${run.periodKey}` },
  };
}
