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
import Spinner from "@/components/ui/spin";
import { useEffect, useState } from "react";
import axios from "axios";
import { Search } from "lucide-react";
import { Header } from "@/components/ui/header";
import { getCookie } from "../utils/cookies";
import { useAppContext } from "../context";

export default function Dashboard() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const { workspaces, setWorkspaces } = useAppContext();
  const [loading, setLoading] = useState(true);

  const filteredWorkspaces = workspaces.filter(item =>
    item.id.toString().includes(searchQuery.toLowerCase()) ||
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  useEffect(() => {
    getWorkspaces();
  }, []);

  const getWorkspaces = async () => {
    setLoading(true);
    try {
      const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/me`, { headers: { token: getCookie("token"), Authorization: getCookie("Authorization") } });
      setWorkspaces(response.data.workspace);
    } catch (error) {
      console.error("Error fetching workspaces:", error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto py-8 space-y-8">
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

          {loading ?
            <div className="text-center py-8 text-muted-foreground">
              Loading workspaces...
              <Spinner />
            </div>
            :
            <>
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
                    <TableRow key={workspace.id.toString()}>
                      <TableCell className="font-mono">{workspace.id.toString()}</TableCell>
                      <TableCell>{workspace.name}</TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (workspace.user_role !== "admin" && workspace.user_role !== "owner")
                              router.push(`/workspace/access-denied`);
                            else
                              router.push(`/workspace/${workspace.id}`)
                          }}
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
            </>
          }
        </div>
      </div>
    </div>
  );
}