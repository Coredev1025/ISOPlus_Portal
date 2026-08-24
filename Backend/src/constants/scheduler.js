/**
 * Every fixed value the scheduler depends on, in one place.
 *
 * Each entry records its touchpoints — the modules that read it — so changing
 * one here tells you what it reaches without a grep. Keep those lists current:
 * a stale touchpoint comment is worse than none, because it will be believed.
 *
 * This file imports nothing, deliberately. That is what lets a model and a
 * service both read it without risking a cycle — `models/ScheduledJob.js`
 * already imports from `services/scheduler/nextRun.js`.
 */

// ── Delivery policies ───────────────────────────────────────────────────────

/**
 * The two delivery guarantees a handler can be registered under. Declared at
 * registration, never stored on a schedule record, so an operator editing a
 * document cannot put a handler under a guarantee it cannot survive.
 *
 * AT_MOST_ONCE advances the schedule as part of the claim, before dispatch: a
 * crash loses the slot. Correct where a duplicate is worse than a miss, such
 * as issuing an invoice. AT_LEAST_ONCE advances only after a successful
 * enqueue: a crash retries and two instances may both dispatch. Correct where
 * the handler is idempotent and a miss is worse than a repeat, such as board
 * sync.
 *
 * Touchpoints: registry.js (validates against POLICIES), tick.js (claim
 * strategy), outcome.js (success/failure recording), intervalFloor.js
 * (which floor applies), handlers.js (registers invoice and statement
 * automation under AT_LEAST_ONCE — see the comment there for why the invoice
 * kind is not AT_MOST_ONCE despite the guidance above).
 */
export const AT_MOST_ONCE = 'at_most_once';
export const AT_LEAST_ONCE = 'at_least_once';

// ── Tick ────────────────────────────────────────────────────────────────────

/**
 * How many schedules one tick will claim before stopping and reporting
 * `capped: true`. Bounds the work a single HTTP request can do, so a backlog
 * degrades into "several ticks" rather than one request that never returns.
 *
 * Touchpoints: tick.js (default `limit` for runTick).
 */
export const BATCH_LIMIT = 100;

// ── Failure handling ────────────────────────────────────────────────────────

/**
 * How many consecutive failures an AT_LEAST_ONCE schedule may accumulate
 * before its slot is given up and advanced rather than retried on every tick.
 * Bounds a permanently broken handler without disabling a schedule that may
 * only be temporarily wrong.
 *
 * Touchpoints: outcome.js (advancePastFailureLimit).
 */
export const MAX_CONSECUTIVE_FAILURES = 5;

// ── Timezone ────────────────────────────────────────────────────────────────

/**
 * The zone a schedule runs in when nothing else determines one — no explicit
 * timezone, no workspace, no `Business.headOfficeTimezone`, or an inherited
 * value that is not a valid IANA zone.
 *
 * The schema default and the resolver fallback must agree. If they ever
 * disagreed, a schedule would be stored against one zone and have its next run
 * computed in another — a silent offset, not an error.
 *
 * Touchpoints: models/ScheduledJob.js (schema default), timezone.js
 * (resolveTimezone fallback).
 */
export const DEFAULT_TIMEZONE = 'Australia/Sydney';

/**
 * A cron expression that is trivially valid on its own, so passing it to
 * `isValidSchedule` alongside a candidate timezone isolates that function's
 * timezone check from its cron-parsing check. Reuses the existing validation
 * rather than duplicating the `Intl` probe.
 *
 * Touchpoints: timezone.js (resolveTimezone), models/ScheduledJob.js
 * (timezoneIsValid, for a picker schedule that carries no cron).
 */
export const PROBE_CRON = '* * * * *';

// ── Minimum interval floors ─────────────────────────────────────────────────

/**
 * Nothing that issues a document to an NDIS participant has any business
 * running more often than hourly.
 *
 * Touchpoints: intervalFloor.js (floorForPolicy, for AT_MOST_ONCE kinds).
 */
export const AT_MOST_ONCE_MIN_INTERVAL_MINUTES = 60;

/**
 * Sync is idempotent and cheap, so half-hourly and finer is a legitimate
 * cadence. Also applied to any kind whose policy cannot be determined, since
 * an unregistered kind cannot be dispatched anyway.
 *
 * Touchpoints: intervalFloor.js (floorForPolicy, for AT_LEAST_ONCE and
 * unresolved kinds).
 */
export const AT_LEAST_ONCE_MIN_INTERVAL_MINUTES = 5;

// ── Portal board catch-up ───────────────────────────────────────────────────

/**
 * Log kind for the portal-wide ISO+ board catch-up sweep.
 * Touchpoints: handlers.js (runBoardSyncSweep), portalSchedule.js
 * (startBoardSyncCron, buildPortalBoardSyncMeta), sync.js (schedule on status).
 */
export const BOARD_SYNC_KIND = 'board_sync';

/**
 * Daily 02:00. Used when BOARD_SYNC_CRON is unset.
 * Touchpoints: boardSyncSweepHelpers.js (resolveBoardSyncCron), portalSchedule.js.
 */
export const BOARD_SYNC_CRON_DEFAULT = '0 2 * * *';

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Mongo's duplicate-key error code. `upsertSchedule` retries once on it,
 * because `findOneAndUpdate` with `upsert` is not atomic against the unique
 * `{ kind, targetId }` index and the loser of that race gets E11000 rather
 * than converging on the winner's row.
 *
 * Touchpoints: schedules.js (upsertConverging).
 */
export const DUPLICATE_KEY = 11000;

/**
 * The options `upsertSchedule` writes with. `setDefaultsOnInsert` is what
 * makes the schema defaults apply on the insert half of an upsert.
 *
 * Not frozen: it is passed straight to Mongoose, and freezing an object a
 * library may want to normalise is a behaviour change this refactor has no
 * business making. Treat it as read-only by convention.
 *
 * Touchpoints: schedules.js (upsertConverging, both attempts).
 */
export const UPSERT_OPTIONS = { upsert: true, new: true, setDefaultsOnInsert: true };

/**
 * The `key` of the single SchedulerHealth document. There is exactly one
 * scheduler, so exactly one document should ever exist; the unique index on
 * `key` is what enforces that, not application logic.
 *
 * Touchpoints: models/SchedulerHealth.js (schema default), heartbeat.js
 * (the upsert filter).
 */
export const SCHEDULER_HEALTH_KEY = 'scheduler';

// ── Logging ─────────────────────────────────────────────────────────────────

/**
 * The logger scope for everything under `services/scheduler` and the tick
 * route. One spelling, because a typo'd scope does not throw — it just files
 * those lines somewhere nobody greps when a schedule stops running.
 *
 * Touchpoints: tick.js, outcome.js, schedules.js, heartbeat.js,
 * intervalFloor.js, timezone.js, routes/scheduler.js.
 */
export const LOG_SCOPE = 'Scheduler';
