import { isEqual } from 'lodash-es';

import ScheduledJob from '../../models/ScheduledJob.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { info } from '../../utils/logger.js';
import { isValidSchedule } from './nextRun.js';
import { resolveTimezone } from './timezone.js';
import { assertMinimumInterval } from './intervalFloor.js';
import { pickerScheduleError } from './pickerValidation.js';
import { advanceSchedule, canonicalStartDate, normaliseStartDate } from './advance.js';
import { DUPLICATE_KEY, UPSERT_OPTIONS, LOG_SCOPE } from '../../constants/scheduler.js';

/**
 * An upsert is not atomic against a unique index. Two callers for the same
 * {kind,targetId} — a toggle double-clicked, two tabs, a retried request — can
 * both find nothing, both attempt the insert, and the loser gets E11000 from
 * the unique {kind,targetId} index rather than converging on the winner's row.
 *
 * Retrying is the documented remedy: by then the row exists, the filter
 * matches it, and the second call updates rather than inserts. Once only — a
 * duplicate that survives the retry is not this race and must surface.
 */
async function upsertConverging(filter, update) {
  try {
    return await ScheduledJob.findOneAndUpdate(filter, update, UPSERT_OPTIONS);
  } catch (err) {
    if (err?.code !== DUPLICATE_KEY) throw err;
    return ScheduledJob.findOneAndUpdate(filter, update, UPSERT_OPTIONS);
  }
}

/**
 * The cadence fields alone, flattened so two schedules can be compared for
 * equality without tripping over Mongoose subdocument internals or Date
 * identity. `startDate` is compared as an epoch because the stored value is a
 * `Date` and the incoming one may be either.
 */
function comparableSchedule(schedule) {
  if (!schedule) return null;
  return {
    n: schedule.every?.n ?? null,
    unit: schedule.every?.unit ?? null,
    runOn: schedule.runOn ?? null,
    runAt: schedule.runAt ?? null,
    startDate: schedule.startDate ? new Date(schedule.startDate).getTime() : null,
  };
}

/**
 * Does this write leave the cadence exactly as it already is?
 *
 * `routes/workspace.js` calls upsertSchedule on every automation-settings PUT,
 * including a save that only changes the reply-to address — `toScheduleInput`
 * carries the cadence fields alone, so such a save re-upserts a byte-identical
 * schedule. Recomputing `nextRunAt` there is not harmless: if the row was
 * already due (the tick is backed up and an admin edits the reply-to address),
 * the recompute pushes the slot to the next cycle. That cycle is never billed,
 * `missedRuns` is not incremented, and nothing logs an anomaly.
 *
 * A disabled row is deliberately excluded: its stored `nextRunAt` is the slot
 * that was due when it was paused, so re-enabling must move it forward or the
 * schedule fires the instant it is switched back on.
 */
function cadenceUnchanged(existing, { cron, schedule, timezone }) {
  if (!existing?.enabled || !existing.nextRunAt) return false;
  if ((existing.cron ?? null) !== (cron ?? null)) return false;
  if (existing.timezone !== timezone) return false;
  return isEqual(comparableSchedule(existing.schedule), comparableSchedule(schedule));
}

/**
 * The only sanctioned way to create or change a schedule. Features call this
 * from their toggle; nothing writes ScheduledJob directly.
 *
 * `now` is a parameter rather than a Date.now() call so the behaviour is
 * testable without freezing the clock.
 *
 * Exactly one of `cron` / `schedule` is required. This is enforced here in
 * application code rather than left to the ScheduledJob schema: every write
 * in this module uses findOneAndUpdate, which is query middleware and never
 * triggers the model's pre('validate') hook — see the comment on `cron` in
 * models/ScheduledJob.js.
 */
export async function upsertSchedule({
  kind,
  targetId,
  workspaceId = null,
  cron = null,
  schedule = null,
  timezone,
  now = new Date(),
}) {
  // Ahead of resolveTimezone, which is a database read: a call this check
  // rejects outright has no business hitting Mongo first.
  if (Boolean(cron) === Boolean(schedule?.every?.unit)) {
    throw new Error(`Scheduler: exactly one of cron or schedule is required for "${kind}"`);
  }

  const effectiveTimezone = await resolveTimezone({ workspaceId, timezone });

  if (cron) {
    if (!isValidSchedule(cron, effectiveTimezone)) {
      throw new Error(
        `Scheduler: invalid schedule for "${kind}" — cron "${cron}", timezone "${effectiveTimezone}"`,
      );
    }
    // The floor is computed by parsing a cron expression, so it only applies
    // to cron jobs. A picker schedule cannot breach it anyway: the finest
    // picker cadence is {n: 1, unit: 'day'} = 1440 minutes, against floors of
    // 60 (AT_MOST_ONCE) and 5 (AT_LEAST_ONCE) minutes — skipping this check
    // for picker schedules is deliberate, not an oversight.
    assertMinimumInterval({ kind, cron, timezone: effectiveTimezone, now });
  } else {
    // The picker half of the same guarantee. Without this the branch trusted
    // its caller completely, and the schema's enum/min/required rules do not
    // run on findOneAndUpdate — so 'fortnight', n: 0 and runAt: '99:99' were
    // all persisted, then silently advanced on a cadence nobody chose.
    const invalid = pickerScheduleError(schedule);
    if (invalid) {
      throw new Error(`Scheduler: invalid schedule for "${kind}" — ${invalid}`);
    }
  }

  // Normalise the startDate once, here, and then both compute and store that
  // one value: the first nextRunAt and every later advance must anchor on the
  // same calendar date. See canonicalStartDate in advance.js for what went
  // wrong when they did not.
  const anchoredSchedule = schedule
    ? { ...schedule, startDate: canonicalStartDate(schedule.startDate, effectiveTimezone) }
    : schedule;

  const candidate = { cron, schedule: anchoredSchedule, timezone: effectiveTimezone };
  const existing = await ScheduledJob.findOne({ kind, targetId }).lean();
  const nextRunAt = cadenceUnchanged(existing, candidate)
    ? existing.nextRunAt
    : advanceSchedule(candidate, now);

  const job = await upsertConverging(
    { kind, targetId },
    {
      $set: {
        workspaceId,
        cron,
        schedule: anchoredSchedule,
        timezone: effectiveTimezone,
        enabled: true,
        nextRunAt,
        lastError: null,
        consecutiveFailures: 0,
      },
    },
  );

  info(LOG_SCOPE, 'Schedule upserted', {
    kind,
    targetId,
    cron,
    schedule: anchoredSchedule,
    timezone: effectiveTimezone,
    nextRunAt: job.nextRunAt,
  });

  return job;
}

/**
 * The schedule input that reproduces an existing row, ready to be re-saved in
 * a different timezone.
 *
 * `startDate` is read back as the calendar date it was written in. It is
 * stored as the instant of local midnight in the job's own zone, so handing
 * that instant to a zone further west re-anchors it on the previous calendar
 * day — a fortnightly series anchored on Tuesday comes back anchored on
 * Monday and every run after it lands half a phase out. Passing the date
 * string instead makes canonicalStartDate re-take midnight on the same day in
 * the new zone, which is what "the same schedule, in a different timezone"
 * means.
 */
function scheduleInputFrom(job) {
  if (!job.schedule) return null;
  return { ...job.schedule, startDate: normaliseStartDate(job.schedule.startDate, job.timezone) };
}

/**
 * Bring a workspace's live schedules onto the timezone its business now uses.
 *
 * KAN-262. A schedule's timezone is a snapshot that `upsertSchedule` takes
 * from `Business.headOfficeTimezone` at save time, and nothing re-took it when
 * the business moved. The job went on computing `nextRunAt` in the old zone —
 * and handing that zone to its handler, which dates the documents the run
 * produces — until someone happened to re-save the automation form. The
 * client saw it as a "Next Run" caption naming a timezone they had already
 * changed; the caption was right, the schedule underneath it was wrong.
 *
 * Deliberately a no-op for anything already on the current zone, so saving a
 * business profile that did not touch the timezone cannot walk a billing slot.
 *
 * Paused schedules are left alone. `upsertSchedule` sets `enabled: true`
 * unconditionally, so re-pointing one through it would switch an automation
 * the client had deliberately turned off back on. A paused block has no
 * future run to move, its stored zone is the one its run history was produced
 * in, and re-enabling it re-inherits the current zone anyway.
 */
export async function repointWorkspaceSchedules({ workspaceId, now = new Date() }) {
  if (!workspaceId) return [];

  const current = await resolveTimezone({ workspaceId });
  const live = await ScheduledJob.find({
    workspaceId: mongoEq(String(workspaceId)),
    enabled: true,
  }).lean();
  const stale = live.filter((job) => job.timezone !== current);
  if (stale.length === 0) return [];

  const moved = [];
  for (const job of stale) {
    moved.push(await upsertSchedule({
      kind: job.kind,
      targetId: job.targetId,
      workspaceId: job.workspaceId,
      cron: job.cron ?? null,
      schedule: scheduleInputFrom(job),
      now,
    }));
  }

  info(LOG_SCOPE, 'Workspace schedules re-pointed after a timezone change', {
    workspaceId,
    timezone: current,
    kinds: moved.map((job) => job.kind),
  });
  return moved;
}

/** Disable rather than delete, so lastRunAt and missedRuns survive. */
export async function disableSchedule({ kind, targetId }) {
  const job = await ScheduledJob.findOneAndUpdate(
    { kind, targetId },
    { $set: { enabled: false } },
    { new: true },
  );

  if (job) {
    info(LOG_SCOPE, 'Schedule disabled', { kind, targetId });
  }

  return job;
}
