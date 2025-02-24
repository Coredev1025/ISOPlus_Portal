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
import { useState } from "react";
import { Search } from "lucide-react";
import { Header } from "@/components/ui/header";

const workspaces = [
  { id: "ws-001", name: "Marketing Team" },
  { id: "ws-002", name: "Development Team" },
  { id: "ws-003", name: "Sales Department" },
  { id: "ws-004", name: "Customer Support" },
  { id: "ws-005", name: "Human Resources" },
  { id: "ws-006", name: "Product Management" },
  { id: "ws-007", name: "Finance Team" },
  { id: "ws-008", name: "Design Studio" },
  { id: "ws-009", name: "Operations" },
  { id: "ws-010", name: "Research & Development" },
  { id: "ws-011", name: "Quality Assurance" },
  { id: "ws-012", name: "Legal Department" },
  { id: "ws-013", name: "IT Infrastructure" },
  { id: "ws-014", name: "Content Creation" }
];

export default function Dashboard() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");

  const filteredWorkspaces = workspaces.filter(workspace => 
    workspace.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
    workspace.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto py-8 space-y-8">
        {/* User Profile Section */}
        <div className="bg-card rounded-lg p-6 shadow-sm">
          <div className="flex items-center space-x-4">
            <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center">
              <span className="text-2xl font-semibold">JD</span>
            </div>
            <div>
              <h2 className="text-2xl font-bold">John Doe</h2>
              <p className="text-muted-foreground">john.doe@example.com</p>
            </div>
          </div>
        </div>

        {/* Workspaces Table */}
        <div className="bg-card rounded-lg p-6 shadow-sm">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-semibold">Your Workspaces</h3>
            <div className="relative w-72">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Search by workspace ID or name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredWorkspaces.map((workspace) => (
                <TableRow key={workspace.id}>
                  <TableCell className="font-mono">{workspace.id}</TableCell>
                  <TableCell>{workspace.name}</TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => router.push(`/workspace/${workspace.id}`)}
                    >
                      Manage Workspace
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          
          {filteredWorkspaces.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No workspaces found matching your search.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}