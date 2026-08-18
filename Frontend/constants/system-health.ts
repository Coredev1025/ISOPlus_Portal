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
 * Touchpoints: lib/system-health-drilldown-view.tsx.
 */
export const HISTORY_PAGE_SIZE = 50;
