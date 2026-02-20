"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Building2, FileSpreadsheet, FileText, BarChart, Info, History, Terminal } from "lucide-react";
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
import { isOwnerOrSupport } from "@/lib/access";
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
  const isOwnerOrSupportUser = isOwnerOrSupport(user);
  const isWorkspaceOwner = user.role === "isoplus_user" && workspace?.user_role === "owner";
  const isWorkspaceAdmin = user.role === "isoplus_user" && workspace?.user_role === "admin";
  const canSeeBoardMeta = isOwnerOrSupportUser || isWorkspaceOwner || isWorkspaceAdmin;
  const canAccessThisWorkspace = isOwnerOrSupportUser || isWorkspaceOwner || isWorkspaceAdmin;
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
  const canOpenBoard = (board: Board) => {
    return canAccessThisWorkspace;
  };
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
    const abortController = new AbortController();

    const fetchBoards = async () => {
      if (boards.length === 0) {
        setLoadingBoards(true);
        try {
          const response = await axios.get(
            `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/boards?workspaceId=${id}`,
            {
              signal: abortController.signal
            }
          );

          const data: Board[] = await Promise.all(
            response.data.board.map(async (board: any) => {
              try {
                const boardResponse = await axios.get(
                  `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/boards?id=${board.id}`,
                  {
                    signal: abortController.signal
                  }
                );
                return { ...board, label: boardResponse.data.board.label };
              } catch (error: any) {
                if (error.name != "CanceledError" && error.name != "AbortError") {
                  console.error("Error fetching board:", error);
                }
                return { ...board, label: null };
              }
            })
          );

          if (!abortController.signal.aborted) {
            setBoards(data);
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
      }
    };

    if (workspace === undefined) {
      return;
    }

    if (!canAccessThisWorkspace) {
      router.replace("/workspace/access-denied");
      return;
    }

    fetchBoards();

    return () => {
      abortController.abort();
    };
  }, [id, boards.length, workspace, canAccessThisWorkspace, router]);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto py-8">
        <Button
          variant="ghost"
          className="mb-6 hover:bg-secondary"
          onClick={() => router.push("/dashboard")}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Dashboard
        </Button>

        <div className="space-y-6">
          {/* Workspace Info */}
          <Card className="p-6 shadow-lg card-hover">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold mb-2 bg-clip-text text-transparent bg-gradient-to-r from-primary to-primary/80">
                  {workspace?.name}
                </h1>
                <p className="text-muted-foreground font-mono text-sm">ID: {workspace?.id}</p>
              </div>
              <Button
                onClick={() => router.push(`/workspace/${workspace?.id}/usage-report`)}
                variant="outline"
                className="gap-2 button-hover"
              >
                <BarChart className="h-4 w-4" />
                View Usage Report
              </Button>
            </div>
          </Card>

          {/* Workspace Actions */}
          {
            canAccessThisWorkspace && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <Card className="p-6 space-y-4 card-hover">
                  <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
                    <Building2 className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold">Business Configuration</h2>
                    <p className="text-muted-foreground mb-4 text-sm">
                      Manage your business details, address, and tax information
                    </p>
                    <Button
                      onClick={() => router.push(`/workspace/${workspace?.id}/configure-business`)}
                      className="w-full button-hover"
                    >
                      Configure Business
                    </Button>
                  </div>
                </Card>

                <Card className="p-6 space-y-4 card-hover">
                  <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
                    <FileSpreadsheet className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold">Xero Integration</h2>
                    <p className="text-muted-foreground mb-4 text-sm">
                      Connect and manage your Xero accounting integration
                    </p>
                    <Button
                      onClick={() => router.push(`/workspace/${workspace?.id}/xero-integration`)}
                      className="w-full button-hover"
                    >
                      Setup Xero
                    </Button>
                  </div>
                </Card>

                <Card className="p-6 space-y-4 card-hover">
                  <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
                    <History className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold">Audit Trail</h2>
                    <p className="text-muted-foreground mb-4 text-sm">
                      Track all activities and changes in your workspace
                    </p>
                    <Button
                      onClick={() => router.push(`/workspace/${workspace?.id}/audit-trail`)}
                      className="w-full button-hover"
                    >
                      View Audit Trail
                    </Button>
                  </div>
                </Card>

                {isOwnerOrSupportUser && (
                  <Card className="p-6 space-y-4 card-hover">
                    <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
                      <Terminal className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold">Workspace Configuration</h2>
                      <p className="text-muted-foreground mb-4 text-sm">
                        Configure workspace settings and manage board links
                      </p>
                      <Button
                        onClick={() => router.push(`/workspace/${workspace?.id}/configuration`)}
                        className="w-full button-hover"
                      >
                        Configure Workspace
                      </Button>
                    </div>
                  </Card>
                )}
              </div>
            )
          }

          {/* Boards List */}
          <Card className="p-6 shadow-lg">
            <h2 className="text-xl font-semibold mb-2">Workspace Boards</h2>
            <Table className="enhanced-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="font-semibold">Board ID</TableHead>
                  <TableHead className="font-semibold">Board Name</TableHead>
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
                  <TableHead className={`font-semibold w-[100px] ${canSeeBoardMeta ? '' : 'hidden'}`}>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleBoards?.map((board) => {
                  const boardIsOpenable = canOpenBoard(board);
                  return (
                  <TableRow key={board.id}>
                    <TableCell className="font-mono">{board.id}</TableCell>
                    <TableCell>{board.name}</TableCell>
                    <TableCell className={`font-semibold ${canSeeBoardMeta ? '' : 'hidden'}`}>
                      {board.label ? (
                        <Badge variant="outline" className={board.label ? LABEL_COLORS[board.label as NonNullable<BoardLabel>] : 'No Label'}>
                          {board.label}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className={LABEL_COLORS['No Label']}>
                          No Label
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className={`flex w-[100px] items-center gap-2 ${canSeeBoardMeta ? '' : 'hidden'}`}>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!boardIsOpenable}
                          title={openBoardTooltip(board)}
                          onClick={() => router.push(`/workspace/${workspace?.id}/board/${board.id}`)}
                        >
                          Open Board
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )})}
              </TableBody>
            </Table>
            {loadingBoards ?
              <div className="text-center py-8 text-muted-foreground">
                Loading boards...
                <span className="ml-2"><Spinner /></span>
              </div>
              : boards?.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  No boards found matching your search.
                </div>
              )}
          </Card>
        </div>
      </div>
    </div >
  );
}