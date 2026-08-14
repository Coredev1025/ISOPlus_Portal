"use client";

import { useCallback, useEffect, useState } from "react";

import axios from "@/app/utils/axiosConfig";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatDuration, runStatusLabel } from "@/lib/system-health-helpers";
import type { RunRow } from "@/lib/system-health-types";

type Refusal = { periodKey: string; runs: RunRow[] } | null;

type Props = Readonly<{ workspaceId: string }>;

export function SystemHealthDrilldownView({ workspaceId }: Props) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [refusal, setRefusal] = useState<Refusal>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await axios.get(
      `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/system-health/workspace/${workspaceId}`,
    );
    setRuns(res.data.runs ?? []);
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  const start = useCallback(
    async (force: boolean) => {
      setBusy(true);
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
        // offer the override rather than silently doing nothing.
        if (response?.status === 409 && response.data) setRefusal(response.data);
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, load],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button type="button" disabled={busy} onClick={() => start(false)}>
          Run invoices now
        </Button>
      </div>

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
    </div>
  );
}
