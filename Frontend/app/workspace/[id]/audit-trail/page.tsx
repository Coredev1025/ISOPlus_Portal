"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Search, Filter, Download } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
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
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
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

export default function AuditTrailPage() {
  const router = useRouter();
  const id = usePathname().split('/')[2];
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

        let auditData: AuditTrailItem[] = items.map((item: any) => ({
          action: item.action,
          user: item.userEmail,
          ipAddress: item.userIp,
          detail: item.detail,
          timestamp: new Date(item.createdAt).toLocaleString('en-AU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
          })
        }));

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
  }, [id, currentPage, debouncedSearch, actionFilter, userFilter]);

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
      <div className="container mx-auto py-8">
        <Button
          variant="ghost"
          className="mb-6"
          onClick={() => router.back()}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Workspace
        </Button>

        <div className="space-y-6">
          <Card className="p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h1 className="text-2xl font-bold">Audit Trail</h1>
                <p className="text-muted-foreground">
                  Track all activities and changes in your workspace
                </p>
              </div>
              <Button variant="outline" className="gap-2 hidden">
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
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setCurrentPage(1); // Reset to first page on search
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
                    setCurrentPage(1); // Reset to first page on filter change
                  }}
                >
                  <SelectTrigger className="w-[200px]">
                    <Filter className="h-4 w-4 mr-2" />
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
                    setCurrentPage(1); // Reset to first page on filter change
                  }}
                >
                  <SelectTrigger className="w-[200px]">
                    <Filter className="h-4 w-4 mr-2" />
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
                Loading audit trail...
                <span className="ml-2"><Spinner /></span>
              </div>
            ) : filteredAuditTrail.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16">
                No audit trail found
              </div>
            ) : (
              <div className="text-sm text-muted-foreground mt-4">
                Showing {filteredAuditTrail.length} of {totalItems} entries (Page {currentPage} of {totalPages})
              </div>
            )}

            {/* Pagination */}
            {!loading && totalPages > 0 && (
              <div className="mt-4 flex justify-center">
                <Pagination>
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                        className={currentPage === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                      />
                    </PaginationItem>

                    {Array.from({ length: totalPages }, (_, i) => i + 1)
                      .filter(page =>
                        page === 1 ||
                        page === totalPages ||
                        (page >= currentPage - 1 && page <= currentPage + 1)
                      )
                      .map((page, i, arr) => (
                        <div key={`pagination-${page}`} style={{ display: "flex" }}>
                          {i > 0 && arr[i - 1] !== page - 1 && (
                            <PaginationItem>
                              <PaginationEllipsis />
                            </PaginationItem>
                          )}
                          <PaginationItem>
                            <PaginationLink
                              onClick={() => setCurrentPage(page)}
                              isActive={currentPage === page}
                            >
                              {page}
                            </PaginationLink>
                          </PaginationItem>
                        </div>
                      ))}

                    <PaginationItem>
                      <PaginationNext
                        onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                        className={currentPage === totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}