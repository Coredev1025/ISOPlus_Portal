import { CONNECTION_ORDER } from "@/constants/system-health";
import type { ConnectionStatus, RunStatus } from "@/lib/system-health-types";

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  // Not "Skipped": to a reader that implies the system chose to pass this one
  // over. The truth is that delivery is not built yet.
  skipped: "Pending setup",
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
