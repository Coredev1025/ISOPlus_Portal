"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, ExternalLink, Search, Calendar } from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useEffect, useState } from "react";
import { TimeEntry } from "../types";
import { Input } from "@/components/ui/input";
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
import { useAppContext } from "@/app/context";
import axios from "@/app/utils/axiosConfig";
import dynamic from "next/dynamic";

const LeafletMap = dynamic(
  () => import("@/components/ui/leaflet-map").then(m => m.LeafletMap),
  { ssr: false }
);

interface Board {
  id: string;
  name: string;
  label: string;
}

export default function MapViewPage() {
  const router = useRouter();
  const pathname = usePathname();
  const { workspaces, setCurrentWorkspaceId } = useAppContext();
  const [board, setBoard] = useState<Board | null>(null);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [tasks, setTasks] = useState<{ id: string; name: string; location?: { latitude: number; longitude: number; address: string } }[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<TimeEntry | null>(null);
  const [dateFilter, setDateFilter] = useState<string>("all");
  const id = pathname.split("/")[2];
  const boardId = pathname.split("/")[4];

  useEffect(() => {
    if (id) {
      setCurrentWorkspaceId(id);
    }
    return () => {
      setCurrentWorkspaceId(null);
    };
  }, [id, setCurrentWorkspaceId]);

  useEffect(() => {
    if (!id || !boardId) return;
    const abortController = new AbortController();
    axios
      .get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/boards?id=${boardId}`, { signal: abortController.signal })
      .then(res => setBoard(res.data.board))
      .catch(err => { if (err.name != "CanceledError" && err.name != "AbortError") console.error(err); });
    return () => abortController.abort();
  }, [id, boardId]);

  useEffect(() => {
    if (!id || !boardId) return;
    const abortController = new AbortController();
    axios
      .get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/timetracks?workspaceId=${id}&boardId=${boardId}`, { signal: abortController.signal })
      .then(res => {
        const withLocation = (res.data.tasks as TimeEntry[]).filter(e => e.location?.lat && e.location?.lng);
        setTimeEntries(withLocation);
      })
      .catch(err => { if (err.name != "CanceledError" && err.name != "AbortError") console.error(err); });
    return () => abortController.abort();
  }, [id, boardId]);

  useEffect(() => {
    if (!id || !boardId) return;
    const abortController = new AbortController();
    axios
      .get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/timetracks/tasks`, { params: { workspaceId: id, boardId }, signal: abortController.signal })
      .then(res => setTasks(res.data.tasks || []))
      .catch(err => { if (err.name != "CanceledError" && err.name != "AbortError") console.error(err); });
    return () => abortController.abort();
  }, [id, boardId]);

  const workspace = workspaces.find((workspace) => workspace.id.toString() === id);

  if (!workspace || !board) {
    return null;
  }

  const filteredEntries = timeEntries.filter((entry) => {
    const matchesSearch = entry.taskName.toLowerCase().includes(searchQuery.toLowerCase());

    let matchesDate = true;
    if (dateFilter !== "all") {
      const entryDate = new Date(entry.startTime);
      const today = new Date();

      if (dateFilter === "today") {
        matchesDate = entryDate.toDateString() === today.toDateString();
      } else if (dateFilter === "yesterday") {
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        matchesDate = entryDate.toDateString() === yesterday.toDateString();
      } else if (dateFilter === "thisWeek") {
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - today.getDay());
        matchesDate = entryDate >= weekStart;
      }
    }

    return matchesSearch && matchesDate;
  });

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-AU');
  };

  const openGoogleMaps = (location: TimeEntry["location"]) => {
    if (location) {
      window.open(`https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lng}`, "_blank");
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto py-8">
        <Button
          variant="ghost"
          className="mb-6"
          onClick={() => router.push(`/workspace/${id}/board/${boardId}`)}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Board
        </Button>

        <Card className="p-6 shadow-lg">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold">Location Map View</h1>
              <p className="text-muted-foreground">
                View all time entries with location data for {board.name}
              </p>
            </div>
          </div>

          {/* Search and Filter */}
          <div className="flex flex-wrap gap-4 mb-6">
            <div className="flex-1 min-w-[200px]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                <Input
                  placeholder="Search by task name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            <div className="w-[200px]">
              <Select value={dateFilter} onValueChange={setDateFilter}>
                <SelectTrigger>
                  <Calendar className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Filter by date" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Dates</SelectItem>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="yesterday">Yesterday</SelectItem>
                  <SelectItem value="thisWeek">This Week</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Map View */}
          <div className="rounded-lg overflow-hidden mb-6">
            {(() => {
              const taskMarkers = tasks
                .filter(t => t.location?.latitude && t.location?.longitude)
                .map(t => ({
                  id: `task-${t.id}`,
                  lat: t.location!.latitude,
                  lng: t.location!.longitude,
                  address: t.location!.address,
                  label: `📍 ${t.name}`,
                }));
              const entryMarkers = filteredEntries.map(e => ({
                id: e.id,
                lat: e.location!.lat,
                lng: e.location!.lng,
                address: e.location?.address,
                label: e.taskName,
              }));
              const allMarkers = [...taskMarkers, ...entryMarkers];
              return allMarkers.length === 0 ? (
                <div className="h-[500px] bg-muted flex items-center justify-center rounded-lg">
                  <p className="text-muted-foreground">No location data to display</p>
                </div>
              ) : (
                <LeafletMap
                  height="500px"
                  markers={allMarkers}
                  onMarkerClick={marker => {
                    const entry = filteredEntries.find(e => e.id === marker.id) ?? null;
                    setSelectedEntry(prev => prev?.id === marker.id ? null : entry);
                  }}
                />
              );
            })()}
          </div>

          {/* Selected entry card */}
          {selectedEntry && (
            <div className="mb-6 p-4 border rounded-lg bg-card shadow flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="font-semibold">{selectedEntry.taskName}</h3>
                <p className="text-sm text-muted-foreground">{formatDate(selectedEntry.startTime)} · {selectedEntry.userName}</p>
                {selectedEntry.location?.address && (
                  <p className="text-sm mt-1">{selectedEntry.location.address}</p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="outline" size="sm" onClick={() => router.push(`/workspace/${id}/board/${boardId}/location/${selectedEntry.id}`)}>
                  View Details
                </Button>
                <Button variant="outline" size="sm" onClick={() => openGoogleMaps(selectedEntry.location)}>
                  <ExternalLink className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setSelectedEntry(null)}>×</Button>
              </div>
            </div>
          )}

          {/* Location List */}
          <div>
            <h2 className="text-xl font-semibold mb-4">All Locations</h2>
            {filteredEntries.length === 0 ? (
              <p className="text-center py-8 text-muted-foreground">No time entries with location data found.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Task</TableHead>
                    <TableHead>Date & Time</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEntries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">{entry.taskName}</TableCell>
                      <TableCell>{formatDate(entry.startTime)}</TableCell>
                      <TableCell>{entry.userName}</TableCell>
                      <TableCell>{entry.location?.address || `${entry.location?.lat?.toFixed(4)}, ${entry.location?.lng?.toFixed(4)}`}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => router.push(`/workspace/${id}/board/${boardId}/location/${entry.id}`)}
                          >
                            View
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openGoogleMaps(entry.location)}
                          >
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}