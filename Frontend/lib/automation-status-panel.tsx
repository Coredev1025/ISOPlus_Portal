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
  const lastOutcome = block.lastRunAt
    ? `${formatNextRun(block.lastRunAt)} — ${blockNeedsAttention(block) ? "Failed" : "Succeeded"}`
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
        Next run: {formatNextRun(block.nextRun)}
      </span>
      <span className="text-[12px] text-muted-foreground">
        Last run: {lastOutcome}
      </span>
    </div>
  );
}

// Named `doc`, not `document`: this module's tests stub `document.elementFromPoint`,
// and a prop that shadows the global is one rename away from a confusing failure.
function RecentDocumentRow({ doc }: Readonly<{ doc: AutomationRecentDocument }>) {
  const delivery = deliveryStatus(doc);

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
      <span className="text-muted-foreground">
        {formatNextRun(doc.createdAt)}
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

type AutomationStatusPanelProps = Readonly<{
  invoice: AutomationBlock;
  statement: AutomationBlock;
  recentDocuments: readonly AutomationRecentDocument[];
}>;

export function AutomationStatusPanel({
  invoice,
  statement,
  recentDocuments,
}: AutomationStatusPanelProps) {
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

        {recentDocuments.length > 0 ? (
          <div className="mt-4 border-t pt-3">
            <h4 className="mb-1.5 text-xs font-semibold text-muted-foreground">
              Recent documents
            </h4>
            <ul className="space-y-1">
              {recentDocuments.map((doc) => (
                <RecentDocumentRow key={doc.pdfUrl} doc={doc} />
              ))}
            </ul>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
