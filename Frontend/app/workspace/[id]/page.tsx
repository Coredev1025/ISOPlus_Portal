"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Building2, FileSpreadsheet, FileText, BarChart, Wand2, Info, History } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useEffect, useState } from "react";
import { Header } from "@/components/ui/header";
import { useAppContext, Workspace } from "@/app/context";
import axios from "axios";
import { getCookie } from "@/app/utils/cookies";
import Spinner from "@/components/ui/spin";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type BoardLabel = 'Job Management' | 'NDIS' | null;

const BOARD_LABELS: NonNullable<BoardLabel>[] = [
  'Job Management',
  'NDIS'
];

const LABEL_COLORS: Record<NonNullable<BoardLabel>, string> = {
  'Job Management': 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
  'NDIS': 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-300'
};

interface Board {
  id: number;
  name: string;
  label?: BoardLabel;
}

interface SuggestionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  suggestion: string | null;
  reason: string;
}

function SuggestionDialog({ isOpen, onClose, onConfirm, suggestion, reason }: SuggestionDialogProps) {
  return (
    <AlertDialog open={isOpen} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Label Suggestion</AlertDialogTitle>
          <AlertDialogDescription>
            {reason}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>No, keep current</AlertDialogCancel>
          {suggestion && (
            <AlertDialogAction onClick={onConfirm}>Yes, update label</AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function WorkspaceDetail() {
  const router = useRouter();
  const { workspaces } = useAppContext();
  const [workspace, setWorkspace] = useState<Workspace | undefined>(undefined);
  const [boards, setBoards] = useState<Board[] | undefined>(undefined);
  const [loadingBoards, setLoadingBoards] = useState<boolean>(true); // Loading state for boards
  const [suggestionDialog, setSuggestionDialog] = useState<{
    isOpen: boolean;
    boardId: string;
    suggestion: BoardLabel;
    reason: string;
  }>({
    isOpen: false,
    boardId: '',
    suggestion: null,
    reason: ''
  });

  useEffect(() => {
    const id = window.location.pathname.split('/').pop();
    const result = workspaces.find((item) => item.id.toString() === id);

    if (result) {
      setWorkspace(result);
      getBoards(result.id.toString());
    }
  }, [workspaces, router]);

  const getBoards = async (id: string) => {
    setLoadingBoards(true);
    try {
      const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/boards?workspaceID=${id}`, { headers: { token: getCookie("token"), Authorization: getCookie("Authorization") } });
      setBoards(response.data.board);
    } catch (error) {
      console.error("Error fetching boards:", error);
    } finally {
      setLoadingBoards(false);
    }
  }

  const handleLabelChange = (boardId: string, newLabel: BoardLabel) => {
    setBoards(
      boards?.map(board =>
        board.id === Number(boardId) ? { ...board, label: newLabel } : board
      ) || []
    );
  };

  const suggestLabel = (boardId: string) => {
    const board = boards?.find(b => b.id.toString() === boardId);
    if (!board) return;

    const name = board.name.toLowerCase();
    let suggestion: BoardLabel = null;
    let reason = '';

    if (name.includes('job management')) {
      suggestion = 'Job Management';
      reason = "Based on the board name containing 'Job Management', we suggest labeling this as a Job Management board.";
    } else if (name.includes('ndis')) {
      suggestion = 'NDIS';
      reason = "Based on the board name containing 'NDIS', we suggest labeling this as an NDIS board.";
    } else {
      reason = "We couldn't automatically determine the board type based on its name. Please select a label manually if needed.";
    }

    setSuggestionDialog({
      isOpen: true,
      boardId,
      suggestion,
      reason
    });
  };

  const handleSuggestionConfirm = () => {
    handleLabelChange(suggestionDialog.boardId, suggestionDialog.suggestion);
    setSuggestionDialog(prev => ({ ...prev, isOpen: false }));
  };

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
                <FileText className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-semibold">PDF Output</h2>
                <p className="text-muted-foreground mb-4 text-sm">
                  Configure PDF generation and digital signature options
                </p>
                <Button
                  onClick={() => router.push(`/workspace/${workspace?.id}/pdf-output`)}
                  className="w-full button-hover"
                >
                  Setup PDF Output
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
          </div>

          {/* Boards List */}
          <Card className="p-6 shadow-lg">
            <h2 className="text-xl font-semibold mb-2">Workspace Boards</h2>
            <p className="text-sm text-muted-foreground mb-6">
              Boards that require integration with external systems or automation features should be labeled as either 'Job Management' or 'NDIS'.
              Unlabeled boards will function normally but won't be included in automated processes.
            </p>
            {
              loadingBoards ?
                <div className="text-center py-8 text-muted-foreground">
                  Loading boards...
                  <Spinner />
                </div>
                : <>
                  <Table className="enhanced-table">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="font-semibold">Board ID</TableHead>
                        <TableHead className="font-semibold">Board Name</TableHead>
                        <TableHead className="font-semibold">
                          <div className="flex items-center gap-2">
                            Label
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs">
                                  Label your boards as 'Job Management' or 'NDIS' to enable integration features.
                                  Unlabeled boards will operate normally.
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                        </TableHead>
                        <TableHead className="font-semibold w-[100px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {boards?.map((board) => (
                        <TableRow key={board.id}>
                          <TableCell className="font-mono">{board.id}</TableCell>
                          <TableCell>{board.name}</TableCell>
                          <TableCell>
                            <Select
                              value={board.label || "none"}
                              onValueChange={(value) => handleLabelChange(board.id.toString(), value === "none" ? null : value as BoardLabel)}
                            >
                              <SelectTrigger className="w-[200px]">
                                <SelectValue>
                                  {board.label ? (
                                    <Badge variant="outline" className={LABEL_COLORS[board.label]}>
                                      {board.label}
                                    </Badge>
                                  ) : (
                                    "No Label"
                                  )}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">No Label</SelectItem>
                                {BOARD_LABELS.map((label) => (
                                  <SelectItem key={label} value={label}>
                                    <Badge variant="outline" className={LABEL_COLORS[label]}>
                                      {label}
                                    </Badge>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                suggestLabel(board.id.toString());
                              }}
                            >
                              <Wand2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {boards?.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground">
                      No boards found matching your search.
                    </div>
                  )}
                </>
            }
          </Card>
        </div>
      </div>

      <SuggestionDialog
        isOpen={suggestionDialog.isOpen}
        onClose={() => setSuggestionDialog(prev => ({ ...prev, isOpen: false }))}
        onConfirm={handleSuggestionConfirm}
        suggestion={suggestionDialog.suggestion}
        reason={suggestionDialog.reason}
      />
    </div>
  );
}