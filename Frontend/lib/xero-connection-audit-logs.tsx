"use client";

import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import axios from "@/app/utils/axiosConfig";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import Spinner from "@/components/ui/spin";
import { AUDIT_CATEGORY_XERO } from "@/constants/audit";
import { formatDateTimeDDMMYYYY } from "@/lib/timezone";
import {
  mapXeroAuditItems,
  type XeroAuditLogItem,
} from "@/lib/xero-connection-audit-logs-helpers";

type XeroConnectionAuditLogsProps = Readonly<{
  workspaceId: string;
  timezone?: string;
  reloadKey?: string | number | boolean;
}>;

function ActivityBadge({ success }: { success: boolean }) {
  if (success) {
    return (
      <Badge className="border-green-600 bg-green-600 text-white hover:bg-green-600/90">
        Success
      </Badge>
    );
  }
  return <Badge variant="destructive">Failed</Badge>;
}

function LogsTable({
  items,
  timezone,
}: {
  items: XeroAuditLogItem[];
  timezone: string;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>User</TableHead>
          <TableHead>Detail</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {formatDateTimeDDMMYYYY(entry.createdAt, timezone) || "—"}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap items-center gap-2">
                <ActivityBadge success={entry.success} />
                <span>{entry.action}</span>
              </div>
            </TableCell>
            <TableCell>{entry.user || "—"}</TableCell>
            <TableCell className="break-words">{entry.detail}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function XeroConnectionAuditLogs({
  workspaceId,
  timezone = "Australia/Sydney",
  reloadKey = 0,
}: XeroConnectionAuditLogsProps) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<XeroAuditLogItem[]>([]);

  useEffect(() => {
    const abort = new AbortController();
    const run = async () => {
      try {
        setLoading(true);
        const response = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/audit/`,
          {
            params: {
              workspaceId,
              category: AUDIT_CATEGORY_XERO,
              sortBy: "createdAt",
              sortOrder: "desc",
              limit: 50,
            },
            signal: abort.signal,
          }
        );
        setItems(mapXeroAuditItems(response.data?.items));
      } catch (error: unknown) {
        const err = error as { name?: string };
        if (err.name === "CanceledError" || err.name === "AbortError") return;
        setItems([]);
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    };
    run();
    return () => abort.abort();
  }, [workspaceId, reloadKey]);

  let body = (
    <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
      No connection events yet.
    </p>
  );
  if (loading) {
    body = (
      <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
        <Spinner />
        <span>Loading activity…</span>
      </div>
    );
  } else if (items.length > 0) {
    body = <LogsTable items={items} timezone={timezone} />;
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <ScrollText className="h-4 w-4 text-muted-foreground" />
        <h5 className="text-[13px] font-semibold">Connection activity</h5>
      </div>
      <p className="mb-3 text-[12.5px] text-muted-foreground">
        Recent Xero events from the workspace audit log, filtered by category.
      </p>
      {body}
    </div>
  );
}
