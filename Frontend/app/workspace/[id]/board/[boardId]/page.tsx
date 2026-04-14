"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Terminal, QrCode, FileText, FileBarChart } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useEffect, useState } from "react";
import { useAppContext } from "@/app/context/index";
import { Badge } from "@/components/ui/badge";
import axios from "@/app/utils/axiosConfig";
import { isCareManagementLabel, isLowCatCareManagementLabel, isOwnerOrSupport } from "@/lib/access";

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
  const [loadingBoards, setLoadingBoards] = useState(false);
  const isOwnerOrSupportUser = isOwnerOrSupport(user);
  const isWorkspaceOwner = user.role === "isoplus_user" && workspace?.user_role === "owner";
  const isWorkspaceAdmin = user.role === "isoplus_user" && workspace?.user_role === "admin";
  const canAccessThisWorkspace = isOwnerOrSupportUser || isWorkspaceOwner || isWorkspaceAdmin;

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
                    Create QR codes for your forms, documents, or any other links.
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

            </div>)}
        </div>
      </div>
    </div>
  );
}