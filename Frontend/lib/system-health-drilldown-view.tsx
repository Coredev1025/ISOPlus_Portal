"use client";

import { useCallback, useEffect, useState } from "react";

import axios from "@/app/utils/axiosConfig";
import Spinner from "@/components/ui/spin";
import { HISTORY_PAGE_SIZE } from "@/constants/system-health";
import { ErrorBanner } from "@/lib/system-health-banners";
import { RunHistoryPager } from "@/lib/system-health-pager";
import { RunList } from "@/lib/system-health-run-row";
import { ScheduleSummary } from "@/lib/system-health-schedule-summary";
import type { RunEmailRow, RunRow, ScheduleRow } from "@/lib/system-health-types";

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
  // Fetched per run, on request. Keyed by run id so an expanded row keeps its
  // messages while another is opened.
  const [emailsByRun, setEmailsByRun] = useState<Record<string, RunEmailRow[] | undefined>>({});
  const [emailsLoadingId, setEmailsLoadingId] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(HISTORY_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  // Bumped by the retry handler to ask for a reload. It does NOT call the
  // fetch itself: the handler closes over the page that was showing when its
  // button was clicked, so a reload it issued directly would repaint that
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

  const retry = useCallback(
    async (runId: string) => {
      setRetryingId(runId);
      setRunError(null);
      try {
        await axios.post(runUrl(workspaceId, `/runs/${runId}/retry`));
        reload();
      } catch {
        setRunError("Could not retry the run. Try again.");
      } finally {
        setRetryingId(null);
      }
    },
    [workspaceId, reload],
  );

  /**
   * Fetch one run's emails, or collapse them again.
   *
   * Kept out of the history request on purpose: 50 runs times their messages
   * would make the page that answers "what happened lately" pay for detail an
   * operator wants one row at a time. A failed fetch collapses rather than
   * leaving a spinner — the run row itself is still useful.
   */
  const toggleEmails = useCallback(
    async (runId: string) => {
      if (emailsByRun[runId]) {
        setEmailsByRun((current) => ({ ...current, [runId]: undefined }));
        return;
      }

      setEmailsLoadingId(runId);
      try {
        const res = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/system-health/workspace/${workspaceId}/runs/${runId}/emails`,
        );
        setEmailsByRun((current) => ({ ...current, [runId]: res.data?.emails ?? [] }));
      } catch {
        setEmailsByRun((current) => ({ ...current, [runId]: undefined }));
      } finally {
        setEmailsLoadingId(null);
      }
    },
    [emailsByRun, workspaceId],
  );

  if (loading) return <Spinner />;

  // KAN-230 removed the manual run buttons, so a retry is the only dispatch
  // this screen can start. The name is kept because RunList reads it as "is
  // anything in flight" when deciding whether to offer Retry at all.
  const dispatching = retryingId !== null;

  return (
    <div className="space-y-6">
      {loadError ? <ErrorBanner message={loadError} /> : null}

      <ScheduleSummary schedules={schedules} />

      {runError ? <ErrorBanner message={runError} /> : null}

      <RunList
        runs={runs}
        schedules={schedules}
        onRetry={retry}
        retryingId={retryingId}
        dispatching={dispatching}
        emailsByRun={emailsByRun}
        emailsLoadingId={emailsLoadingId}
        onToggleEmails={toggleEmails}
      />

      {/* Gated on `total`, not on the rows returned: a page that comes back
          empty still needs the Previous button that is the only way off it. */}
      {total > 0 ? (
        <RunHistoryPager page={page} pageSize={pageSize} total={total} onChange={setPage} />
      ) : null}
    </div>
  );
}
