"use client";

import { useCallback, useEffect, useState } from "react";

import axios from "@/app/utils/axiosConfig";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import Spinner from "@/components/ui/spin";
import { formatDuration, runStatusLabel } from "@/lib/system-health-helpers";
import type { RunRow } from "@/lib/system-health-types";

type Refusal = { periodKey: string; runs: RunRow[] } | null;

type Props = Readonly<{ workspaceId: string }>;

/** Matches the destructive banner style Task 12's page view uses for its error. */
function ErrorBanner({ message }: Readonly<{ message: string }>) {
  return (
    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
      {message}
    </p>
  );
}

function RunList({ runs }: Readonly<{ runs: readonly RunRow[] }>) {
  // Explicit copy rather than an empty <ul>: a genuinely empty history has to
  // read differently from "still loading" and "failed to load", the same
  // reasoning that makes the 409 refusal explicit rather than silent.
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {runs.map((run) => (
        <li key={run._id} className="flex items-center justify-between px-4 py-3 text-sm">
          <span className="font-medium">{run.boardId}</span>
          <span className="flex items-center gap-4 text-muted-foreground">
            <span>{runStatusLabel(run.status)}</span>
            <span>{formatDuration(run.durationMs)}</span>
            <span>{run.recipient ?? "—"}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SystemHealthDrilldownView({ workspaceId }: Props) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/system-health/workspace/${workspaceId}`,
      );
      setRuns(res.data.runs ?? []);
      setLoadError(null);
    } catch {
      // Keep whatever rows are already on screen — a failed refresh should
      // not blank a troubleshooting screen someone is reading, matching the
      // same choice in use-system-health.ts.
      setLoadError("Could not load run history for this workspace.");
    } finally {
      // Only ever gates the *first* render: nothing here sets loading back to
      // true on a refresh, so a refetch after a run leaves existing rows on
      // screen instead of blanking them.
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  const start = useCallback(
    async (force: boolean) => {
      setBusy(true);
      setRunError(null);
      try {
        const query = force ? "?force=1" : "";
        await axios.post(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/system-health/workspace/${workspaceId}/run${query}`,
          { kind: "invoice" },
        );
        setRefusal(null);
        await load();
      } catch (err) {
        const response = (err as { response?: { status?: number; data?: Refusal } }).response;
        // 409 is the designed answer, not a failure: say which period, and
        // offer the override rather than silently doing nothing. Anything
        // else (500, network error, timeout) must not be swallowed either —
        // a button that appears to do nothing is the worst outcome here.
        if (response?.status === 409 && response.data) {
          setRefusal(response.data);
        } else {
          setRunError("Could not start the run. Try again.");
        }
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, load],
  );

  if (loading) return <Spinner />;

  return (
    <div className="space-y-6">
      {loadError ? <ErrorBanner message={loadError} /> : null}

      <div className="flex items-center gap-3">
        <Button type="button" disabled={busy} onClick={() => start(false)}>
          Run invoices now
        </Button>
      </div>

      {runError ? <ErrorBanner message={runError} /> : null}

      {refusal ? (
        <Card className="space-y-2 border-amber-500/40 p-4">
          <p className="text-sm">
            Already run for {refusal.periodKey} — {refusal.runs.length} run(s) recorded.
          </p>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => start(true)}>
            Force re-run
          </Button>
        </Card>
      ) : null}

      <RunList runs={runs} />
    </div>
  );
}
