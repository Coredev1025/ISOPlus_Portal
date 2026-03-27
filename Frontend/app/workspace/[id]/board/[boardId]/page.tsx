"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Clock, Terminal, Download, Filter, MapPin, Search, List, Map, QrCode, FileText, FileBarChart } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useCallback, useEffect, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { useAppContext } from "@/app/context/index";
import { Badge } from "@/components/ui/badge";
import { TimeEntry } from "./types";
import { TimeTrackingButton } from "./components/TimeTrackingButton";
import axios from "@/app/utils/axiosConfig";
import { isCareManagementLabel, isLowCatCareManagementLabel, isOwnerOrSupport } from "@/lib/access";
import dynamic from "next/dynamic";

const LeafletMap = dynamic(
  () => import("@/components/ui/leaflet-map").then(m => m.LeafletMap),
  { ssr: false }
);

interface Board {
  id: string;
  name: string;
  label?: string;
}

type BoardLabel = 'Job Management' | 'Care Management - NDIS - Certification' | 'Care Management - NDIS - Verification' | 'Care Management - SaH' | 'Care Management - SaH - Low Cat' | 'No Label';

const LABEL_COLORS: Record<NonNullable<BoardLabel>, string> = {
  'Job Management': 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
  'Care Management - NDIS - Certification': 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  'Care Management - NDIS - Verification': 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300',
  'Care Management - SaH': 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-300',
  'Care Management - SaH - Low Cat': 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-300',
  'No Label': 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300',
};

export default function BoardDetail() {
  const router = useRouter();
  const pathname = usePathname();
  const id = pathname.split('/')[2];
  const boardId = pathname.split('/').pop();
  const [board, setBoard] = useState<Board>();
  const { workspaces, user, setCurrentWorkspaceId } = useAppContext();
  const workspace = workspaces.find(w => w.id.toString() === id);
  const [timeTrackingEnabled, setTimeTrackingEnabled] = useState(false);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "completed">("all");
  const [locationFilter, setLocationFilter] = useState<"all" | "with-location" | "without-location">("all");
  const [viewMode, setViewMode] = useState<"list" | "map">("list");
  const [selectedEntry, setSelectedEntry] = useState<TimeEntry | null>(null);
  const [loadingBoards, setLoadingBoards] = useState(false);
  const ITEMS_PER_PAGE = 10;
  const isOwnerOrSupportUser = isOwnerOrSupport(user);
  const isWorkspaceOwner = user.role === "isoplus_user" && workspace?.user_role === "owner";
  const isWorkspaceAdmin = user.role === "isoplus_user" && workspace?.user_role === "admin";
  const canAccessThisWorkspace = isOwnerOrSupportUser || isWorkspaceOwner || isWorkspaceAdmin;

  const calcDuration = (startTime: any, endTime: any) => {
    return Math.floor((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000);
  };

  useEffect(() => {
    if (workspace === undefined) return;
    if (!canAccessThisWorkspace) {
      router.replace("/workspace/access-denied");
    }
  }, [workspace, canAccessThisWorkspace, router]);

  useEffect(() => {
    if (id) {
      setCurrentWorkspaceId(id);
    }
    return () => {
      setCurrentWorkspaceId(null);
    };
  }, [id, setCurrentWorkspaceId]);

  useEffect(() => {
    const abortController = new AbortController();

    const fetchBoardData = async () => {
      try {
        setLoadingBoards(true);
        const boardsResponse = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/boards?id=${boardId}`,
          {
            signal: abortController.signal
          }
        );

        if (!abortController.signal.aborted) {
          const boardData: Board = boardsResponse.data.board;
          setBoard(boardData);

          const currentBoardData = {
            boardId: boardId,
            boardName: boardData?.name || `Board ${boardId}`,
            boardLabel: boardData?.label || 'No Label',
            workspaceId: id,
            workspaceName: workspace?.name || `Workspace ${id}`,
            timestamp: new Date().toISOString()
          };

          sessionStorage.setItem('currentBoard', JSON.stringify(currentBoardData));
          console.log('Board data stored in session storage:', currentBoardData);
        }
      } catch (error: any) {
        if (error.name != "CanceledError" && error.name != "AbortError") {
          console.error("Error fetching board data:", error);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setLoadingBoards(false);
        }
      }
    };

    fetchBoardData();

    return () => {
      abortController.abort();
    };
  }, [id, boardId, workspace])

  const fetchTimeEntries = useCallback(async () => {
    try {
      if (!id || !boardId) return;
      const timetracking = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/timetracks?workspaceId=${id}&boardId=${boardId}`
      );
      const data: TimeEntry[] = timetracking.data.tasks.map((entry: any) => ({
        id: entry.id,
        taskName: entry.taskName,
        startTime: entry.startTime ?? "",
        endTime: entry.endTime ?? null,
        duration: entry.duration ?? 0,
        location: entry.location?.lat
          ? { lat: entry.location.lat, lng: entry.location.lng, address: entry.location.address ?? "" }
          : null,
        userId: entry.userId ?? user.id,
        userName: entry.userName ?? user.name,
        notes: entry.notes
      }));
      setTimeEntries(data);
    } catch (error: any) {
      if (error.name !== "CanceledError" && error.name !== "AbortError") {
        console.error("Error fetching time entries:", error);
      }
    }
  }, [id, boardId, user.id, user.name]);

  useEffect(() => {
    fetchTimeEntries();
  }, [fetchTimeEntries]);

  useEffect(() => {
    if (!timeTrackingEnabled) return;
    const intervalId = setInterval(() => {
      setTimeEntries(prev => {
        const activeIdx = prev.findIndex(entry => !entry.endTime);
        if (activeIdx === -1) return prev;
        const updated = [...prev];
        updated[activeIdx] = {
          ...updated[activeIdx],
          duration: Math.floor((Date.now() - new Date(updated[activeIdx].startTime).getTime()) / 1000)
        };
        return updated;
      });
    }, 1000);
    return () => clearInterval(intervalId);
  }, [timeTrackingEnabled]);

  if (!workspace || !board) {
    return null;
  }

  const isCareManagementBoard = isCareManagementLabel(board.label);
  const isLowCatBoard = isLowCatCareManagementLabel(board.label);
  const isNdisCertificationOrVerificationBoard =
    board.label === 'Care Management - NDIS - Certification' ||
    board.label === 'Care Management - NDIS - Verification';
  const canAccessInvoiceGenerator =
    (isCareManagementBoard || isLowCatBoard || isNdisCertificationOrVerificationBoard) &&
    (isOwnerOrSupportUser || isWorkspaceOwner || isWorkspaceAdmin);

  const filteredEntries = timeEntries.filter(entry => {
    const matchesSearch = entry.taskName.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === "all" ||
      (statusFilter === "active" && !entry.endTime) ||
      (statusFilter === "completed" && entry.endTime);

    const matchesLocation = locationFilter === "all" ||
      (locationFilter === "with-location" && entry.location) ||
      (locationFilter === "without-location" && !entry.location);

    return matchesSearch && matchesStatus && matchesLocation;
  });

  const totalPages = Math.ceil(filteredEntries.length / ITEMS_PER_PAGE);
  const paginatedEntries = filteredEntries.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  const formatDuration = (entry: TimeEntry) => {
    const toHMS = (totalSeconds: number) => {
      const h = Math.floor(totalSeconds / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = totalSeconds % 60;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    };
    if (!entry.endTime) {
      if (!entry.startTime) return '0s';
      const elapsed = Math.floor((Date.now() - new Date(entry.startTime).getTime()) / 1000);
      return toHMS(elapsed);
    }
    const dur = Number(entry.duration);
    if (Number.isFinite(dur) && dur > 0) return toHMS(dur);
    if (entry.startTime && entry.endTime) {
      const elapsed = Math.floor((new Date(entry.endTime).getTime() - new Date(entry.startTime).getTime()) / 1000);
      return toHMS(elapsed);
    }
    return '0s';
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  const entriesWithLocation = filteredEntries.filter(entry => entry.location !== null);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto py-8">
        <Button
          variant="ghost"
          className="mb-6"
          onClick={() => router.push(`/workspace/${id}`)}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Workspace
        </Button>

        <div className="space-y-6">
          {/* Board Info */}
          <Card className="p-6 shadow-lg card-hover">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold mb-2 bg-clip-text text-transparent bg-gradient-to-r from-primary to-primary/80">
                  {board.name}
                </h1>
                <div className="flex items-center gap-2">
                  <p className="text-muted-foreground font-mono text-sm">ID: {boardId}</p>
                  {board.label && board.label !== 'No Label' && (
                    <Badge variant="outline" className={LABEL_COLORS[board.label as NonNullable<BoardLabel>]}>
                      {board.label}
                    </Badge>
                  )}
                </div>
              </div>
              <TimeTrackingButton
                workspaceId={id}
                boardId={boardId ?? ""}
                setTimeTrackingEnabled={setTimeTrackingEnabled}
                onSessionChange={fetchTimeEntries}
              />
            </div>
          </Card>

          {/* Board Actions */}
          {(user.role == "support_admin" || user.role == "owner" || user.role == "isoplus_user") && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {/* Configuration Card - Only for Owner and Support Admin */}
              {(user.role == "support_admin" || user.role == "owner") && (
                <Card className="p-6 space-y-4 card-hover">
                  <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
                    <Terminal className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold">Configuration</h2>
                    <p className="text-muted-foreground mb-4 text-sm">
                      Configure board settings and options
                    </p>
                    <Button
                      onClick={() => router.push(`/workspace/${id}/board/${boardId}/configuration`)}
                      className="w-full"
                    >
                      Configure Board
                    </Button>
                  </div>
                </Card>
              )}

              {/* QR Generator Card */}
              <Card className="p-6 space-y-4 card-hover">
                <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
                  <QrCode className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold">QR Generator</h2>
                  <p className="text-muted-foreground mb-4 text-sm">
                    Create QR codes for your forms and documents
                  </p>
                  <Button
                    onClick={() => router.push(`/workspace/${id}/board/${boardId}/qr-generator`)}
                    className="w-full"
                  >
                    Generate QR Code
                  </Button>
                </div>
              </Card>

              {canAccessInvoiceGenerator && (
                <Card className="p-6 space-y-4 card-hover">
                  <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
                    <FileText className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold">Invoice Generator</h2>
                    <p className="text-muted-foreground mb-4 text-sm">
                      Generate professional service invoices
                    </p>
                    <Button
                      onClick={() => router.push(`/workspace/${id}/board/${boardId}/invoice-generator`)}
                      className="w-full"
                    >
                      Generate Invoice
                    </Button>
                  </div>
                </Card>
              )}

              {/* Monthly Statement Card (SaH care management boards only; hidden for Low Cat and NDIS) */}
              {isCareManagementBoard && !isLowCatBoard && !board?.label?.includes('NDIS') && (
                <Card className="p-6 space-y-4 card-hover">
                  <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
                    <FileBarChart className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold">Monthly Statement</h2>
                    <p className="text-muted-foreground mb-4 text-sm">
                      View detailed monthly service statements
                    </p>
                    <Button
                      onClick={() => router.push(`/workspace/${id}/board/${boardId}/monthly-statement`)}
                      className="w-full"
                    >
                      View Statement
                    </Button>
                  </div>
                </Card>
              )}

              {/* Time Tracking Card */}
              {false && (<Card className="p-6 space-y-4 card-hover">
                <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
                  <Clock className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold">Time Tracking</h2>
                  <p className="text-muted-foreground mb-4 text-sm">
                    Configure time tracking settings
                  </p>
                  <Button
                    onClick={() => router.push(`/workspace/${id}/board/${board?.id}/time-tracking`)}
                    className="w-full"
                  >
                    Configure Time Tracking
                  </Button>
                </div>
              </Card>)}

              {/* Export Card */}
              {false && (<Card className="p-6 space-y-4 card-hover">
                <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
                  <Download className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold">Export Data</h2>
                  <p className="text-muted-foreground mb-4 text-sm">
                    Export board data and reports
                  </p>
                  <Button
                    onClick={() => router.push(`/workspace/${id}/board/${board?.id}/export`)}
                    className="w-full"
                  >
                    Export Data
                  </Button>
                </div>
              </Card>)}
            </div>)}

          {/* Time Tracking Entries */}
          {timeEntries.length > 0 && (
            <Card className="p-6 shadow-lg">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-xl font-semibold">Time Tracking Entries</h2>
                  <p className="text-muted-foreground">View and manage time entries for tasks in this board</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="gap-2" onClick={() => setViewMode("list")}>
                    <List className="h-4 w-4" />
                    List View
                  </Button>
                  <Button variant="outline" size="sm" className="gap-2" onClick={() => setViewMode("map")}>
                    <Map className="h-4 w-4" />
                    Map View
                  </Button>
                </div>
              </div>

              {/* Search and Filter */}
              <div className="flex flex-wrap gap-4 mb-6">
                <div className="flex-1 min-w-[200px]">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                    <Input
                      placeholder="Search by task name or user..."
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
                  <Select value={statusFilter} onValueChange={(value: typeof statusFilter) => setStatusFilter(value)}>
                    <SelectTrigger className="w-[160px]">
                      <Filter className="h-4 w-4 mr-2" />
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Status</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select value={locationFilter} onValueChange={(value: typeof locationFilter) => setLocationFilter(value)}>
                    <SelectTrigger className="w-[180px]">
                      <MapPin className="h-4 w-4 mr-2" />
                      <SelectValue placeholder="Location" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Locations</SelectItem>
                      <SelectItem value="with-location">With Location</SelectItem>
                      <SelectItem value="without-location">Without Location</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {viewMode === "list" ? (
                <>
                  {/* List View */}
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead>Task</TableHead>
                        <TableHead>Start Time</TableHead>
                        <TableHead>Duration</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedEntries.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell>
                            {!entry.endTime ? (
                              <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                                Active
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="bg-gray-50 text-gray-700 border-gray-200">
                                Completed
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="font-medium">{entry.taskName}</TableCell>
                          <TableCell>{entry.startTime ? formatDate(entry.startTime) : ""}</TableCell>
                          <TableCell>{formatDuration(entry)}</TableCell>
                          <TableCell>
                            {entry.location ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="gap-1 text-primary"
                                onClick={() => router.push(`/workspace/${id}/board/${boardId}/location/${entry.id}`)}
                              >
                                <MapPin className="h-3 w-3" />
                                View Location
                              </Button>
                            ) : (
                              <span className="text-muted-foreground text-sm">Not tracked</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => router.push(`/workspace/${id}/board/${boardId}/location/${entry.id}`)}
                            >
                              View Details
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>

                  {/* Pagination */}
                  {totalPages > 1 && (
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
                </>
              ) : (
                /* Map View */
                <div className="space-y-4">
                  <div className="rounded-lg overflow-hidden">
                    {entriesWithLocation.length === 0 ? (
                      <div className="h-[500px] bg-muted flex items-center justify-center rounded-lg">
                        <p className="text-muted-foreground">No location data to display</p>
                      </div>
                    ) : (
                      <LeafletMap
                        height="500px"
                        markers={entriesWithLocation.map(e => ({
                          id: e.id,
                          lat: e.location!.lat,
                          lng: e.location!.lng,
                          address: e.location?.address,
                          label: e.taskName,
                        }))}
                        onMarkerClick={marker => {
                          const entry = entriesWithLocation.find(e => e.id === marker.id) ?? null;
                          setSelectedEntry(prev => prev?.id === marker.id ? null : entry);
                        }}
                      />
                    )}
                  </div>

                  {/* Selected entry card */}
                  {selectedEntry && (
                    <div className="p-4 border rounded-lg bg-card shadow flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="font-semibold">{selectedEntry.taskName}</p>
                        <p className="text-sm text-muted-foreground">{formatDate(selectedEntry.startTime)} · {formatDuration(selectedEntry)}</p>
                        {selectedEntry.location?.address && (
                          <p className="text-sm mt-1">{selectedEntry.location.address}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button variant="outline" size="sm" onClick={() => router.push(`/workspace/${id}/board/${boardId}/location/${selectedEntry.id}`)}>
                          View Details
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(`https://www.google.com/maps/search/?api=1&query=${selectedEntry.location?.lat},${selectedEntry.location?.lng}`, '_blank')}
                        >
                          Google Maps
                        </Button>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setSelectedEntry(null)}>×</Button>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                      Showing {entriesWithLocation.length} time entr{entriesWithLocation.length !== 1 ? "ies" : "y"} with location
                    </p>
                    <Button variant="outline" size="sm" onClick={() => router.push(`/workspace/${id}/board/${boardId}/map-view`)}>
                      View Full Map
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}