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
 * Touchpoints: lib/system-health-connection-grid.tsx, lib/system-health-helpers.ts.
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
