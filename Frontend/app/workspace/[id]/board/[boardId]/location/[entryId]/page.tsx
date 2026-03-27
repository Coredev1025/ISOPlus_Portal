"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, MapPin, ExternalLink, Clock, User } from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useEffect, useState } from "react";
import { useAppContext } from "@/app/context";
import { TimeEntry } from "../../types";
import axios from "@/app/utils/axiosConfig";
import dynamic from "next/dynamic";

const LeafletMap = dynamic(
  () => import("@/components/ui/leaflet-map").then(m => m.LeafletMap),
  { ssr: false }
);

interface Board {
  id: string;
  name: string;
  label: string
}


export default function LocationDetailPage() {
  const router = useRouter();
  const pathname = usePathname();
  const { workspaces, setCurrentWorkspaceId } = useAppContext();
  const id = pathname.split("/")[2];
  const boardId = pathname.split("/")[4];
  const entryId = pathname.split("/").pop();
  const [board, setBoard] = useState<Board | null>(null);
  const [timeEntry, setTimeEntry] = useState<TimeEntry | null>(null);

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
    if (!id || !boardId || !entryId) return;
    const abortController = new AbortController();
    axios
      .get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/timetracks?workspaceId=${id}&boardId=${boardId}`, { signal: abortController.signal })
      .then(res => {
        const entry = (res.data.tasks as TimeEntry[]).find(e => e.id === entryId);
        if (entry) setTimeEntry(entry);
      })
      .catch(err => { if (err.name != "CanceledError" && err.name != "AbortError") console.error(err); });
    return () => abortController.abort();
  }, [id, boardId, entryId]);

  const workspace = workspaces.find(workspace => workspace.id.toString() === id);

  if (!workspace || !board || !timeEntry) {
    return null;
  }

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "—";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "Ongoing";
    const date = new Date(dateString);
    return date.toLocaleString('en-AU');
  };

  const openGoogleMaps = () => {
    if (timeEntry.location) {
      window.open(`https://www.google.com/maps/search/?api=1&query=${timeEntry.location.lat},${timeEntry.location.lng}`, '_blank');
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card className="p-6 shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold">Location</h2>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={openGoogleMaps}
              >
                <ExternalLink className="h-4 w-4" />
                Open in Google Maps
              </Button>
            </div>

            <div className="relative rounded-lg overflow-hidden mb-4">
              {timeEntry.location ? (
                <LeafletMap
                  height="400px"
                  markers={[{
                    id: timeEntry.id,
                    lat: timeEntry.location.lat,
                    lng: timeEntry.location.lng,
                    address: timeEntry.location.address,
                    label: timeEntry.taskName,
                  }]}
                />
              ) : (
                <div className="h-[400px] bg-muted flex flex-col items-center justify-center rounded-lg">
                  <MapPin className="h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-muted-foreground">No location data recorded</p>
                </div>
              )}
            </div>

            {timeEntry.location && (
              <div className="p-4 bg-muted/30 rounded-lg">
                <div className="flex items-start gap-3">
                  <MapPin className="h-5 w-5 text-primary mt-0.5" />
                  <div>
                    <h3 className="text-sm font-medium">{timeEntry.location.address}</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Location tracked at {formatDate(timeEntry.startTime)}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </Card>

          <Card className="p-6 shadow-lg">
            <h2 className="text-xl font-semibold mb-4">Time Entry Details</h2>

            <div className="space-y-4">
              <div className="p-4 border rounded-lg">
                <div className="flex items-start gap-3">
                  <Clock className="h-5 w-5 text-primary mt-0.5" />
                  <div>
                    <h3 className="text-sm font-medium">Duration</h3>
                    <p className="text-lg font-semibold">{formatDuration(timeEntry.duration)}</p>
                    <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                      <div>
                        <span className="font-medium">Start:</span> {formatDate(timeEntry.startTime)}
                      </div>
                      <div>
                      <span className="font-medium">End:</span> {formatDate(timeEntry.endTime)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-4 border rounded-lg">
                <h3 className="font-medium mb-2">Task Information</h3>
                <p className="text-lg font-semibold mb-1">{timeEntry.taskName}</p>
                {timeEntry.notes && (
                  <p className="text-muted-foreground">{timeEntry.notes}</p>
                )}
              </div>

              <div className="p-4 border rounded-lg">
                <div className="flex items-start gap-3">
                  <User className="h-5 w-5 text-primary mt-0.5" />
                  <div>
                    <h3 className="text-sm font-medium">Tracked By</h3>
                    <p className="font-semibold">{timeEntry.userName}</p>
                    <p className="text-sm text-muted-foreground">User ID: {timeEntry.userId}</p>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}