/**
 * Fixed values for the System Health screens.
 *
 * Touchpoints are recorded per entry, matching the backend convention in
 * Backend/src/constants/. This file imports nothing.
 */

/**
 * How often the overview refetches. Slow on purpose: this is a troubleshooting
 * screen, not a dashboard anyone watches, and every poll runs three queries.
 *
 * Touchpoints: lib/use-system-health.ts.
 */
export const SYSTEM_HEALTH_POLL_MS = 30_000;

/**
 * Display text for each connection state. The keys match the strings
 * Backend/src/utils/automationConnectionStatus.js returns.
 *
 * Touchpoints: lib/system-health-connection-grid.tsx. (system-health-helpers.ts
 * imports CONNECTION_ORDER from this file, not this constant.)
 */
export const CONNECTION_LABELS = {
  connected: "Connected",
  disconnected: "Disconnected",
  needs_reauth: "Needs re-auth",
} as const;

/**
 * Severity order, worst first — the grid sorts by this so the clients needing
 * attention are on screen without scrolling.
 *
 * Touchpoints: lib/system-health-helpers.ts (sortClientsBySeverity).
 */
export const CONNECTION_ORDER = ["needs_reauth", "disconnected", "connected"] as const;

/**
 * Copy for the scheduler heartbeat tile. A `null` `lastTickAt` means the
 * scheduler has never ticked in this environment — usually a missing
 * EventBridge rule (see docs/scheduling.md) — and every other figure on the
 * screen is legitimately zero in that state, so this has to say something an
 * operator can act on rather than showing a blank dash.
 *
 * Touchpoints: lib/system-health-page-view.tsx.
 */
export const SCHEDULER_HEARTBEAT_NEVER_TICKED =
  "Scheduler has never ticked in this environment. This usually means a missing or " +
  "misconfigured EventBridge rule — see docs/scheduling.md.";

/**
 * Fallback page size for the drill-down history pager. The server sends the
 * real value on every response (Backend/src/constants/systemHealth.js owns
 * it); this only ever covers the render before the first response resolves,
 * and is kept in step with the backend value so the two never disagree.
 *
 * The page NUMBER is owned by the view, not the server: the response's `page`
 * echo is deliberately discarded, which is safe only because the route does
 * not clamp an out-of-range page (it skips and returns an empty list plus the
 * true total). If it ever starts clamping, the view must read `page` back.
 *
 * Touchpoints: lib/system-health-drilldown-view.tsx.
 */
export const HISTORY_PAGE_SIZE = 50;

/**
 * Why a run did nothing, in words an operator can act on.
 *
 * Keys are the values `Backend/src/constants/systemHealth.js` defines and the
 * worker writes to `AutomationRun.skipReason`. The field was stored, returned
 * by the route and declared on the client type, but never rendered — so every
 * skip looked identical, and the four causes need four different responses:
 * one is a settings toggle, one is a deployment variable, one is a participant
 * profile, one is a Xero reconnection.
 *
 * Touchpoints: lib/system-health-run-row.tsx (the only reader).
 */
export const SKIP_REASON_LABELS: Record<string, string> = {
  settings_disabled: "Skipped because automation is switched off for this block",
  no_email_backend: "Skipped because no email backend is configured in this environment",
  no_recipient: "Skipped because the client has no email address on file",
  accounting_not_connected: "Skipped because the accounting platform is not connected",
};
