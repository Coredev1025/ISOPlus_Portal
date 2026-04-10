"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Clock, MapPin, AlertTriangle, Loader2 } from "lucide-react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { getDistance } from 'geolib';
import axios from "@/app/utils/axiosConfig";

interface Task {
  id: string;
  name: string;
  location?: {
    latitude: number;
    longitude: number;
    address: string;
  };
}

const PROXIMITY_THRESHOLD = 50;

interface TimeTrackingButtonProps {
  workspaceId: string;
  boardId: string;
  setTimeTrackingEnabled: any;
  onSessionChange?: () => void;
}

export function TimeTrackingButton({ workspaceId, boardId, setTimeTrackingEnabled, onSessionChange }: TimeTrackingButtonProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isTracking, setIsTracking] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [showProximityWarning, setShowProximityWarning] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [startTime, setStartTime] = useState<Date | null>(null);
  const [endTime, setEndTime] = useState<Date | null>(null);
  const [currentTime, setCurrentTime] = useState<Date>(new Date());
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const pendingPositionRef = useRef<GeolocationPosition | null>(null);

  useEffect(() => {
    if (!isTracking) return;
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, [isTracking]);

  useEffect(() => {
    let cancelled = false;
    axios
      .get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/timetracks/tasks`, { params: { workspaceId, boardId } })
      .then(res => { if (!cancelled) setTasks(res.data.tasks || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [workspaceId, boardId]);

  useEffect(() => {
    let cancelled = false;
    axios
      .get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/timetracks/status`, { params: { workspaceId, boardId } })
      .then(res => {
        if (cancelled) return;
        const active = res.data.active;
        if (active) {
          const task = tasks.find(t => t.id === active.itemId) || { id: active.itemId, name: active.taskName };
          setIsTracking(true);
          setSelectedTask(task);
          setStartTime(new Date(active.startTime));
          setTimeTrackingEnabled(true);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [workspaceId, boardId, tasks.length]);

  const formatDuration = (start: Date, end: Date) => {
    const diff = Math.floor((end.getTime() - start.getTime()) / 1000);
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const tryGetLocation = (): Promise<GeolocationPosition | null> => {
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => resolve(pos),
        () => resolve(null),
        { timeout: 8000, maximumAge: 30000 }
      );
    });
  };

  const checkTaskProximity = (position: GeolocationPosition, task: Task) => {
    if (!task.location) return true;
    const distance = getDistance(
      { latitude: position.coords.latitude, longitude: position.coords.longitude },
      { latitude: task.location.latitude, longitude: task.location.longitude }
    );
    return distance <= PROXIMITY_THRESHOLD;
  };

  const buildDeviceLocationBody = (gps: GeolocationPosition | null) => {
    if (!gps) return null;
    return { lat: gps.coords.latitude, lng: gps.coords.longitude, address: null as string | null };
  };

  const callStartApi = async (task: Task, gps: GeolocationPosition | null) => {
    const body: Record<string, unknown> = { workspaceId, boardId, itemId: task.id };
    const loc = buildDeviceLocationBody(gps);
    if (loc) body.location = loc;
    const res = await axios.post(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/timetracks/start`, body);
    return res.data;
  };

  const handleStartTracking = async () => {
    if (!selectedTask || isStarting) return;
    setIsStarting(true);
    setStartError(null);

    try {
      const position = await tryGetLocation();

      if (position && selectedTask.location && !checkTaskProximity(position, selectedTask)) {
        pendingPositionRef.current = position;
        setIsStarting(false);
        setShowTaskDialog(false);
        setShowProximityWarning(true);
        return;
      }

      const data = await callStartApi(selectedTask, position);
      setStartTime(new Date(data.startTime));
      setIsTracking(true);
      setTimeTrackingEnabled(true);
      setShowTaskDialog(false);
      onSessionChange?.();
    } catch (err: any) {
      if (err?.response?.status === 409 && err.response.data?.activeItemId) {
        const activeItemId = err.response.data.activeItemId;
        const activeTask = tasks.find(t => t.id === activeItemId) || { id: activeItemId, name: activeItemId };
        setSelectedTask(activeTask);
        setIsTracking(true);
        setTimeTrackingEnabled(true);
        setShowTaskDialog(false);
        onSessionChange?.();
      } else {
        const msg = err?.response?.data?.message || err?.message || 'Failed to start tracking';
        setStartError(msg);
      }
    } finally {
      setIsStarting(false);
    }
  };

  const handleProximityOverride = async () => {
    if (!selectedTask || isStarting) return;
    setIsStarting(true);
    setStartError(null);
    try {
      const data = await callStartApi(selectedTask, pendingPositionRef.current);
      setStartTime(new Date(data.startTime));
      setIsTracking(true);
      setTimeTrackingEnabled(true);
      setShowProximityWarning(false);
      onSessionChange?.();
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || 'Failed to start tracking';
      setStartError(msg);
      setShowProximityWarning(false);
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopTracking = async () => {
    if (!selectedTask || isStopping) return;
    setIsStopping(true);
    try {
      const gps = await tryGetLocation();
      const body: Record<string, unknown> = { workspaceId, boardId, itemId: selectedTask.id };
      const loc = buildDeviceLocationBody(gps);
      if (loc) body.location = loc;
      await axios.post(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/timetracks/stop`, body);
      setEndTime(new Date());
      setIsTracking(false);
      setTimeTrackingEnabled(false);
      setShowSummary(true);
      onSessionChange?.();
    } catch (err: any) {
      console.error('Failed to stop time tracking', err);
    } finally {
      setIsStopping(false);
    }
  };

  const handleClockInClick = () => {
    setSelectedTask(null);
    setStartError(null);
    setShowTaskDialog(true);
  };

  return (
    <>
      {!isTracking && !showSummary && (
        <Button
          size="lg"
          className="gap-2"
          onClick={handleClockInClick}
        >
          <Clock className="h-5 w-5" />
          Clock In
        </Button>
      )}

      {isTracking && (
        <Card className="p-4 bg-primary/5 border-primary">
          <div className="text-center space-y-2">
            <p className="text-sm text-muted-foreground">Currently working on</p>
            <p className="font-medium">{selectedTask?.name}</p>
            <p className="text-2xl font-mono font-bold">
              {startTime && formatDuration(startTime, currentTime)}
            </p>
            <Button
              variant="destructive"
              disabled={isStopping}
              onClick={handleStopTracking}
            >
              {isStopping ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Clocking Out…</> : 'Clock Out'}
            </Button>
          </div>
        </Card>
      )}

      {/* Task Selection Dialog */}
      <AlertDialog open={showTaskDialog} onOpenChange={(open) => { if (!isStarting) setShowTaskDialog(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Select Task</AlertDialogTitle>
            <AlertDialogDescription>
              Choose a task to start tracking time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Select
              value={selectedTask?.id || ""}
              onValueChange={(value) => {
                setSelectedTask(tasks.find(task => task.id === value) || null);
                setStartError(null);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder={tasks.length === 0 ? "No tasks available" : "Select a task"} />
              </SelectTrigger>
              <SelectContent>
                {tasks.map(task => (
                  <SelectItem key={task.id} value={task.id}>
                    {task.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedTask?.location && (
              <div className="mt-3 p-3 bg-muted rounded-lg flex items-start gap-2">
                <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="text-sm">
                  <p className="font-medium">Task Location</p>
                  <p className="text-muted-foreground">{selectedTask.location.address}</p>
                </div>
              </div>
            )}
            {startError && (
              <p className="mt-3 text-sm text-destructive flex items-center gap-1">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {startError}
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isStarting}>Cancel</AlertDialogCancel>
            <Button
              disabled={!selectedTask || isStarting}
              onClick={handleStartTracking}
            >
              {isStarting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Starting…</> : 'Start Tracking'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Proximity Warning Dialog */}
      <AlertDialog open={showProximityWarning} onOpenChange={(open) => { if (!isStarting) setShowProximityWarning(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Not at Task Location
            </AlertDialogTitle>
            <AlertDialogDescription>
              You appear to be more than {PROXIMITY_THRESHOLD} metres away from the task location.
              Do you want to start tracking anyway?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isStarting} onClick={() => setShowProximityWarning(false)}>
              Cancel
            </AlertDialogCancel>
            <Button
              disabled={isStarting}
              onClick={handleProximityOverride}
            >
              {isStarting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Starting…</> : 'Continue Anyway'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Time Tracking Summary */}
      <AlertDialog open={showSummary} onOpenChange={setShowSummary}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Time Tracking Summary</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="py-4 space-y-4">
            <div>
              <h4 className="text-sm font-medium mb-1">Task</h4>
              <p>{selectedTask?.name}</p>
            </div>
            <div>
              <h4 className="text-sm font-medium mb-1">Duration</h4>
              <p className="text-xl font-mono">
                {startTime && endTime && formatDuration(startTime, endTime)}
              </p>
              <div className="mt-2 text-sm text-muted-foreground">
                <p>Started: {startTime?.toLocaleString('en-AU')}</p>
                <p>Ended: {endTime?.toLocaleString('en-AU')}</p>
              </div>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => {
              setShowSummary(false);
              setSelectedTask(null);
              setStartTime(null);
              setEndTime(null);
            }}>
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
