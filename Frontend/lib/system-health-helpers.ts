import { format, isValid, parseISO } from "date-fns";

import { CONNECTION_ORDER } from "@/constants/system-health";
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
 * An absolute started-at timestamp, in the reader's local time. Absolute
 * rather than relative (contrast formatDistanceToNow on the overview tiles):
 * an operator reading a run history compares rows against each other, not
 * against "now", matching automation-schedule-block.tsx's formatNextRun.
 */
export function formatStartedAt(startedAt: string | null | undefined): string {
  if (!startedAt) return "—";
  const parsed = parseISO(startedAt);
  return isValid(parsed) ? format(parsed, "dd/MM/yyyy 'at' h:mm a") : "—";
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
