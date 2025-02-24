"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Building2, FileSpreadsheet } from "lucide-react";
import { useRouter } from "next/navigation";
import { workspaces } from "./page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useEffect } from "react";
import { Header } from "@/components/ui/header";

// Simulated access control - in a real app, this would come from your auth system
const hasAccess = (workspaceId: string): boolean => {
  // Extract the numeric part from the workspace ID
  const numericPart = parseInt(workspaceId.split('-')[1]);
  // Deny access to every third workspace (when numericPart % 3 === 0)
  return numericPart % 3 !== 0;
};

export default function WorkspaceDetail({ params }: { params: { id: string } }): JSX.Element {
  const router = useRouter();
  const workspace = workspaces[params.id as keyof typeof workspaces];

  useEffect(() => {
    if (!workspace) {
      router.push("/404");
      return;
    }

    if (!hasAccess(workspace.id)) {
      router.push("/access-denied");
    }
  }, [workspace, router]);

  // Return empty fragment while redirecting
  if (!workspace || !hasAccess(workspace.id)) {
    return <></>;
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
          {/* Workspace Info */}
          <Card className="p-6">
            <h1 className="text-2xl font-bold mb-2">{workspace.name}</h1>
            <p className="text-muted-foreground font-mono">ID: {workspace.id}</p>
          </Card>

          {/* Workspace Actions */}
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
                  onClick={() => router.push(`/workspace/${workspace.id}/configure-business`)}
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
                  onClick={() => router.push(`/workspace/${workspace.id}/xero-integration`)}
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Board ID</TableHead>
                  <TableHead>Board Name</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workspace.boards.map((board) => (
                  <TableRow key={board.id}>
                    <TableCell className="font-mono">{board.id}</TableCell>
                    <TableCell>{board.name}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      </div>
    </div>
  );
}