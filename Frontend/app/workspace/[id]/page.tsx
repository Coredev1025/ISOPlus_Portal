"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Building2, FileSpreadsheet } from "lucide-react";
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
import { useAppContext } from "@/app/context";
import axios from "axios";
import { getCookie } from "@/app/utils/cookies";
import Spinner from "@/components/ui/spin";

interface Workspace {
  id: number;
  name: string;
}

interface Board {
  id: number;
  name: string;
}

export default function WorkspaceDetail() {
  const router = useRouter();
  const { workspaces } = useAppContext();
  const [workspace, setWorkspace] = useState<Workspace | undefined>(undefined);
  const [boards, setBoards] = useState<Board[] | undefined>(undefined);
  const [loadingBoards, setLoadingBoards] = useState<boolean>(true); // Loading state for boards

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

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto py-8">
        <Button
          variant="ghost"
          className="mb-6"
          onClick={() => router.push("/dashboard")}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Dashboard
        </Button>

        <div className="space-y-6 max-w-4xl mx-auto">
          <Card className="p-6">
            <h1 className="text-2xl font-bold mb-2">{workspace?.name}</h1>
            <p className="text-muted-foreground font-mono">ID: {workspace?.id}</p>
          </Card>

          <div className="grid md:grid-cols-2 gap-4">
            <Card className="p-6 space-y-4">
              <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
                <Building2 className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-semibold">Business Configuration</h2>
                <p className="text-muted-foreground mb-4">
                  Manage your business details, address, and tax information
                </p>
                <Button
                  onClick={() => router.push(`/workspace/${workspace?.id}/configure-business`)}
                  className="w-full"
                >
                  Configure Business
                </Button>
              </div>
            </Card>

            <Card className="p-6 space-y-4">
              <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
                <FileSpreadsheet className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-semibold">Xero Integration</h2>
                <p className="text-muted-foreground mb-4">
                  Connect and manage your Xero accounting integration
                </p>
                <Button
                  onClick={() => router.push(`/workspace/${workspace?.id}/xero-integration`)}
                  className="w-full"
                >
                  Setup Xero
                </Button>
              </div>
            </Card>
          </div>

          {/* Boards List */}
          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-4">Workspace Boards</h2>
            {loadingBoards ?
              <div className="text-center py-8 text-muted-foreground">
                Loading Boards...
                <Spinner />
              </div> :
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Board ID</TableHead>
                    <TableHead>Board Name</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {boards?.map((board) => (
                    <TableRow key={board.id}>
                      <TableCell className="font-mono">{board.id}</TableCell>
                      <TableCell>{board.name}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            }
            {boards?.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                No boards found matching your search.
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}