import { CONNECTION_ORDER } from "@/constants/system-health";
import { formatNextRun } from "@/lib/automation-helpers";
import type { ConnectionStatus, RunStatus } from "@/lib/system-health-types";

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  // "Skipped" is now literally what happened: the worker refused to generate
  // rather than burn invoice numbers on documents it could not deliver — no
  // recipient address, no email backend, or the block switched off. While the
  // worker was inert this said "Pending setup", which stopped being true when
  // delivery landed.
  skipped: "Skipped",
};

/** A 0–1 rate as a percentage, or an em dash when there is no rate to show. */
export function formatErrorRate(rate: number | undefined | null): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return "—";
  const percent = rate * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/**
 * A duration, or an em dash when there is none.
 *
 * Absent is not zero: a skipped run never ran, and rendering "0ms" would read
 * as an instant success.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * An absolute started-at timestamp, in the SCHEDULE's zone. Absolute rather
 * than relative (contrast formatDistanceToNow on the overview tiles): an
 * operator reading a run history compares rows against each other, not against
 * "now".
 *
 * `timeZone` comes from the API (ScheduledJob.timezone, already returned on
 * every schedule row). Formatting locally instead put two clocks on one screen
 * — a workspace running at 21:54 Sydney rendered "7:54 PM" to a reader in
 * Manila, contradicting the Automation tab's Run At field for the same
 * schedule. PR #880 fixed that on the Automation tab; this is the same defect
 * on the System Health screens.
 *
 * Delegates to formatNextRun rather than repeating its Intl-parts formatter:
 * the two must not disagree about how an instant is spelled, and that one
 * already carries the zone fallback and the assembled-from-parts shape.
 */
export function formatStartedAt(
  startedAt: string | null | undefined,
  timeZone?: string,
): string {
  return formatNextRun(startedAt, timeZone);
}

/**
 * The zone to render one run's timestamps in.
 *
 * Matched on `kind` so a workspace whose invoice and statement schedules ever
 * disagree renders each row against its own schedule. Falls back to any
 * schedule on the workspace — every schedule there carries that workspace's
 * zone, so a run whose schedule has since been deleted is still better served
 * by a sibling than by the reader's browser — and finally to undefined, which
 * leaves formatStartedAt on the business default.
 */
export function timezoneForKind(
  schedules: readonly { kind: string; timezone?: string }[],
  kind: string,
): string | undefined {
  return (
    schedules.find((schedule) => schedule.kind === kind)?.timezone
    ?? schedules.find((schedule) => schedule.timezone)?.timezone
  );
}

export function runStatusLabel(status: RunStatus): string {
  return RUN_STATUS_LABELS[status] ?? "Unknown";
}

/** Worst-first, so what needs attention is on screen without scrolling. */
export function sortClientsBySeverity<T extends { connection: ConnectionStatus }>(
  rows: readonly T[],
): T[] {
  const rank = (status: ConnectionStatus) => {
    const index = CONNECTION_ORDER.indexOf(status);
    return index === -1 ? CONNECTION_ORDER.length : index;
  };
  // Copy first: sort mutates, and mutating props defeats React's change
  // detection.
  return [...rows].sort((a, b) => rank(a.connection) - rank(b.connection));
}
