"use client";

import { formatDistanceToNow } from "date-fns";
import { useRouter } from "next/navigation";

import { Card } from "@/components/ui/card";
import Spinner from "@/components/ui/spin";
import { SCHEDULER_HEARTBEAT_NEVER_TICKED } from "@/constants/system-health";
import { useSystemHealth } from "@/lib/use-system-health";
import { formatErrorRate } from "@/lib/system-health-helpers";
import { SystemHealthConnectionGrid } from "@/lib/system-health-connection-grid";
import { ErrorBanner } from "@/lib/system-health-banners";

function Tile({ label, value, hint }: Readonly<{ label: string; value: string; hint?: string }>) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

/**
 * A stopped scheduler is the failure every other tile on this screen hides:
 * with no ticks, runsToday and the error rate are both legitimately zero, so
 * this has to be prominent rather than a footnote. `lastTickAt === null`
 * means the scheduler has never ticked in this environment at all, which is
 * usually a missing or misconfigured EventBridge rule (docs/scheduling.md).
 */
function SchedulerHeartbeat({ lastTickAt }: Readonly<{ lastTickAt: string | null }>) {
  if (!lastTickAt) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium">
        {SCHEDULER_HEARTBEAT_NEVER_TICKED}
      </p>
    );
  }

  return (
    <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
      Scheduler last ticked {formatDistanceToNow(new Date(lastTickAt), { addSuffix: true })}.
    </p>
  );
}

export function SystemHealthPageView() {
  const router = useRouter();
  const { overview, clients, loading, error } = useSystemHealth();

  if (loading && !overview) return <Spinner />;

  const queue = overview?.queue;
  const queueValue = queue?.available === false ? "Queue unavailable" : String(queue?.total ?? 0);

  return (
    <div className="space-y-6">
      {error ? <ErrorBanner message={error} /> : null}

      <SchedulerHeartbeat lastTickAt={overview?.lastTickAt ?? null} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Active automations" value={String(overview?.activeAutomations ?? 0)} />
        <Tile
          label="Runs today"
          value={String(overview?.runsToday ?? 0)}
          hint={`${overview?.succeeded ?? 0} succeeded, ${overview?.failed ?? 0} failed · ${overview?.runsThisWeek ?? 0} this week`}
        />
        <Tile
          label={`Error rate (${overview?.errorRateWindowHours ?? 24}h)`}
          value={formatErrorRate(overview?.errorRate24h)}
        />
        <Tile
          label="Queue"
          value={queueValue}
          hint={queue?.backlogged ? "Backlog building up" : undefined}
        />
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Connections</h2>
        <SystemHealthConnectionGrid
          clients={clients}
          onSelect={(workspaceId) => router.push(`/workspace/${workspaceId}/system-health`)}
        />
      </section>

      {/* Real figures, not a notice. The paragraph that used to sit here said
          delivery reporting did not exist — true when it was written, stale
          once the SES event pipeline landed, and indistinguishable to an
          operator from "nothing bounced". Zero is now shown as zero. */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Bounces &amp; complaints</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Tile
            label={`Bounced (${overview?.delivery?.windowHours ?? 168}h)`}
            value={String(overview?.delivery?.bounced ?? 0)}
            hint="Delivery refused by the recipient's mail server"
          />
          <Tile
            label={`Complaints (${overview?.delivery?.windowHours ?? 168}h)`}
            value={String(overview?.delivery?.complained ?? 0)}
            hint="Marked as spam by the recipient"
          />
        </div>
      </section>
    </div>
  );
}
