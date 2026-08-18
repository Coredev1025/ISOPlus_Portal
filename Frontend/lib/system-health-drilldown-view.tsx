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

const BASE = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/system-health/workspace`;

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

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`${BASE}/${workspaceId}?page=${page}`);
      setRuns(res.data.runs ?? []);
      setSchedules(res.data.schedules ?? []);
      setTotal(res.data.total ?? 0);
      setPageSize(res.data.pageSize ?? HISTORY_PAGE_SIZE);
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
  }, [workspaceId, page]);

  useEffect(() => {
    load();
  }, [load]);

  const start = useCallback(
    async (force: boolean) => {
      setBusy(true);
      setRunError(null);
      try {
        const query = force ? "?force=1" : "";
        await axios.post(`${BASE}/${workspaceId}/run${query}`, { kind: "invoice" });
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

  const retry = useCallback(
    async (runId: string) => {
      setRetryingId(runId);
      setRunError(null);
      try {
        await axios.post(`${BASE}/${workspaceId}/runs/${runId}/retry`);
        // Reload rather than patching the row in place: the retry creates a
        // fresh run, so the history is the thing that changed, not this row.
        await load();
      } catch {
        setRunError("Could not retry the run. Try again.");
      } finally {
        setRetryingId(null);
      }
    },
    [workspaceId, load],
  );

  if (loading) return <Spinner />;

  return (
    <div className="space-y-6">
      {loadError ? <ErrorBanner message={loadError} /> : null}

      <ScheduleSummary schedules={schedules} />

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

      <RunList runs={runs} onRetry={retry} retryingId={retryingId} />

      {runs.length > 0 ? (
        <RunHistoryPager page={page} pageSize={pageSize} total={total} onChange={setPage} />
      ) : null}
    </div>
  );
}
