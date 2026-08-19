"use client";

import { useCallback, useEffect, useState } from "react";

import axios from "@/app/utils/axiosConfig";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import Spinner from "@/components/ui/spin";
import { HISTORY_PAGE_SIZE } from "@/constants/system-health";
import { ErrorBanner } from "@/lib/system-health-banners";
import { RunHistoryPager } from "@/lib/system-health-pager";
import { RunList } from "@/lib/system-health-run-row";
import { ScheduleSummary } from "@/lib/system-health-schedule-summary";
import type { RunRow, ScheduleRow } from "@/lib/system-health-types";

type Refusal = { periodKey: string; runs: RunRow[] } | null;

type Props = Readonly<{ workspaceId: string }>;

function historyUrl(workspaceId: string, page: number) {
  // Read at call time, not module scope: NEXT_PUBLIC_BACKEND_URL is inlined at
  // build time in a real Next build, but a test that sets it in beforeEach
  // would silently get the value captured when this module was first imported.
  return `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/system-health/workspace/${workspaceId}?page=${page}`;
}

function runUrl(workspaceId: string, suffix: string) {
  return `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/system-health/workspace/${workspaceId}${suffix}`;
}

export function SystemHealthDrilldownView({ workspaceId }: Props) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(HISTORY_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  // Bumped by the run and retry handlers to ask for a reload. They do NOT call
  // the fetch themselves: a handler closes over the page that was showing when
  // its button was clicked, so a reload it issued directly would repaint that
  // page's rows under whatever label the pager has since moved to.
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  // A different workspace has a different number of pages, so carrying the page
  // number across would request page N of a workspace that has one. Adjusted
  // during render rather than in an effect: an effect would let the fetch below
  // run once for the new workspace paired with the old page number, firing a
  // request that is cancelled a commit later and answered by nobody.
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState(workspaceId);
  if (workspaceId !== loadedWorkspaceId) {
    setLoadedWorkspaceId(workspaceId);
    setPage(1);
  }

  useEffect(() => {
    // A page change or an unmount cancels the request it supersedes, so the
    // three writers to `runs` can never land out of order.
    let cancelled = false;

    (async () => {
      try {
        const res = await axios.get(historyUrl(workspaceId, page));
        if (cancelled) return;
        setRuns(res.data.runs ?? []);
        setSchedules(res.data.schedules ?? []);
        setTotal(res.data.total ?? 0);
        setPageSize(res.data.pageSize ?? HISTORY_PAGE_SIZE);
        setLoadError(null);
      } catch {
        // Keep whatever rows are already on screen — a failed refresh should
        // not blank a troubleshooting screen someone is reading, matching the
        // same choice in use-system-health.ts.
        if (!cancelled) setLoadError("Could not load run history for this workspace.");
      } finally {
        // Only ever gates the *first* render: nothing here sets loading back to
        // true on a refresh, so a refetch after a run leaves existing rows on
        // screen instead of blanking them.
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, page, reloadToken]);

  const start = useCallback(
    async (force: boolean) => {
      setBusy(true);
      setRunError(null);
      try {
        await axios.post(runUrl(workspaceId, `/run${force ? "?force=1" : ""}`), { kind: "invoice" });
        setRefusal(null);
        reload();
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
    [workspaceId, reload],
  );

  const retry = useCallback(
    async (runId: string) => {
      setRetryingId(runId);
      setRunError(null);
      try {
        await axios.post(runUrl(workspaceId, `/runs/${runId}/retry`));
        // The retry has changed the history, so a refusal card describing the
        // period as already-run is now stale advice about a stale history.
        setRefusal(null);
        reload();
      } catch {
        setRunError("Could not retry the run. Try again.");
      } finally {
        setRetryingId(null);
      }
    },
    [workspaceId, reload],
  );

  if (loading) return <Spinner />;

  // One dispatch at a time: a forced re-run fired during a retry, or a retry
  // during a run, would race for the same period.
  const dispatching = busy || retryingId !== null;

  return (
    <div className="space-y-6">
      {loadError ? <ErrorBanner message={loadError} /> : null}

      <ScheduleSummary schedules={schedules} />

      <div className="flex items-center gap-3">
        <Button type="button" disabled={dispatching} onClick={() => start(false)}>
          Run invoices now
        </Button>
      </div>

      {runError ? <ErrorBanner message={runError} /> : null}

      {refusal ? (
        <Card className="space-y-2 border-amber-500/40 p-4">
          <p className="text-sm">
            Already run for {refusal.periodKey} — {refusal.runs.length} run(s) recorded.
          </p>
          <Button
            type="button"
            variant="destructive"
            disabled={dispatching}
            onClick={() => start(true)}
          >
            Force re-run
          </Button>
        </Card>
      ) : null}

      <RunList runs={runs} onRetry={retry} retryingId={retryingId} dispatching={dispatching} />

      {/* Gated on `total`, not on the rows returned: a page that comes back
          empty still needs the Previous button that is the only way off it. */}
      {total > 0 ? (
        <RunHistoryPager page={page} pageSize={pageSize} total={total} onChange={setPage} />
      ) : null}
    </div>
  );
}
