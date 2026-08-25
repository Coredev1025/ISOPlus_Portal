"use client";

import { Button } from "@/components/ui/button";
import { formatDuration, formatStartedAt, runStatusLabel } from "@/lib/system-health-helpers";
import type { RunRow } from "@/lib/system-health-types";
import { SKIP_REASON_LABELS } from "@/constants/system-health";

const TRIGGER_LABELS: Record<RunRow["trigger"], string> = {
  schedule: "Scheduled",
  manual: "Manual",
};

const RETRIABLE_STATUS: RunRow["status"] = "failed";

type RowProps = Readonly<{
  run: RunRow;
  onRetry: (runId: string) => void;
  retrying: boolean;
  dispatching: boolean;
}>;

/**
 * One run: identity (board, period, kind, trigger) on top, outcome below.
 * Retry only ever applies to a `failed` row. That state is reachable in
 * production now — the worker marks a run failed on its last attempt — so this
 * branch is live rather than fixture-only, which is what the comment here used
 * to say while Epic 5.6/5.7 was still unbuilt.
 */
function RunRowItem({ run, onRetry, retrying, dispatching }: RowProps) {
  const isFailed = run.status === RETRIABLE_STATUS;
  // A skip with no mapped reason renders nothing extra rather than a raw code:
  // an unrecognised value is a backend this build has not caught up with, and
  // "skipped" alone is still true.
  const skipExplanation = run.skipReason ? SKIP_REASON_LABELS[run.skipReason] : undefined;
  const showFooter = isFailed || Boolean(run.error) || Boolean(skipExplanation);

  return (
    <li className="space-y-1 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="font-medium">{run.boardId}</span>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
          <span>{formatStartedAt(run.startedAt)}</span>
          <span>{run.periodKey}</span>
          <span>{run.kind}</span>
          <span>{TRIGGER_LABELS[run.trigger]}</span>
          <span>{runStatusLabel(run.status)}</span>
          <span>{formatDuration(run.durationMs)}</span>
          <span>{run.recipient ?? "—"}</span>
        </span>
      </div>

      {showFooter ? (
        <div className="flex items-center justify-between gap-3">
          {run.error ? (
            <p className="text-xs text-destructive">{run.error}</p>
          ) : skipExplanation ? (
            <p className="text-xs text-muted-foreground">{skipExplanation}</p>
          ) : (
            <span />
          )}
          {isFailed ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={retrying || dispatching}
              onClick={() => onRetry(run._id)}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

type ListProps = Readonly<{
  runs: readonly RunRow[];
  onRetry: (runId: string) => void;
  retryingId: string | null;
  // True while ANY dispatch is in flight — a run, or another row's retry. Every
  // Retry is disabled for the duration, not just the row that was clicked:
  // two dispatches for the same period race each other.
  dispatching: boolean;
}>;

export function RunList({ runs, onRetry, retryingId, dispatching }: ListProps) {
  // Explicit copy rather than an empty <ul>: a genuinely empty history has to
  // read differently from "still loading" and "failed to load", the same
  // reasoning that makes the 409 refusal explicit rather than silent.
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {runs.map((run) => (
        <RunRowItem
          key={run._id}
          run={run}
          onRetry={onRetry}
          retrying={retryingId === run._id}
          dispatching={dispatching}
        />
      ))}
    </ul>
  );
}
