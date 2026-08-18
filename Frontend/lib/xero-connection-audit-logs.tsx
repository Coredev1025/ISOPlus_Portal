"use client";

import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import axios from "@/app/utils/axiosConfig";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import Spinner from "@/components/ui/spin";
import { PaginationControls } from "@/lib/pagination-controls";
import { formatDateTimeDDMMYYYY } from "@/lib/timezone";
import {
  buildXeroAuditListParams,
  parseXeroAuditListResponse,
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

function LogsDialogBody({
  loading,
  items,
  timezone,
  page,
  totalPages,
  onPageChange,
}: {
  loading: boolean;
  items: XeroAuditLogItem[];
  timezone: string;
  page: number;
  totalPages: number;
  onPageChange: (nextPage: number) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
        <Spinner />
        <span>Loading activity…</span>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
        No connection events yet.
      </p>
    );
  }
  return (
    <>
      <div className="max-h-[50vh] overflow-auto">
        <LogsTable items={items} timezone={timezone} />
      </div>
      <PaginationControls
        currentPage={page}
        totalPages={totalPages}
        onPageChange={onPageChange}
      />
    </>
  );
}

async function fetchXeroAuditPage(
  workspaceId: string,
  page: number,
  signal: AbortSignal
) {
  const response = await axios.get(
    `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/audit/`,
    {
      params: buildXeroAuditListParams({ workspaceId, page }),
      signal,
    }
  );
  return parseXeroAuditListResponse(response.data);
}

function isAbortError(error: unknown) {
  const err = error as { name?: string };
  return err.name === "CanceledError" || err.name === "AbortError";
}

export function XeroConnectionAuditLogs({
  workspaceId,
  timezone = "Australia/Sydney",
  reloadKey = 0,
}: XeroConnectionAuditLogsProps) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<XeroAuditLogItem[]>([]);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setLoading(true);
    const run = async () => {
      try {
        const parsed = await fetchXeroAuditPage(workspaceId, page, abort.signal);
        setItems(parsed.items);
        setTotalPages(parsed.totalPages);
      } catch (error: unknown) {
        if (isAbortError(error)) return;
        setItems([]);
        setTotalPages(1);
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    };
    run();
    return () => abort.abort();
  }, [open, page, workspaceId, reloadKey]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setPage(1);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <ScrollText className="h-4 w-4" />
          View Xero logs
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] max-w-4xl sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Xero logs</DialogTitle>
          <DialogDescription>
            All Xero events from the workspace audit log, newest first.
          </DialogDescription>
        </DialogHeader>
        <LogsDialogBody
          loading={loading}
          items={items}
          timezone={timezone}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      </DialogContent>
    </Dialog>
  );
}
