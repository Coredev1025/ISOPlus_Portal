"use client";

import { Card } from "@/components/ui/card";
import { formatStartedAt } from "@/lib/system-health-helpers";
import type { ScheduleRow } from "@/lib/system-health-types";

type Props = Readonly<{ schedules: readonly ScheduleRow[] }>;

/**
 * Why a client is quiet, not just that it is. missedRuns and
 * consecutiveFailures are what an operator needs first; lastError only when
 * there is one to show, matching the run row's error footer.
 */
export function ScheduleSummary({ schedules }: Props) {
  if (schedules.length === 0) return null;

  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-sm font-semibold">Schedule</h2>
      <ul className="space-y-2 text-sm">
        {schedules.map((schedule) => (
          <li key={schedule.kind} className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <span className="font-medium">{schedule.kind}</span>
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
                <span>{schedule.enabled ? "Enabled" : "Disabled"}</span>
                <span>Missed runs: {schedule.missedRuns}</span>
                <span>Consecutive failures: {schedule.consecutiveFailures}</span>
                <span>Next run: {formatStartedAt(schedule.nextRunAt)}</span>
                <span>Last run: {formatStartedAt(schedule.lastRunAt)}</span>
              </span>
            </div>
            {schedule.lastError ? (
              <p className="text-xs text-destructive">{schedule.lastError}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
