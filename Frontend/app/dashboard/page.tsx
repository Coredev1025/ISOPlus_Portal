"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRouter } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import Spinner from "@/components/ui/spin";
import React, { useCallback, useEffect, useRef, useState } from "react";
import axios from "@/app/utils/axiosConfig";
import { isAxiosError } from "axios";
import { Search, Terminal, Download, Filter, AlertTriangle, AlertCircle, Info, Bug, XCircle, ChevronRight, LayoutGrid, Activity } from "lucide-react";
import { Header } from "@/components/ui/header";
import { Card } from "@/components/ui/card";
import { XeroOAuthReturnBoundary } from "@/lib/xero-oauth-return-listener";
import { secureRandomFloat, secureRandomInt } from "@/lib/secure-random";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isOwnerOrSupport } from "@/lib/access";
import { SystemHealthPageView } from "@/lib/system-health-page-view";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppContext } from "../context";
import { PaginationNext, PaginationPrevious, PaginationItem, PaginationLink } from "@/components/ui/pagination";
import { showFetchSuccessToast, showFetchErrorToast, showSuccessToast, showErrorToast } from "@/lib/toast-utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { dedupeByKey } from "@/app/utils/requestDedupe";

interface ItemValue {
  attributeId: string;
  attributeName: string;
  attributeType: string;
  data: any;
}

interface LogMetadata {
  source?: string;
  ip?: string;
  email?: string;
  userId?: string;
  userRole?: string;
  timestamp?: string;
  level?: string;
  message?: string;
  errorType?: string;
  attributeId?: string;
  diagnosticInfo?: {
    attributeIdValid?: boolean;
    attributeIdFormat?: boolean;
    hasStatusCode?: boolean;
    hasResponseData?: boolean;
    hasRequestPayload?: boolean;
    timestamp?: string;
  };
  apiContext?: {
    statusCode?: number;
    responseData?: any;
    requestPayload?: any;
    errorDetails?: any;
  };
  requestContext?: {
    method?: string;
    url?: string;
    userAgent?: string;
    referer?: string;
    workspaceId?: string;
    boardId?: string;
  };
  stackTrace?: string;
  operationType?: string;
  operation?: string;
  success?: boolean;
  requestId?: string;
  itemValues?: ItemValue[];
  uploadDetails?: {
    uploadId?: string;
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
  };
  [key: string]: any;
}

interface Log {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  source: string;
  details: {
    metadata: LogMetadata;
  };
};

function filenameFromContentDisposition(cd: string | undefined): string {
  if (!cd) return "portal-users.csv";
  const star = /filename\*=(?:UTF-8'')?([^;\n]+)/i.exec(cd);
  if (star?.[1]) {
    const v = star[1].trim().replace(/^["']|["']$/g, "");
    try {
      return decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      return v;
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(cd);
  if (quoted?.[1]) return quoted[1];
  const single = /filename='([^']+)'/i.exec(cd);
  if (single?.[1]) return single[1];
  return "portal-users.csv";
}

async function messageFromUserExportAxiosError(err: unknown): Promise<string> {
  if (!isAxiosError(err) || !err.response) {
    return isAxiosError(err) && err.message ? err.message : "Failed to export users.";
  }
  const { status, data } = err.response;
  if (data instanceof Blob) {
    try {
      const t = await data.text();
      const j = JSON.parse(t) as { message?: string };
      if (j?.message) return j.message;
    } catch {
    }
  }
  if (status === 401) return "Authentication required. Please sign in again.";
  if (status === 403) return "You don't have permission to export users.";
  if (status === 502) return "Could not reach ISO+™ while building the export. Try again later.";
  if (status === 500) return "Server error while exporting. Try again later.";
  return "Failed to export users.";
}

// Mock data for audit trail
const generateAuditTrail = () => Array.from({ length: 50 }, (_, i) => {
  const date = new Date();
  date.setHours(date.getHours() - i);

  const actions = [
    "Created new board",
    "Updated board settings",
    "Deleted board",
    "Added user to workspace",
    "Removed user from workspace",
    "Updated workspace settings",
    "Generated PDF document",
    "Updated business configuration",
    "Connected accounting integration",
    "Updated integration settings"
  ];

  const users = [
    "john.doe@example.com",
    "jane.smith@example.com",
    "mike.wilson@example.com",
    "sarah.johnson@example.com"
  ];

  return {
    id: `audit - ${i + 1} `,
    timestamp: date.toISOString(),
    action: actions[secureRandomInt(actions.length)],
    user: users[secureRandomInt(users.length)],
    ipAddress: `192.168.${secureRandomInt(255)}.${secureRandomInt(255)} `,
    details: {
      resourceId: `resource - ${secureRandomInt(1000)} `,
      changes: secureRandomFloat() > 0.5 ? { before: "old value", after: "new value" } : null
    }
  };
});

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: 'text-blue-600 bg-blue-50 dark:text-blue-400 dark:bg-blue-900/20',
  INFO: 'text-green-600 bg-green-50 dark:text-green-400 dark:bg-green-900/20',
  WARN: 'text-yellow-600 bg-yellow-50 dark:text-yellow-400 dark:bg-yellow-900/20',
  ERROR: 'text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-900/20',
  FATAL: 'text-purple-600 bg-purple-50 dark:text-purple-400 dark:bg-purple-900/20'
};

const LOG_LEVEL_ICONS: Record<LogLevel, React.ReactNode> = {
  DEBUG: <Bug className="h-4 w-4" />,
  INFO: <Info className="h-4 w-4" />,
  WARN: <AlertTriangle className="h-4 w-4" />,
  ERROR: <AlertCircle className="h-4 w-4" />,
  FATAL: <XCircle className="h-4 w-4" />
};

function WorkspacesList() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const { user, workspaces, setWorkspaces } = useAppContext();
  const [isLoading, setLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const filteredWorkspaces = workspaces;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    if (!user?.id || !user?.role) return;

    let cancelled = false;
    const dedupeKey = `workspaces:first:${user.id}:${user.role}:${debouncedQuery}`;

    const fetchWorkspaces = async () => {
      setLoading(true);
      try {
        setWorkspaces([]);
        setHasMore(false);
        setNextAfter(null);

        const response = await dedupeByKey(dedupeKey, () =>
          axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces`, {
            withCredentials: true,
            params: {
              limit: 50,
              ...(debouncedQuery ? { q: debouncedQuery } : {}),
              ...(debouncedQuery ? { includeDetails: true } : {}),
            },
          })
        );

        if (cancelled) return;

        let sortedWorkspace: any[] = [];

        const workspaceList = response?.data?.workspace;
        if (!Array.isArray(workspaceList)) {
          throw new Error("Invalid workspaces response");
        }

        workspaceList.forEach((workspace: any) => {
          if ((user.role == "support_admin" || user.role == "owner" || workspace?.user_role == "owner" || workspace?.user_role == "admin" || workspace?.user_role == "restricted_member" || workspace?.user_role == "full_member")) {
            sortedWorkspace.push(workspace);
          }
        })

        sortedWorkspace = [...sortedWorkspace].sort((a, b) => a.name.localeCompare(b.name));

        setWorkspaces(sortedWorkspace);
        setHasMore(Boolean(response?.data?.hasMore));
        setNextAfter(response?.data?.nextAfter || null);

        if (!debouncedQuery && sortedWorkspace.length === 0) {
          router.replace("/access-denied");
          return;
        }

        showFetchSuccessToast("Workspaces");

        if (user.role === "isoplus_user" && sortedWorkspace.length === 1) {
          router.push(`/workspace/${sortedWorkspace[0].id}`);
        }
      } catch (error: any) {
        if (cancelled) return;
        if (error.name !== "CanceledError" && error.name !== "AbortError") {
          console.error("Error fetching workspaces:", error);
          showFetchErrorToast("workspaces", error.response?.data?.message || "Failed to load workspaces");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchWorkspaces();

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, router, setWorkspaces, user.id, user.role]);

  const loadMore = async () => {
    if (isLoadingMore) return;
    if (!hasMore) return;
    const after = nextAfter;
    if (!after) return;

    setIsLoadingMore(true);
    try {
      const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces`, {
        withCredentials: true,
        params: {
          limit: 50,
          after,
          ...(debouncedQuery ? { q: debouncedQuery } : {}),
          ...(debouncedQuery ? { includeDetails: true } : {}),
        }
      });

      const workspaceList = response?.data?.workspace;
      if (!Array.isArray(workspaceList)) {
        throw new Error("Invalid workspaces response");
      }

      const allowed = workspaceList.filter((workspace: any) =>
        (user.role == "support_admin" || user.role == "owner" || workspace?.user_role == "owner" || workspace?.user_role == "admin" || workspace?.user_role == "restricted_member" || workspace?.user_role == "full_member")
      );

      const merged = [...workspaces, ...allowed];
      const deduped = Array.from(new Map(merged.map((w: any) => [String(w.id), w])).values());
      const sorted = [...deduped].sort((a: any, b: any) => (a?.name || '').localeCompare(b?.name || ''));

      setWorkspaces(sorted);
      setHasMore(Boolean(response?.data?.hasMore));
      setNextAfter(response?.data?.nextAfter || null);
    } catch (error: any) {
      console.error("Error fetching more workspaces:", error);
      showFetchErrorToast("workspaces", error.response?.data?.message || "Failed to load more workspaces");
    } finally {
      setIsLoadingMore(false);
    }
  };

  return (
    <Card className="overflow-hidden border-border/80 p-6 shadow-sm sm:p-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <LayoutGrid className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <h3 className="text-lg font-semibold tracking-tight sm:text-xl">Workspaces</h3>
            <p className="text-sm text-muted-foreground">
              Open a workspace to manage boards and settings
            </p>
          </div>
        </div>
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            placeholder="Search by ID or name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-10 border-border/80 pl-9"
            aria-label="Search workspaces"
          />
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-muted/20">
        <Table>
          <TableHeader>
            <TableRow className="border-border/60 hover:bg-transparent">
              <TableHead className="w-[28%] font-medium">Workspace ID</TableHead>
              <TableHead className="font-medium">Name</TableHead>
              <TableHead className="w-[160px] text-right font-medium"> </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`sk-${i}`} className="border-border/40">
                  <TableCell><Skeleton className="h-4 w-full max-w-[140px]" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-3/4 max-w-[200px]" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="ml-auto h-8 w-24" /></TableCell>
                </TableRow>
              ))
            ) : (
              filteredWorkspaces.map((workspace) => (
                <TableRow
                  key={workspace.id}
                  className="group border-border/40 transition-colors hover:bg-muted/40"
                >
                  <TableCell className="font-mono text-xs text-muted-foreground sm:text-sm">
                    {workspace.id}
                  </TableCell>
                  <TableCell className="font-medium">{workspace.name}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1 text-primary hover:bg-primary/10 hover:text-primary"
                      onClick={() => router.push(`/workspace/${String(workspace.id).trim()}`)}
                    >
                      Open
                      <ChevronRight className="h-4 w-4 opacity-70 transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {!isLoading && filteredWorkspaces.length === 0 && (
        <div className="py-10 text-center text-sm text-muted-foreground">
          No workspaces match your search.
        </div>
      )}

      {hasMore && !isLoading && (
        <div className="flex justify-center border-t border-border/40 pt-6">
          <Button variant="outline" onClick={loadMore} disabled={isLoadingMore} className="min-w-[140px]">
            {isLoadingMore ? (
              <span className="inline-flex items-center gap-2">
                <Spinner />
                Loading…
              </span>
            ) : (
              "Load more"
            )}
          </Button>
        </div>
      )}
    </Card>
  );
}

function GlobalAuditTrail() {
  const [searchQuery, setSearchQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [userFilter, setUserFilter] = useState<string>("all");
  const [auditTrail] = useState(() => generateAuditTrail());

  // Get unique actions and users for filters
  const uniqueActions = Array.from(new Set(auditTrail.map(item => item.action)));
  const uniqueUsers = Array.from(new Set(auditTrail.map(item => item.user)));

  // Filter audit trail based on search and filters
  const filteredAuditTrail = auditTrail.filter(item => {
    const matchesSearch =
      item.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.user.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.ipAddress.includes(searchQuery);

    const matchesAction = actionFilter === "all" || item.action === actionFilter;
    const matchesUser = userFilter === "all" || item.user === userFilter;

    return matchesSearch && matchesAction && matchesUser;
  });

  return (
    <Card className="border-border/80 p-6 shadow-sm sm:p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Global Audit Trail</h1>
          <p className="text-muted-foreground">
            Track all activities and changes across all workspaces
          </p>
        </div>
        <Button variant="outline" className="gap-2">
          <Download className="h-4 w-4" />
          Export Audit Log
        </Button>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-wrap gap-4 mb-6">
        <div className="flex-1 min-w-[200px]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input
              placeholder="Search audit trail..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex gap-4">
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="w-[200px]">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Filter by action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Actions</SelectItem>
              {uniqueActions.map(action => (
                <SelectItem key={action} value={action}>{action}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={userFilter} onValueChange={setUserFilter}>
            <SelectTrigger className="w-[200px]">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Filter by user" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Users</SelectItem>
              {uniqueUsers.map(user => (
                <SelectItem key={user} value={user}>{user}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Audit Trail Table */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Timestamp</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>User</TableHead>
            <TableHead>IP Address</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredAuditTrail.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="whitespace-nowrap">
                {new Date(item.timestamp).toLocaleString('en-AU')}
              </TableCell>
              <TableCell>{item.action}</TableCell>
              <TableCell>{item.user}</TableCell>
              <TableCell className="font-mono">{item.ipAddress}</TableCell>
              <TableCell className="max-w-xs truncate">
                {item.details.changes ? (
                  <span className="text-muted-foreground">
                    Changed from &quot;{item.details.changes.before}&quot; to &quot;{item.details.changes.after}&quot;
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Resource ID: {item.details.resourceId}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function GlobalApplicationLogs() {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [logs, setLogs] = useState<Log[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [logsPerPage, setLogsPerPage] = useState(20);
  const [totalLogs, setTotalLogs] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [knownSources, setKnownSources] = useState<string[]>([]);
  const hasLoadedOnce = useRef(false);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchInput);
    }, 400);

    return () => clearTimeout(handler);
  }, [searchInput]);

  useEffect(() => {
    const abortController = new AbortController();

    const fetchLogs = async () => {
      setLoading(true);
      try {
        const params: Record<string, string | number> = {
          page: currentPage,
          limit: logsPerPage,
        };

        if (debouncedSearch) {
          params.search = debouncedSearch;
        }
        if (levelFilter !== "all") {
          params.level = levelFilter;
        }
        if (sourceFilter !== "all") {
          params.source = sourceFilter;
        }

        const response = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/log`,
          {
            params,
            signal: abortController.signal,
            withCredentials: true,
          }
        );

        const { items, total, page, totalPages: apiTotalPages } = response.data;

        const formattedLogs: Log[] = items.map((item: any, i: number) => ({
          id: item._id || `log-${(page - 1) * logsPerPage + i + 1}`,
          timestamp: item.timestamp,
          level: (item.level || '').toUpperCase(),
          message: item.message,
          source: item.metadata?.source || 'Unknown',
          details: {
            metadata: {
              ...(item.metadata || {})
            }
          }
        }));

        setLogs(formattedLogs);
        setTotalLogs(total);
        setTotalPages(apiTotalPages || Math.ceil(total / logsPerPage) || 1);

        if (page !== currentPage) {
          setCurrentPage(page);
        }

        setKnownSources((prev) => {
          const combined = new Set(prev);
          formattedLogs
            .map((log) => log.source)
            .filter((source): source is string => Boolean(source))
            .forEach((source) => combined.add(source));
          return Array.from(combined);
        });

        if (!hasLoadedOnce.current) {
          showFetchSuccessToast("Application logs");
          hasLoadedOnce.current = true;
        }
      } catch (error: any) {
        if (error.name !== "CanceledError" && error.name !== "AbortError") {
          console.error("Error fetching logs:", error);
          showFetchErrorToast("application logs", error.response?.data?.message || "Failed to load application logs");
        }
      }
      setLoading(false);
    };

    fetchLogs();

    return () => {
      abortController.abort();
      setLoading(false);
    };
  }, [currentPage, logsPerPage, debouncedSearch, levelFilter, sourceFilter]);

  const uniqueSources = knownSources.length
    ? knownSources
    : Array.from(new Set(logs.map(log => log.source).filter(Boolean)));

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    setCurrentPage(1);
  };

  const handleLevelFilterChange = (value: string) => {
    setLevelFilter(value);
    setCurrentPage(1);
  };

  const handleSourceFilterChange = (value: string) => {
    setSourceFilter(value);
    setCurrentPage(1);
  };

  const handleLogsPerPageChange = (value: number) => {
    setLogsPerPage(value);
    setCurrentPage(1);
  };

  return (
    <Card className="border-border/80 p-6 shadow-sm sm:p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Application Logs</h1>
          <p className="text-muted-foreground">
            Monitor system logs and debug application issues across all workspaces
          </p>
        </div>
        <Button variant="outline" className="gap-2 visible md:invisible">
          <Download className="h-4 w-4" />
          Export Logs
        </Button>
      </div>

      <div className="flex flex-wrap gap-4 mb-6">
        <div className="flex-1 min-w-[200px]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input
              placeholder="Search logs, or paste a workspace, board or period id…"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex gap-4">
          <Select value={levelFilter} onValueChange={handleLevelFilterChange}>
            <SelectTrigger className="w-[160px]">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Log level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Levels</SelectItem>
              {Object.keys(LOG_LEVEL_COLORS).map(level => (
                <SelectItem key={level} value={level}>{level}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sourceFilter} onValueChange={handleSourceFilterChange}>
            <SelectTrigger className="w-[200px]">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sources</SelectItem>
              {uniqueSources.map(source => (
                <SelectItem key={source as string} value={source as string}>{source}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Timestamp</TableHead>
            <TableHead>Level</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Message</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                <div className="inline-flex items-center gap-2">
                  <Spinner className="h-4 w-4" />
                  Loading logs...
                </div>
              </TableCell>
            </TableRow>
          ) : (logs.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                No logs found matching your search.
              </TableCell>
            </TableRow>
          ) : (
            logs.map((log) => (
              <React.Fragment key={log.id as string}>
                <TableRow
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id as string)}
                >
                  <TableCell className="whitespace-nowrap">
                    {new Date(log.timestamp as string).toLocaleString("en-AU")}
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${LOG_LEVEL_COLORS[log.level as LogLevel] || ''}`}>
                      {LOG_LEVEL_ICONS[log.level as LogLevel] || LOG_LEVEL_ICONS.INFO}
                      {log.level}
                    </span>
                  </TableCell>
                  <TableCell>{log.source}</TableCell>
                  <TableCell className="max-w-xl truncate">
                    {log.message}
                  </TableCell>
                </TableRow>
                {expandedLog === log.id && (
                  <TableRow>
                    <TableCell colSpan={4} className="bg-muted/30">
                      <div className="p-4 space-y-4">
                        <div>
                          <h4 className="text-sm font-medium mb-2">Metadata</h4>
                          <pre className="text-sm bg-muted p-2 rounded-md overflow-x-auto">
                            {JSON.stringify(log.details, null, 2)}
                          </pre>
                        </div>
                        
                        {/* Enhanced diagnostic information display */}
                        {log.details?.metadata && (
                          <div className="space-y-3">
                            {/* Error Type Classification */}
                            {log.details.metadata.errorType && (
                              <div className="p-3 bg-red-50 border border-red-200 rounded-md">
                                <h5 className="text-sm font-semibold text-red-800 mb-1">Error Type</h5>
                                <span className="text-sm text-red-700 bg-red-100 px-2 py-1 rounded">
                                  {log.details.metadata.errorType}
                                </span>
                              </div>
                            )}
                            
                            {/* Attribute Error Details */}
                            {log.details.metadata.errorType === 'ATTRIBUTE_RECOGNITION_ERROR' && (
                              <div className="p-3 bg-orange-50 border border-orange-200 rounded-md">
                                <h5 className="text-sm font-semibold text-orange-800 mb-2">Attribute Error Details</h5>
                                <div className="space-y-2 text-sm">
                                  <div>
                                    <span className="font-medium">Attribute ID:</span>
                                    <code className="ml-2 bg-orange-100 px-2 py-1 rounded text-orange-800">
                                      {log.details.metadata.attributeId || 'N/A'}
                                    </code>
                                  </div>
                                  {log.details.metadata.diagnosticInfo && (
                                    <div>
                                      <span className="font-medium">Validation:</span>
                                      <div className="ml-2 space-y-1">
                                        <div className="flex items-center gap-2">
                                          <span className="text-xs">Valid Format:</span>
                                          <span className={`text-xs px-2 py-1 rounded ${
                                            log.details.metadata.diagnosticInfo.attributeIdFormat 
                                              ? 'bg-green-100 text-green-800' 
                                              : 'bg-red-100 text-red-800'
                                          }`}>
                                            {log.details.metadata.diagnosticInfo.attributeIdFormat ? 'Yes' : 'No'}
                                          </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                          <span className="text-xs">Has Value:</span>
                                          <span className={`text-xs px-2 py-1 rounded ${
                                            log.details.metadata.diagnosticInfo.attributeIdValid 
                                              ? 'bg-green-100 text-green-800' 
                                              : 'bg-red-100 text-red-800'
                                          }`}>
                                            {log.details.metadata.diagnosticInfo.attributeIdValid ? 'Yes' : 'No'}
                                          </span>
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                            
                            {/* API Error Details */}
                            {log.details.metadata.errorType === 'API_ERROR' && (
                              <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
                                <h5 className="text-sm font-semibold text-blue-800 mb-2">API Error Details</h5>
                                <div className="space-y-2 text-sm">
                                  {log.details.metadata.apiContext?.statusCode && (
                                    <div>
                                      <span className="font-medium">Status Code:</span>
                                      <span className="ml-2 bg-blue-100 text-blue-800 px-2 py-1 rounded">
                                        {log.details.metadata.apiContext.statusCode}
                                      </span>
                                    </div>
                                  )}
                                  {log.details.metadata.apiContext?.errorDetails && (
                                    <div>
                                      <span className="font-medium">Error Details:</span>
                                      <div className="mt-1 bg-blue-100 p-2 rounded text-blue-800">
                                        {typeof log.details.metadata.apiContext.errorDetails === 'string' 
                                          ? log.details.metadata.apiContext.errorDetails
                                          : JSON.stringify(log.details.metadata.apiContext.errorDetails, null, 2)
                                        }
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}

                            {log.details.metadata.errorType === 'LOGIN_FAILURE' && (
                              <div className="p-3 bg-rose-50 border border-rose-200 rounded-md">
                                <h5 className="text-sm font-semibold text-rose-800 mb-2">Login Failure Diagnostics</h5>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                                  {log.details.metadata.loginMethod && (
                                    <div>
                                      <span className="font-medium">Method:</span>
                                      <span className="ml-2 bg-rose-100 px-2 py-1 rounded text-rose-800">
                                        {log.details.metadata.loginMethod}
                                      </span>
                                    </div>
                                  )}
                                  {log.details.metadata.loginStage && (
                                    <div>
                                      <span className="font-medium">Stage:</span>
                                      <code className="ml-2 bg-rose-100 px-2 py-1 rounded text-rose-800">
                                        {log.details.metadata.loginStage}
                                      </code>
                                    </div>
                                  )}
                                  {log.details.metadata.httpStatus != null && (
                                    <div>
                                      <span className="font-medium">HTTP Status:</span>
                                      <span className="ml-2 bg-rose-100 px-2 py-1 rounded text-rose-800">
                                        {log.details.metadata.httpStatus}
                                      </span>
                                    </div>
                                  )}
                                  {log.details.metadata.upstreamStatus != null && (
                                    <div>
                                      <span className="font-medium">Upstream Status:</span>
                                      <span className="ml-2 bg-rose-100 px-2 py-1 rounded text-rose-800">
                                        {log.details.metadata.upstreamStatus}
                                      </span>
                                    </div>
                                  )}
                                </div>
                                {log.details.metadata.failureReason && (
                                  <div className="mt-2 text-sm">
                                    <span className="font-medium">Reason:</span>
                                    <div className="mt-1 bg-rose-100 p-2 rounded text-rose-800">
                                      {log.details.metadata.failureReason}
                                    </div>
                                  </div>
                                )}
                                {log.details.metadata.upstreamError && (
                                  <div className="mt-2 text-sm">
                                    <span className="font-medium">Upstream Error:</span>
                                    <pre className="mt-1 text-xs bg-rose-100 p-2 rounded overflow-x-auto text-rose-800">
                                      {typeof log.details.metadata.upstreamError === 'string'
                                        ? log.details.metadata.upstreamError
                                        : JSON.stringify(log.details.metadata.upstreamError, null, 2)}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Request Context */}
                            {log.details.metadata.requestContext && (
                              <div className="p-3 bg-gray-50 border border-gray-200 rounded-md">
                                <h5 className="text-sm font-semibold text-gray-800 mb-2">Request Context</h5>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                                  {log.details.metadata.requestContext.workspaceId && (
                                    <div>
                                      <span className="font-medium">Workspace ID:</span>
                                      <code className="ml-2 bg-gray-100 px-2 py-1 rounded text-gray-800">
                                        {log.details.metadata.requestContext.workspaceId}
                                      </code>
                                    </div>
                                  )}
                                  {log.details.metadata.requestContext.boardId && (
                                    <div>
                                      <span className="font-medium">Board ID:</span>
                                      <code className="ml-2 bg-gray-100 px-2 py-1 rounded text-gray-800">
                                        {log.details.metadata.requestContext.boardId}
                                      </code>
                                    </div>
                                  )}
                                  {log.details.metadata.requestContext.method && (
                                    <div>
                                      <span className="font-medium">Method:</span>
                                      <span className="ml-2 bg-gray-100 px-2 py-1 rounded text-gray-800">
                                        {log.details.metadata.requestContext.method}
                                      </span>
                                    </div>
                                  )}
                                  {log.details.metadata.requestContext.url && (
                                    <div>
                                      <span className="font-medium">URL:</span>
                                      <code className="ml-2 bg-gray-100 px-2 py-1 rounded text-gray-800 text-xs">
                                        {log.details.metadata.requestContext.url}
                                      </code>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                            
                            {/* Operation Context */}
                            {log.details.metadata.requestId && (
                              <div className="p-3 bg-purple-50 border border-purple-200 rounded-md">
                                <h5 className="text-sm font-semibold text-purple-800 mb-2">Operation Context</h5>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                                  <div>
                                    <span className="font-medium">Request ID:</span>
                                    <code className="ml-2 bg-purple-100 px-2 py-1 rounded text-purple-800">
                                      {log.details.metadata.requestId}
                                    </code>
                                  </div>
                                  {log.details.metadata.operation && (
                                    <div>
                                      <span className="font-medium">Operation:</span>
                                      <span className="ml-2 bg-purple-100 px-2 py-1 rounded text-purple-800">
                                        {log.details.metadata.operation}
                                      </span>
                                    </div>
                                  )}
                                  {log.details.metadata.operationType && (
                                    <div>
                                      <span className="font-medium">Operation Type:</span>
                                      <span className="ml-2 bg-purple-100 px-2 py-1 rounded text-purple-800">
                                        {log.details.metadata.operationType}
                                      </span>
                                    </div>
                                  )}
                                  {log.details.metadata.success !== undefined && (
                                    <div>
                                      <span className="font-medium">Success:</span>
                                      <span className={`ml-2 px-2 py-1 rounded ${
                                        log.details.metadata.success 
                                          ? 'bg-green-100 text-green-800' 
                                          : 'bg-red-100 text-red-800'
                                      }`}>
                                        {log.details.metadata.success ? 'Yes' : 'No'}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                            
                            {/* Board and View Details */}
                            {(log.details.metadata.boardId || log.details.metadata.viewId || log.details.metadata.itemId) && (
                              <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-md">
                                <h5 className="text-sm font-semibold text-indigo-800 mb-2">Board & View Details</h5>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                                  {log.details.metadata.boardId && (
                                    <div>
                                      <span className="font-medium">Board ID:</span>
                                      <code className="ml-2 bg-indigo-100 px-2 py-1 rounded text-indigo-800">
                                        {log.details.metadata.boardId}
                                      </code>
                                    </div>
                                  )}
                                  {log.details.metadata.boardName && (
                                    <div>
                                      <span className="font-medium">Board Name:</span>
                                      <span className="ml-2 bg-indigo-100 px-2 py-1 rounded text-indigo-800">
                                        {log.details.metadata.boardName}
                                      </span>
                                    </div>
                                  )}
                                  {log.details.metadata.viewId && (
                                    <div>
                                      <span className="font-medium">View ID:</span>
                                      <code className="ml-2 bg-indigo-100 px-2 py-1 rounded text-indigo-800">
                                        {log.details.metadata.viewId}
                                      </code>
                                    </div>
                                  )}
                                  {log.details.metadata.viewName && (
                                    <div>
                                      <span className="font-medium">View Name:</span>
                                      <span className="ml-2 bg-indigo-100 px-2 py-1 rounded text-indigo-800">
                                        {log.details.metadata.viewName}
                                      </span>
                                    </div>
                                  )}
                                  {log.details.metadata.viewType && (
                                    <div>
                                      <span className="font-medium">View Type:</span>
                                      <span className="ml-2 bg-indigo-100 px-2 py-1 rounded text-indigo-800">
                                        {log.details.metadata.viewType}
                                      </span>
                                    </div>
                                  )}
                                  {log.details.metadata.folderId && (
                                    <div>
                                      <span className="font-medium">Folder ID:</span>
                                      <code className="ml-2 bg-indigo-100 px-2 py-1 rounded text-indigo-800">
                                        {log.details.metadata.folderId}
                                      </code>
                                    </div>
                                  )}
                                  {log.details.metadata.itemId && (
                                    <div>
                                      <span className="font-medium">Item ID:</span>
                                      <code className="ml-2 bg-indigo-100 px-2 py-1 rounded text-indigo-800">
                                        {log.details.metadata.itemId}
                                      </code>
                                    </div>
                                  )}
                                  {log.details.metadata.itemName && (
                                    <div>
                                      <span className="font-medium">Item Name:</span>
                                      <span className="ml-2 bg-indigo-100 px-2 py-1 rounded text-indigo-800">
                                        {log.details.metadata.itemName}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                            
                            {/* Upload Details */}
                            {log.details.metadata.uploadDetails && (
                              <div className="p-3 bg-teal-50 border border-teal-200 rounded-md">
                                <h5 className="text-sm font-semibold text-teal-800 mb-2">Upload Details</h5>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                                  {log.details.metadata.uploadDetails.uploadId && (
                                    <div>
                                      <span className="font-medium">Upload ID:</span>
                                      <code className="ml-2 bg-teal-100 px-2 py-1 rounded text-teal-800">
                                        {log.details.metadata.uploadDetails.uploadId}
                                      </code>
                                    </div>
                                  )}
                                  {log.details.metadata.uploadDetails.fileName && (
                                    <div>
                                      <span className="font-medium">File Name:</span>
                                      <span className="ml-2 bg-teal-100 px-2 py-1 rounded text-teal-800">
                                        {log.details.metadata.uploadDetails.fileName}
                                      </span>
                                    </div>
                                  )}
                                  {log.details.metadata.uploadDetails.fileSize && (
                                    <div>
                                      <span className="font-medium">File Size:</span>
                                      <span className="ml-2 bg-teal-100 px-2 py-1 rounded text-teal-800">
                                        {log.details.metadata.uploadDetails.fileSize} bytes
                                      </span>
                                    </div>
                                  )}
                                  {log.details.metadata.uploadDetails.mimeType && (
                                    <div>
                                      <span className="font-medium">MIME Type:</span>
                                      <span className="ml-2 bg-teal-100 px-2 py-1 rounded text-teal-800">
                                        {log.details.metadata.uploadDetails.mimeType}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                            
                            {/* Item Values */}
                            {log.details.metadata.itemValues && log.details.metadata.itemValues.length > 0 && (
                              <div className="p-3 bg-amber-50 border border-amber-200 rounded-md">
                                <h5 className="text-sm font-semibold text-amber-800 mb-2">Item Values</h5>
                                <div className="space-y-2">
                                  {log.details.metadata.itemValues.map((itemValue: ItemValue, index: number) => (
                                    <div key={index} className="bg-amber-100 p-2 rounded text-sm">
                                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                        <div>
                                          <span className="font-medium">Attribute ID:</span>
                                          <code className="ml-2 bg-amber-200 px-1 py-0.5 rounded text-xs">
                                            {itemValue.attributeId}
                                          </code>
                                        </div>
                                        <div>
                                          <span className="font-medium">Name:</span>
                                          <span className="ml-2">{itemValue.attributeName}</span>
                                        </div>
                                        <div>
                                          <span className="font-medium">Type:</span>
                                          <span className="ml-2">{itemValue.attributeType}</span>
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            
                            {/* Stack Trace */}
                            {log.details.metadata.stackTrace && (
                              <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                                <h5 className="text-sm font-semibold text-yellow-800 mb-2">Stack Trace</h5>
                                <pre className="text-xs bg-yellow-100 p-2 rounded overflow-x-auto text-yellow-800">
                                  {log.details.metadata.stackTrace}
                                </pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            ))
          ))}
        </TableBody>
      </Table>
      <div className="flex flex-col md:flex-row items-center justify-between gap-4 mt-6">
        <div className="flex items-center gap-2">
          <span>Rows per page:</span>
          <select
            className="border rounded px-2 py-1 text-sm"
            value={logsPerPage}
            onChange={e => handleLogsPerPageChange(Number(e.target.value))}
          >
            {[20, 50, 100].map(size => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 justify-center w-full">
          <PaginationPrevious
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            className={currentPage === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
          />
          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter(page =>
              page === 1 ||
              page === totalPages ||
              (page >= currentPage - 1 && page <= currentPage + 1)
            )
            .map((page, i, arr) => (
              <div key={`pagination-${page}`} style={{ display: "flex" }}>
                {i > 0 && arr[i - 1] !== page - 1 && (
                  <span className="px-2">...</span>
                )}
                <PaginationLink
                  onClick={() => setCurrentPage(page)}
                  isActive={currentPage === page}
                >
                  {page}
                </PaginationLink>
              </div>
            ))}
          <PaginationNext
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            className={currentPage === totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
          >
            Next
          </PaginationNext>
        </div>
        <div className="text-sm text-muted-foreground">
          Page {currentPage} of {totalPages} ({totalLogs} logs)
        </div>
      </div>
    </Card>
  );
}


export default function Dashboard() {
  const { user } = useAppContext();
  const router = useRouter();
  const [exportingPortalUsers, setExportingPortalUsers] = useState(false);

  useEffect(() => {
    if (user.role !== "isoplus_user" && user.role !== "owner" && user.role !== "support_admin") {
      router.replace("/access-denied");
    }
  }, [user.role, router]);

  const firstName = user.name?.trim().split(/\s+/)[0];

  const handleExportPortalUsersCsv = useCallback(async () => {
    const apiBase = process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, "");
    if (!apiBase) {
      showErrorToast("Missing NEXT_PUBLIC_BACKEND_URL. Set the API base URL in the Frontend environment.");
      return;
    }
    setExportingPortalUsers(true);
    try {
      const res = await axios.get(`${apiBase}/api/auth/users/export-csv`, {
        withCredentials: true,
        responseType: "blob",
      });
      const raw =
        res.data instanceof Blob
          ? res.data
          : new Blob([res.data], { type: "text/csv;charset=utf-8" });
      const text = await raw.text();
      const trimmed = text.replace(/^﻿/, "").trimStart();
      if (trimmed.startsWith("{")) {
        try {
          const j = JSON.parse(text.replace(/^﻿/, "")) as { message?: string };
          if (j?.message) {
            showErrorToast(j.message);
            return;
          }
        } catch {
        }
      }
      const outBlob = new Blob([text], { type: "text/csv;charset=utf-8" });
      const cd =
        (res.headers["content-disposition"] as string | undefined) ??
        (res.headers["Content-Disposition"] as string | undefined);
      const filename = filenameFromContentDisposition(cd);
      const url = window.URL.createObjectURL(outBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      window.URL.revokeObjectURL(url);
      showSuccessToast("Users exported successfully.");
    } catch (err: unknown) {
      const msg = await messageFromUserExportAxiosError(err);
      showErrorToast(msg);
    } finally {
      setExportingPortalUsers(false);
    }
  }, []);

  return (
    <div className="relative min-h-screen bg-background">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-primary/[0.06] to-transparent"
        aria-hidden
      />
      <Header />
      <XeroOAuthReturnBoundary />
      <div className="relative container mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {firstName ? `Welcome back, ${firstName}` : "Welcome"}
            </h1>
            <p className="text-sm text-muted-foreground sm:text-base">
              Choose a workspace, or use Application logs if you are an Owner or Support admin.
            </p>
          </div>
          {user.id &&
            isOwnerOrSupport(user) && (
            <Button
              type="button"
              variant="outline"
              className="gap-2 shrink-0 self-start"
              onClick={handleExportPortalUsersCsv}
              disabled={exportingPortalUsers}
            >
              <Download className="h-4 w-4" />
              {exportingPortalUsers ? "Exporting…" : "Export all users (CSV)"}
            </Button>
          )}
        </div>

        <Tabs defaultValue="workspaces" className="space-y-6">
          <TabsList
            className={`grid h-auto w-full gap-1 rounded-xl border border-border/60 bg-muted/40 p-1.5 shadow-sm ${
              isOwnerOrSupport(user)
                ? "grid-cols-1 sm:grid-cols-3"
                : "grid-cols-1"
            }`}
          >
            <TabsTrigger
              value="workspaces"
              className="rounded-lg py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
            >
              Workspaces
            </TabsTrigger>
            {isOwnerOrSupport(user) && (
              <TabsTrigger
                value="logs"
                className="gap-2 rounded-lg py-2.5 text-left leading-tight data-[state=active]:bg-background data-[state=active]:shadow-sm sm:text-center"
              >
                <span className="inline-flex items-center gap-2">
                  <Terminal className="h-4 w-4 shrink-0" />
                  <span>Application logs</span>
                </span>
              </TabsTrigger>
            )}
            {isOwnerOrSupport(user) && (
              <TabsTrigger
                value="system-health"
                className="gap-2 rounded-lg py-2.5 text-left leading-tight data-[state=active]:bg-background data-[state=active]:shadow-sm sm:text-center"
              >
                <span className="inline-flex items-center gap-2">
                  <Activity className="h-4 w-4 shrink-0" />
                  <span>System Health</span>
                </span>
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="workspaces">
            <WorkspacesList />
          </TabsContent>
          {isOwnerOrSupport(user) && (
            <TabsContent value="logs">
              <GlobalApplicationLogs />
            </TabsContent>
          )}
          {isOwnerOrSupport(user) && (
            <TabsContent value="system-health">
              <SystemHealthPageView />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  );
}