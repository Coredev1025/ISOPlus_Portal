"use client";

import { Badge } from "@/components/ui/badge";
import { CONNECTION_LABELS } from "@/constants/system-health";
import { sortClientsBySeverity } from "@/lib/system-health-helpers";
import type { ClientRow } from "@/lib/system-health-types";

const VARIANT: Record<ClientRow["connection"], "default" | "secondary" | "destructive"> = {
  connected: "secondary",
  disconnected: "destructive",
  needs_reauth: "destructive",
};

type Props = Readonly<{
  clients: readonly ClientRow[];
  onSelect: (workspaceId: string) => void;
}>;

export function SystemHealthConnectionGrid({ clients, onSelect }: Props) {
  if (clients.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No workspace has Invoice &amp; Statement Automation enabled yet.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {sortClientsBySeverity(clients).map((client) => (
        <li key={client.workspaceId}>
          <button
            type="button"
            onClick={() => onSelect(client.workspaceId)}
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50"
          >
            <span className="text-sm font-medium">{client.workspaceId}</span>
            <span className="flex items-center gap-2">
              <span className="text-xs uppercase text-muted-foreground">{client.provider}</span>
              <Badge variant={VARIANT[client.connection]}>
                {CONNECTION_LABELS[client.connection]}
              </Badge>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
