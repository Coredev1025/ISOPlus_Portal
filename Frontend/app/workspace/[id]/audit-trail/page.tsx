"use client";

import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Search, Filter, Download } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { PaginationControls } from "@/lib/pagination-controls";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useEffect, useState } from "react";
import axios from "@/app/utils/axiosConfig";
import Spinner from "@/components/ui/spin";

const ITEMS_PER_PAGE = 50; // Increased to match backend default, but still paginated
interface AuditTrailItem {
  timestamp: string;
  action: string;
  user: string;
  ipAddress: string;
  detail: string;
}

function titleCaseWords(str: string) {
  return str
    .split(/\s+/g)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function humanizeActionFromPath(method: string | undefined, path: string | undefined) {
  if (!path) return "";
  const urlPath = String(path).split("?")[0];

  // Known “user actions” (keep these friendly and stable)
  if (urlPath.includes("/api/age-care/") && urlPath.endsWith("/update-variables-participants-service")) {
    return "Update Participants Service variables";
  }
  if (urlPath.includes("/api/age-care/") && urlPath.endsWith("/update-variables-masterplan")) {
    return "Update Master Plan variables";
  }
  if (urlPath.includes("/api/pdf/") && urlPath.endsWith("/monthly-statement")) {
    return "Generate Monthly Statement";
  }

  // Generic fallback: use last segment, avoid showing full endpoint
  const segments = urlPath.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  const words = last.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return "";

  const m = (method || "").toUpperCase();
  const verbPrefix = m === "DELETE" ? "Delete " : m === "PUT" || m === "PATCH" ? "Update " : "";
  return titleCaseWords(`${verbPrefix}${words}`.trim());
}

function normalizeAuditAction(item: any) {
  const action = String(item?.action || "");
  if (!action) return "";
  if (action.startsWith("HTTP ")) {
    const derived = humanizeActionFromPath(item?.method, item?.path);
    return derived || "Unknown Action";
  }
  return action;
}

import { normalizeAuditDetail } from '@/lib/audit-trail-helpers';

export default function AuditTrailPage() {
  const router = useRouter();
  const id = usePathname().split('/')[2];
  const [businessTimezone, setBusinessTimezone] = useState<string>("Australia/Sydney");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [userFilter, setUserFilter] = useState<string>("all");
  const [auditTrail, setAuditTrail] = useState<AuditTrailItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalItems, setTotalItems] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [knownActions, setKnownActions] = useState<string[]>([]);
  const [knownUsers, setKnownUsers] = useState<string[]>([]);

  useEffect(() => {
    if (!id) return;
    const abort = new AbortController();
    axios
      .get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`, { params: { workspaceId: id }, signal: abort.signal })
      .then(res => { if (res.data?.headOfficeTimezone) setBusinessTimezone(res.data.headOfficeTimezone); })
      .catch(err => { if (err.name !== "CanceledError" && err.name !== "AbortError") console.error(err); });
    return () => abort.abort();
  }, [id]);

  // Debounce search query
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setCurrentPage(1); // Reset to first page on search
    }, 400);

    return () => clearTimeout(handler);
  }, [searchQuery]);

  useEffect(() => {
    const abortController = new AbortController();

    const fetchAuditTrailData = async () => {
      setLoading(true);
      try {
        const params: Record<string, string | number> = {
          workspaceId: id,
          page: currentPage,
          limit: ITEMS_PER_PAGE,
          sortBy: 'createdAt',
          sortOrder: 'desc'
        };

        // Note: Backend doesn't support search/filter yet, but we can add client-side filtering
        // for the current page results only to reduce memory usage

        const response = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/audit/`,
          {
            params,
            signal: abortController.signal
          }
        );

        // Backend now returns paginated response
        const { items, total, page, totalPages: apiTotalPages } = response.data;

        let auditData: AuditTrailItem[] = items.map((item: any) => {
          const d = new Date(item.createdAt);
          const timestamp = isNaN(d.getTime())
            ? ""
            : new Intl.DateTimeFormat("en-AU", {
                timeZone: businessTimezone,
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: true,
              }).format(d);
          return {
            action: normalizeAuditAction(item),
            user: item.userEmail,
            ipAddress: item.userIp,
            detail: normalizeAuditDetail(item),
            timestamp,
          };
        });

        // Client-side filtering for current page only (reduces memory)
        if (debouncedSearch || actionFilter !== "all" || userFilter !== "all") {
          auditData = auditData.filter((item) => {
            const matchesSearch = !debouncedSearch ||
              item.action.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
              item.user.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
              item.ipAddress.includes(debouncedSearch);

            const matchesAction = actionFilter === "all" || item.action === actionFilter;
            const matchesUser = userFilter === "all" || item.user === userFilter;

            return matchesSearch && matchesAction && matchesUser;
          });
        }

        setAuditTrail(auditData);
        setTotalItems(total);
        setTotalPages(apiTotalPages || Math.ceil(total / ITEMS_PER_PAGE) || 1);

        // Update known actions and users from current page
        setKnownActions((prev) => {
          const combined = new Set(prev);
          auditData.forEach(item => {
            if (item.action) combined.add(item.action);
          });
          return Array.from(combined);
        });

        setKnownUsers((prev) => {
          const combined = new Set(prev);
          auditData.forEach(item => {
            if (item.user) combined.add(item.user);
          });
          return Array.from(combined);
        });

        if (page !== currentPage) {
          setCurrentPage(page);
        }
      } catch (error: any) {
        if (error.name != "CanceledError" && error.name != "AbortError") {
          console.error("Error fetching audit trail:", error);
        }
      } finally {
        setLoading(false);
      }
    };

    fetchAuditTrailData();

    return () => {
      abortController.abort();
    };
  }, [id, currentPage, debouncedSearch, actionFilter, userFilter, businessTimezone]);

  // Use known actions and users for filters (from all pages visited)
  const uniqueActions = knownActions.length ? knownActions : Array.from(new Set(auditTrail.map(item => item.action)));
  const uniqueUsers = knownUsers.length ? knownUsers : Array.from(new Set(auditTrail.map(item => item.user)));

  // Filter current page items only (already done in fetch, but keep for consistency)
  const filteredAuditTrail = auditTrail.filter(item => {
    const matchesSearch = !debouncedSearch ||
      item.action.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
      item.user.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
      item.ipAddress.includes(debouncedSearch);

    const matchesAction = actionFilter === "all" || item.action === actionFilter;
    const matchesUser = userFilter === "all" || item.user === userFilter;

    return matchesSearch && matchesAction && matchesUser;
  });

  const currentItems = filteredAuditTrail;

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto animate-fade-in-up py-8">
        <BackButton onClick={() => router.back()}>
          Back to Workspace
        </BackButton>

        <div className="page-enter-stagger space-y-6">
          <Card className="card-hover p-6 shadow-lg">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold tracking-tight">Audit Trail</h1>
                <p className="text-muted-foreground">
                  Track all activities and changes in your workspace
                </p>
              </div>
              <Button variant="outline" className="hidden gap-2">
                <Download className="h-4 w-4" />
                <span>Export Audit Log</span>
              </Button>
            </div>

            {/* Search and Filters */}
            <div className="mb-6 flex flex-wrap gap-4">
              <div className="min-w-[200px] flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform text-muted-foreground" />
                  <Input
                    placeholder="Search audit trail..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="pl-9"
                  />
                </div>
              </div>

              <div className="flex gap-4">
                <Select 
                  value={actionFilter} 
                  onValueChange={(value) => {
                    setActionFilter(value);
                    setCurrentPage(1);
                  }}
                >
                  <SelectTrigger className="w-[200px]">
                    <Filter className="mr-2 h-4 w-4" />
                    <SelectValue placeholder="Filter by action" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Actions</SelectItem>
                    {uniqueActions.map((action, index) => (
                      <SelectItem key={index} value={action || "unknown"}>{action || "Unknown Action"}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select 
                  value={userFilter} 
                  onValueChange={(value) => {
                    setUserFilter(value);
                    setCurrentPage(1);
                  }}
                >
                  <SelectTrigger className="w-[200px]">
                    <Filter className="mr-2 h-4 w-4" />
                    <SelectValue placeholder="Filter by user" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Users</SelectItem>
                    {uniqueUsers.map((user, index) => (
                      <SelectItem key={index} value={user || "unknown"}>{user || "Unknown User"}</SelectItem>
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
                {currentItems.map((item, index) => (
                  <TableRow key={index}>
                    <TableCell className="whitespace-nowrap">
                      {item.timestamp}
                    </TableCell>
                    <TableCell>{item.action}</TableCell>
                    <TableCell>{item.user}</TableCell>
                    <TableCell className="font-mono">{item.ipAddress}</TableCell>
                    <TableCell className="max-w-xs truncate">
                      <span className="text-muted-foreground">
                        {item.detail}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {loading ? (
              <div className="flex flex-col items-center justify-center py-16">
                <span>Loading audit trail...</span>
                <span className="ml-2"><Spinner /></span>
              </div>
            ) : filteredAuditTrail.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <span>No audit trail found</span>
              </div>
            ) : (
              <div className="mt-4 text-sm text-muted-foreground">
                <span>Showing {filteredAuditTrail.length} of {totalItems} entries (Page {currentPage} of {totalPages})</span>
              </div>
            )}

            {!loading && totalPages > 0 && (
              <PaginationControls
                className="mt-4 flex justify-center"
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={setCurrentPage}
              />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}