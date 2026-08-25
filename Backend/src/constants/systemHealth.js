/**
 * Every fixed value the Visibility & Monitoring feature depends on.
 *
 * Each entry records its touchpoints — the modules that read it — so changing
 * one here tells you what it reaches without a grep. Keep those lists current:
 * a stale touchpoint comment is worse than none, because it will be believed.
 *
 * This file imports nothing, deliberately, so a model and a service can both
 * read it without risking a cycle.
 */

// ── Run lifecycle ───────────────────────────────────────────────────────────

/**
 * The states one automation run passes through.
 *
 * RUN_RUNNING is unused until Epic 5.6/5.7: the worker is inert and goes
 * queued -> skipped in one step, because it does no work to be in the middle
 * of. It exists now so the real worker can mark a long generation in flight
 * without the enum changing shape later.
 *
 * Touchpoints: models/AutomationRun.js (enum), services/automation/runs.js
 * (transitions), utils/automationRunMetrics.js (counts), routes/systemHealth.js
 * (retry eligibility).
 */
export const RUN_QUEUED = 'queued';
export const RUN_RUNNING = 'running';
export const RUN_SUCCEEDED = 'succeeded';
export const RUN_FAILED = 'failed';
export const RUN_SKIPPED = 'skipped';

/** Read-only by convention — nothing freezes it. */
export const RUN_STATUSES = [RUN_QUEUED, RUN_RUNNING, RUN_SUCCEEDED, RUN_FAILED, RUN_SKIPPED];

/**
 * Why a run produced nothing. A skipped run is not a failure — the worker
 * refused to generate rather than burn invoice numbers on documents it could
 * not deliver — but it is not a success either, and the drill-down has to say
 * which refusal it was.
 *
 * Every value here corresponds to an early return in
 * workers/automationWorker.js that logs and resolves.
 *
 * Touchpoints: workers/automationWorker.js (writes them),
 * models/AutomationRun.js (enum). The Frontend renders the run's STATUS, not
 * its skipReason, and could not import this file if it wanted to: it lives in
 * the other app.
 */
export const SKIP_SETTINGS_DISABLED = 'settings_disabled';
export const SKIP_NO_EMAIL_BACKEND = 'no_email_backend';
export const SKIP_NO_RECIPIENT = 'no_recipient';
export const SKIP_ACCOUNTING_NOT_CONNECTED = 'accounting_not_connected';

export const SKIP_REASONS = [
  SKIP_SETTINGS_DISABLED,
  SKIP_NO_EMAIL_BACKEND,
  SKIP_NO_RECIPIENT,
  SKIP_ACCOUNTING_NOT_CONNECTED,
];

/**
 * What caused a run. Manual runs are distinguished so a forced re-run does not
 * read as a duplicate bug in the history it exists to help debug.
 *
 * Touchpoints: models/AutomationRun.js (enum), services/scheduler/handlers.js
 * (schedule), services/automation/runs.js (default trigger),
 * routes/systemHealth.js (manual).
 */
export const TRIGGER_SCHEDULE = 'schedule';
export const TRIGGER_MANUAL = 'manual';

/** Read-only by convention. */
export const RUN_TRIGGERS = [TRIGGER_SCHEDULE, TRIGGER_MANUAL];

// ── Metrics ─────────────────────────────────────────────────────────────────

/**
 * The window the headline error rate is computed over, and how many buckets
 * the sparkline splits it into. 24 hours over 12 buckets is two hours each —
 * coarse enough that one failure does not spike the whole chart, fine enough
 * that a burst is visible.
 *
 * Touchpoints: utils/automationRunMetrics.js (both). ERROR_RATE_WINDOW_HOURS is
 * also read by routes/systemHealth.js, which echoes it back on the overview
 * response as errorRateWindowHours. TREND_BUCKETS has no reader outside the
 * metrics helper — the bucket count is a computation detail, not part of the
 * response shape.
 */
export const ERROR_RATE_WINDOW_HOURS = 24;
export const TREND_BUCKETS = 12;

/**
 * Rolling windows measured back from now for counting recent runs.
 * Not calendar day/week boundaries — these are elapsed-time windows.
 *
 * Touchpoints: utils/automationRunMetrics.js (both). WEEK_WINDOW_HOURS is
 * also read by routes/systemHealth.js, which sizes its AutomationRun query
 * window from it — that window has to reach at least as far back as
 * summariseRuns' widest window or runsThisWeek silently truncates.
 */
export const TODAY_WINDOW_HOURS = 24;
export const WEEK_WINDOW_HOURS = 7 * 24;

/**
 * Rows per page in the drill-down history. The spec requires the history be
 * uncapped, so this paginates rather than truncates — the response carries a
 * total and the UI pages through it. The UI that does the paging is
 * Frontend's lib/system-health-drilldown-view.tsx, which reads pageSize off
 * the response rather than importing this file — a Backend constants file
 * cannot be imported by a Frontend module.
 *
 * Touchpoints: routes/systemHealth.js.
 */
export const HISTORY_PAGE_SIZE = 50;

/**
 * Queue depth at or above which the overview flags a backlog. Not an alert —
 * no alerting infrastructure ships this round — just the threshold the tile
 * turns amber at.
 *
 * Touchpoints: services/automation/queueMetrics.js, which folds it into the
 * `backlogged` flag routes/systemHealth.js and the Frontend then only read.
 */
export const QUEUE_DEPTH_WARN = 50;

/**
 * The SES event types that mean a message did not reach the person it was for.
 *
 * Stored verbatim as SES spells them (`services/email/events.js` does not
 * normalise `eventType`), so these strings are the wire values, not our own
 * vocabulary. Delivery and Send are excluded deliberately: they are the
 * healthy path, and counting them here would make the figure meaningless.
 *
 * Touchpoints: routes/systemHealth.js (the overview's delivery counts).
 */
export const SES_BOUNCE_EVENT = 'Bounce';
export const SES_COMPLAINT_EVENT = 'Complaint';

