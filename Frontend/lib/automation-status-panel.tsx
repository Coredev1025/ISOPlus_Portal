"use client";

import { Activity } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  blockNeedsAttention,
  deliveryStatus,
  documentHref,
  formatNextRun,
  recentDocumentLabel,
} from "@/lib/automation-helpers";
import type {
  AutomationBlock,
  AutomationRecentDocument,
} from "@/lib/automation-settings";

type StatusTone = "ok" | "warn" | "bad" | "muted";

/**
 * The badge mirrors the enable switch and the last run's outcome — the spec's
 * On track / Attention needed / Paused triple. A paused block never needs
 * attention: it is not running, which is exactly what its owner asked for.
 */
function blockStatus(block: AutomationBlock): { label: string; tone: StatusTone } {
  if (!block.enabled) return { label: "Paused", tone: "muted" };
  if (blockNeedsAttention(block)) return { label: "Attention needed", tone: "bad" };
  return { label: "On track", tone: "ok" };
}

const TONE_CLASS: Record<StatusTone, string> = {
  ok: "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  bad: "border-destructive/40 bg-destructive/10 text-destructive",
  muted: "border-border bg-muted text-muted-foreground",
};

function StatusRow({
  title,
  block,
}: Readonly<{ title: string; block: AutomationBlock }>) {
  const status = blockStatus(block);
  // Both instants are read in the schedule's own zone, so this row cannot
  // disagree with the Run At field in the block below it.
  const lastOutcome = block.lastRunAt
    ? `${formatNextRun(block.lastRunAt, block.timezone)} — ${blockNeedsAttention(block) ? "Failed" : "Succeeded"}`
    : "—";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="w-24 text-[12.5px] font-semibold">{title}</span>
      <span
        className={cn(
          "rounded-full border px-2 py-0.5 text-[11px] font-semibold",
          TONE_CLASS[status.tone]
        )}
      >
        {status.label}
      </span>
      <span className="text-[12px] text-muted-foreground">
        Next run: {formatNextRun(block.nextRun, block.timezone)}
      </span>
      <span className="text-[12px] text-muted-foreground">
        Last run: {lastOutcome}
      </span>
    </div>
  );
}

/**
 * The recipient to print beside a document, or null when there is nothing to
 * add.
 *
 * Epic 5 asks each recent send to name its recipient. `participant` is the
 * closest thing stored: the client the document was raised for, and the
 * profile the send address is read from.
 *
 * It is deliberately NOT presented as the recipient. With Recipient set to
 * Billing Contact the address comes from that profile's Billing Email, which
 * may be a different person's mailbox — so "For <name>" is the whole of what
 * this data supports. The mailbox actually written to is not recorded
 * anywhere; naming it is a follow-up, not something to imply here.
 *
 * Null when it would duplicate the row's own label: `recentDocumentLabel`
 * falls back to the participant for a statement that carries no number, and
 * the same name twice on one row reads as two different facts.
 */
function clientLabel(doc: AutomationRecentDocument): string | null {
  const participant = doc.participant?.trim();
  if (!participant) return "No client recorded";
  return participant === recentDocumentLabel(doc) ? null : `For ${participant}`;
}

// Named `doc`, not `document`: this module's tests stub `document.elementFromPoint`,
// and a prop that shadows the global is one rename away from a confusing failure.
function RecentDocumentRow({
  doc,
  timeZone,
}: Readonly<{ doc: AutomationRecentDocument; timeZone?: string }>) {
  const delivery = deliveryStatus(doc);
  const client = clientLabel(doc);

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px]">
      <a
        href={documentHref(doc.pdfUrl)}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-primary hover:underline"
      >
        {recentDocumentLabel(doc)}
      </a>
      <span className="text-muted-foreground">{doc.type}</span>
      {/* Who it is for — not who it was emailed to; see `clientLabel`.
          Suppressed when the label already IS the participant — an unnumbered
          statement falls back to it — so the row does not print the same name
          twice. */}
      {client ? (
        <span className="text-muted-foreground">{client}</span>
      ) : null}
      <span className="text-muted-foreground">
        {formatNextRun(doc.createdAt, timeZone)}
      </span>
      {/* Labelled rather than left as a bare word: out of context "Bounced"
          tells a screen-reader user nothing about what it describes. */}
      <span
        aria-label={`Delivery status: ${delivery.label}`}
        className={cn(
          "rounded-full border px-2 py-0.5 text-[10.5px] font-medium",
          TONE_CLASS[delivery.tone]
        )}
      >
        {delivery.label}
      </span>
      {delivery.detail ? (
        // role="status" so the reason is announced when a poll turns a
        // "Sent" row into a bounce, rather than changing silently. It sits on
        // the same row as the document it explains — the client has to know
        // WHICH send to chase, and which address to correct.
        <span role="status" className="w-full text-[11.5px] text-destructive">
          {delivery.detail}
        </span>
      ) : null}
    </li>
  );
}

/**
 * The two operational signals from `GET /automation-settings`'s `health` block.
 *
 * `queueBacklogged` is a boolean rather than a depth on purpose: the queue is
 * global across tenants, so the count would disclose other clients' volume.
 * The client only needs the part they can act on — that a run may be late.
 */
export type AutomationHealth = {
  queueBacklogged: boolean;
  queueAvailable: boolean;
  accounting: string;
};

type AutomationStatusPanelProps = Readonly<{
  invoice: AutomationBlock;
  statement: AutomationBlock;
  recentDocuments: readonly AutomationRecentDocument[];
  /** Absent on a response from a backend that predates the health block. */
  health?: AutomationHealth;
}>;

/**
 * The conditions worth interrupting a client about, and nothing else.
 *
 * `disconnected` is deliberately silent: plenty of workspaces never connect an
 * accounting platform, and nagging them about a feature they do not use is how
 * a status panel teaches people to ignore it. `needs_reauth` is the opposite —
 * they had it working, it lapsed, and only they can restore it.
 */
function healthNotices(health: AutomationHealth | undefined): string[] {
  if (!health) return [];
  const notices: string[] = [];
  if (health.queueBacklogged) {
    notices.push("The automation queue is busy, so a run may start later than its scheduled time.");
  }
  if (health.accounting === "needs_reauth") {
    notices.push("Your accounting platform connection has expired — reconnect it or invoices cannot be sent there.");
  }
  return notices;
}

export function AutomationStatusPanel({
  invoice,
  statement,
  recentDocuments,
  health,
}: AutomationStatusPanelProps) {
  const notices = healthNotices(health);
  return (
    <section aria-labelledby="automation-status-heading">
      <Card className="border p-5 shadow-sm">
        <div className="mb-3 flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Activity className="h-4 w-4" />
          </div>
          <div>
            <h3
              id="automation-status-heading"
              className="text-[14.5px] font-bold leading-tight"
            >
              Automation Status
            </h3>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Whether your automation is healthy, and the documents it produced
              most recently.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <StatusRow title="Invoices" block={invoice} />
          <StatusRow title="Statements" block={statement} />
        </div>

        {/* Operational conditions the schedule rows cannot express: a backlogged
            queue and a lapsed accounting connection both leave a block reading
            "On track" while nothing actually arrives. role="status" so a poll
            that surfaces one announces it. */}
        {notices.length > 0 ? (
          <ul role="status" className="mt-3 space-y-1">
            {notices.map((notice) => (
              <li key={notice} className="text-[12px] text-amber-700 dark:text-amber-400">
                {notice}
              </li>
            ))}
          </ul>
        ) : null}

        {recentDocuments.length > 0 ? (
          <div className="mt-4 border-t pt-3">
            <h4 className="mb-1.5 text-xs font-semibold text-muted-foreground">
              Recent documents
            </h4>
            <ul className="space-y-1">
              {recentDocuments.map((doc) => (
                <RecentDocumentRow
                  key={doc.pdfUrl}
                  doc={doc}
                  timeZone={invoice.timezone ?? statement.timezone}
                />
              ))}
            </ul>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
