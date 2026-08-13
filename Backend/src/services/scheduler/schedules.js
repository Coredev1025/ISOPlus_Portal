import ScheduledJob from '../../models/ScheduledJob.js';
import { info } from '../../utils/logger.js';
import { isValidSchedule } from './nextRun.js';
import { resolveTimezone } from './timezone.js';
import { assertMinimumInterval } from './intervalFloor.js';
import { pickerScheduleError } from './pickerValidation.js';
import { advanceSchedule, canonicalStartDate } from './advance.js';
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
  const effectiveTimezone = await resolveTimezone({ workspaceId, timezone });

  if (Boolean(cron) === Boolean(schedule?.every?.unit)) {
    throw new Error(`Scheduler: exactly one of cron or schedule is required for "${kind}"`);
  }

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

  const nextRunAt = advanceSchedule(
    { cron, schedule: anchoredSchedule, timezone: effectiveTimezone },
    now,
  );

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
