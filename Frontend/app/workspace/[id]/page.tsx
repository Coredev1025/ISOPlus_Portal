"use client";

import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { Card } from "@/components/ui/card";
import { Building2, FileSpreadsheet, FileText, BarChart, Info, History, Terminal } from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useEffect, useMemo, useState } from "react";
import { Header } from "@/components/ui/header";
import { useAppContext } from "@/app/context";
import axios from "@/app/utils/axiosConfig";
import Spinner from "@/components/ui/spin";
import { showFetchSuccessToast, showFetchErrorToast } from "@/lib/toast-utils";
import { Badge } from "@/components/ui/badge";
import { isOwnerOrSupport, canAccessBoard, isIsoPlusWorkspaceMember } from "@/lib/access";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface Board {
  id: string;
  name: string;
  label: string
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

export default function WorkspaceDetail() {
  const router = useRouter();
  const pathname = usePathname();
  const { workspaces, user, setCurrentWorkspaceId } = useAppContext();
  const id = pathname.split('/').pop();
  const workspace = workspaces.find(workspace => workspace.id.toString() === id);
  const [boards, setBoards] = useState<Board[]>([]);
  const [loadingBoards, setLoadingBoards] = useState<boolean>(false); // Loading state for boards
  const [loadingMoreBoards, setLoadingMoreBoards] = useState<boolean>(false);
  const [boardsHasMore, setBoardsHasMore] = useState<boolean>(false);
  const [boardsNextAfter, setBoardsNextAfter] = useState<string | null>(null);
  const [boardSearch, setBoardSearch] = useState<string>("");
  const [debouncedBoardQuery, setDebouncedBoardQuery] = useState<string>("");
  const isOwnerOrSupportUser = isOwnerOrSupport(user);
  const isWorkspaceOwner = user.role === "isoplus_user" && workspace?.user_role === "owner";
  const isWorkspaceAdmin = user.role === "isoplus_user" && workspace?.user_role === "admin";
  const canSeeBoardMeta = isOwnerOrSupportUser || isWorkspaceOwner || isWorkspaceAdmin;
  const canAccessThisWorkspace = canAccessBoard(user, workspace);
  const canAccessWorkspace = isIsoPlusWorkspaceMember(user, workspace);
  const adminBoardIds = useMemo(() => {
    if (!isWorkspaceAdmin) return null;
    const boardList = (workspace as any)?.board;
    if (!Array.isArray(boardList)) return null;
    const ids = boardList
      .map((b: any) => (typeof b === "object" ? b.id : b))
      .filter(Boolean)
      .map((b: any) => b.toString());
    return new Set(ids);
  }, [workspace, isWorkspaceAdmin]);
  const visibleBoards = useMemo(() => {
    if (isWorkspaceAdmin && adminBoardIds) {
      return boards.filter((board) => adminBoardIds.has(board.id?.toString()));
    }
    return boards;
  }, [adminBoardIds, boards, isWorkspaceAdmin]);

  const filteredBoards = useMemo(() => {
    const q = boardSearch.trim().toLowerCase();
    if (!q) return visibleBoards;
    return visibleBoards.filter((b) =>
      b.id?.toString().toLowerCase().includes(q) ||
      (b.name || "").toLowerCase().includes(q) ||
      (canSeeBoardMeta ? (b.label || "").toLowerCase().includes(q) : false)
    );
  }, [visibleBoards, boardSearch, canSeeBoardMeta]);
  const canOpenBoard = (_board: Board) => canAccessThisWorkspace;
  const openBoardTooltip = (board: Board) => {
    if (canOpenBoard(board)) return undefined;
    return "You don't have permission to open this board.";
  };

  useEffect(() => {
    if (id) {
      setCurrentWorkspaceId(id);
    }
    return () => {
      setCurrentWorkspaceId(null);
    };
  }, [id, setCurrentWorkspaceId]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedBoardQuery(boardSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [boardSearch]);

  useEffect(() => {
    const abortController = new AbortController();

    const fetchBoardsPage = async (after: string | null) => {
      setLoadingBoards(true);
      try {
        if (!after) {
          setBoards([]);
          setBoardsHasMore(false);
          setBoardsNextAfter(null);
        }

        const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/boards`, {
          signal: abortController.signal,
          params: {
            workspaceId: id,
            limit: 50,
            ...(after ? { after } : {}),
            ...(debouncedBoardQuery ? { q: debouncedBoardQuery } : {}),
          }
        });

        const list: Board[] = Array.isArray(response?.data?.board) ? response.data.board : [];
        if (!abortController.signal.aborted) {
          if (after) {
            const merged = [...boards, ...list];
            const deduped = Array.from(new Map(merged.map((b: any) => [String(b.id), b])).values());
            const sorted = [...deduped].sort((a: any, b: any) => (a?.name || '').localeCompare(b?.name || ''));
            setBoards(sorted);
          } else {
            setBoards(list);
          }
          setBoardsHasMore(Boolean(response?.data?.hasMore));
          setBoardsNextAfter(response?.data?.nextAfter || null);
          showFetchSuccessToast("Boards");
        }
      } catch (error: any) {
        if (error.name != "CanceledError" && error.name != "AbortError") {
          console.error("Error fetching boards:", error);
          showFetchErrorToast("boards", error.response?.data?.message || "Failed to load boards");
        }
      } finally {
        if (!abortController.signal.aborted) {
          setLoadingBoards(false);
        }
      }
    };

    if (workspace === undefined) {
      return;
    }

    if (!canAccessThisWorkspace) {
      router.replace("/workspace/access-denied");
      return;
    }

    fetchBoardsPage(null);

    return () => {
      abortController.abort();
    };
  }, [id, workspace, canAccessThisWorkspace, router, debouncedBoardQuery]);

  const loadMoreBoards = async () => {
    if (loadingMoreBoards) return;
    if (!boardsHasMore) return;
    if (!boardsNextAfter) return;

    setLoadingMoreBoards(true);
    try {
      const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/boards`, {
        params: {
          workspaceId: id,
          limit: 50,
          after: boardsNextAfter,
          ...(debouncedBoardQuery ? { q: debouncedBoardQuery } : {}),
        }
      });

      const list: Board[] = Array.isArray(response?.data?.board) ? response.data.board : [];
      const merged = [...boards, ...list];
      const deduped = Array.from(new Map(merged.map((b: any) => [String(b.id), b])).values());
      const sorted = [...deduped].sort((a: any, b: any) => (a?.name || '').localeCompare(b?.name || ''));
      setBoards(sorted);
      setBoardsHasMore(Boolean(response?.data?.hasMore));
      setBoardsNextAfter(response?.data?.nextAfter || null);
    } catch (error: any) {
      console.error("Error fetching more boards:", error);
      showFetchErrorToast("boards", error.response?.data?.message || "Failed to load more boards");
    } finally {
      setLoadingMoreBoards(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto animate-fade-in-up py-8">
        <BackButton onClick={() => router.push("/dashboard")}>
          Back to Dashboard
        </BackButton>

        <div className="page-enter-stagger space-y-6">
          {/* Workspace Info */}
          <Card className="p-6 shadow-lg card-hover">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold mb-2 bg-clip-text text-transparent bg-gradient-to-r from-primary to-primary/80">
                  {workspace?.name}
                </h1>
                <p className="text-muted-foreground font-mono text-sm">ID: {workspace?.id}</p>
              </div>
              {isOwnerOrSupportUser && (
                <Button
                  onClick={() => router.push(`/workspace/${workspace?.id}/usage-report`)}
                  variant="outline"
                  className="gap-2"
                >
                  <BarChart className="h-4 w-4" />
                  View Usage Report
                </Button>
              )}
            </div>
          </Card>

          {/* Workspace Actions — admin/owner (Finance, Configure Business, Audit) */}
          {
            canAccessWorkspace && (
              <div className="grid grid-cols-1 items-stretch gap-6 md:grid-cols-2 lg:grid-cols-4">
                <Card className="card-hover flex h-full flex-col p-6">
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                    <Building2 className="h-6 w-6 text-primary" />
                  </div>
                  <h2 className="text-xl font-semibold">Business Configuration</h2>
                  <p className="mb-4 flex-1 text-sm text-muted-foreground">
                    Manage your business details, address, and tax information
                  </p>
                  <Button
                    onClick={() => router.push(`/workspace/${workspace?.id}/configure-business`)}
                    className="mt-auto w-full"
                  >
                    <span>Configure Business</span>
                  </Button>
                </Card>

                <Card className="card-hover flex h-full flex-col p-6">
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                    <FileSpreadsheet className="h-6 w-6 text-primary" />
                  </div>
                  <h2 className="text-xl font-semibold">Finance Settings & Automation</h2>
                  <p className="mb-4 flex-1 text-sm text-muted-foreground">
                    Manage bank details, payment terms, document numbering, integrations, and billing automation.
                  </p>
                  <Button
                    onClick={() => router.push(`/workspace/${workspace?.id}/finance-settings`)}
                    className="mt-auto w-full"
                  >
                    <span>Open</span>
                  </Button>
                </Card>

                <Card className="card-hover flex h-full flex-col p-6">
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                    <History className="h-6 w-6 text-primary" />
                  </div>
                  <h2 className="text-xl font-semibold">Audit Trail</h2>
                  <p className="mb-4 flex-1 text-sm text-muted-foreground">
                    Track all activities and changes in your workspace
                  </p>
                  <Button
                    onClick={() => router.push(`/workspace/${workspace?.id}/audit-trail`)}
                    className="mt-auto w-full"
                  >
                    <span>View Audit Trail</span>
                  </Button>
                </Card>

                {isOwnerOrSupportUser && (
                  <Card className="card-hover flex h-full flex-col p-6">
                    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                      <Terminal className="h-6 w-6 text-primary" />
                    </div>
                    <h2 className="text-xl font-semibold">Workspace Configuration</h2>
                    <p className="mb-4 flex-1 text-sm text-muted-foreground">
                      Configure workspace settings and manage board links
                    </p>
                    <Button
                      onClick={() => router.push(`/workspace/${workspace?.id}/configuration`)}
                      className="mt-auto w-full"
                    >
                      <span>Configure Workspace</span>
                    </Button>
                  </Card>
                )}
              </div>
            )
          }

          {/* Boards */}
          <Card className="p-6 shadow-lg">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
              <div>
                <h2 className="text-xl font-semibold mb-2">Workspace Boards</h2>
              </div>
              <div className="w-full md:w-80">
                <Input
                  placeholder={canSeeBoardMeta ? "Search by board ID, name, or label..." : "Search by board ID or name..."}
                  value={boardSearch}
                  onChange={(e) => setBoardSearch(e.target.value)}
                />
              </div>
            </div>

            {loadingBoards ? (
              <div className="text-center py-8 text-muted-foreground">
                Loading boards...
                <span className="ml-2"><Spinner /></span>
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="font-semibold">Board ID</TableHead>
                      <TableHead className="font-semibold">Name</TableHead>
                      {
                        isOwnerOrSupportUser && (
                          <TableHead className={`font-semibold ${canSeeBoardMeta ? '' : 'hidden'}`}>
                            <div className="flex items-center gap-2">
                              Label
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-xs">
                                    Label your boards to enable specific integration features and automations.
                                    Different board types have access to different features.
                                    Unlabeled boards will operate normally.
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>
                          </TableHead>
                        )
                      }
                      <TableHead className="font-semibold w-[120px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredBoards?.map((board) => {
                      const boardIsOpenable = canOpenBoard(board);
                      const labelKey = (Object.prototype.hasOwnProperty.call(LABEL_COLORS, board.label) ? board.label : 'No Label') as BoardLabel;
                      return (
                        <TableRow key={board.id}>
                          <TableCell className="font-mono">{board.id}</TableCell>
                          <TableCell>{board.name}</TableCell>
                          {
                            isOwnerOrSupportUser && (
                              <TableCell className={`font-semibold ${canSeeBoardMeta ? '' : 'hidden'}`}>
                                <Badge variant="outline" className={LABEL_COLORS[labelKey]}>
                                  {(board.label as BoardLabel) || 'No Label'}
                                </Badge>
                              </TableCell>
                            )
                          }
                          <TableCell>
                            <div className="flex w-[120px] items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!boardIsOpenable}
                                title={openBoardTooltip(board)}
                                onClick={() => router.push(`/workspace/${workspace?.id}/board/${board.id}`)}
                              >
                                Open
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>

                {filteredBoards.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    No boards found matching your search.
                  </div>
                )}

                {boardsHasMore && (
                  <div className="flex justify-center pt-6">
                    <Button variant="outline" onClick={loadMoreBoards} disabled={loadingMoreBoards}>
                      {loadingMoreBoards ? "Loading..." : "Load more boards"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      </div>
    </div >
  );
}