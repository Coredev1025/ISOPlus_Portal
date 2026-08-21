"use client";

import { useAppContext } from "@/app/context";
import { useEffect, useRef, useState } from "react";
import axios from "@/app/utils/axiosConfig";
import { RefreshCw, Clock, Database, Loader2, AlertCircle, XCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

const MANUAL_SYNC_STATES = new Set(['active', 'waiting', 'failed']);
const FAILED_EXECUTION_STATUSES = new Set(['failed', 'timeout']);
const ACTIVE_EXECUTION_STATUSES = new Set(['started', 'in-progress']);
/** Catch-up from the portal cron — no floating progress card. */
const HIDDEN_INDICATOR_SYNC_TYPES = new Set(['scheduled_sync', 'realtime_sync']);

function buildSyncError(board: any, message: string) {
  return {
    message,
    stack: board.syncExecution?.error?.stack || null,
    details: board.syncExecution?.error?.details || null,
  };
}

function isHiddenFromIndicator(board: any) {
  const syncType = board.syncExecution?.syncType || board.syncStatus;
  return HIDDEN_INDICATOR_SYNC_TYPES.has(syncType);
}

function isManualSyncBoard(board: any) {
  return MANUAL_SYNC_STATES.has(board.jobStatus?.state);
}

function isFailedSyncBoard(board: any) {
  return FAILED_EXECUTION_STATUSES.has(board.syncExecution?.status)
    || board.jobStatus?.state === 'failed';
}

function mapManualSyncBoard(board: any) {
  const jobProgress = board.jobStatus?.progress || {};
  const syncStats = board.syncStats || {};
  const isFailed = isFailedSyncBoard(board);
  const errorMessage = board.jobStatus?.failedReason
    || board.lastSyncError
    || board.syncExecution?.error?.message
    || 'Sync failed with unknown error';

  return {
    boardId: board.boardId,
    boardName: board.boardName || board.boardId,
    status: board.jobStatus.state === 'active' ? 'in-progress'
      : board.jobStatus.state === 'failed' ? 'failed' : 'started',
    syncType: board.syncStatus || 'manual_triggered_sync',
    startTime: board.jobStatus.processedOn
      ? new Date(board.jobStatus.processedOn).toISOString()
      : new Date().toISOString(),
    duration: board.jobStatus.finishedOn && board.jobStatus.processedOn
      ? board.jobStatus.finishedOn - board.jobStatus.processedOn
      : undefined,
    progress: {
      foldersProcessed: jobProgress.foldersProcessed ?? syncStats.foldersProcessed ?? 0,
      totalFolders: jobProgress.totalFolders ?? 0,
      currentFolder: jobProgress.currentFolder || null,
      itemsProcessed: jobProgress.itemsProcessed ?? syncStats.itemsSynced ?? 0,
    },
    isManualSync: true,
    error: isFailed ? buildSyncError(board, errorMessage) : null,
  };
}

function mapExecutionSyncBoard(board: any) {
  const isFailed = isFailedSyncBoard(board);
  const syncProgress = board.syncExecution.progress || {};
  const syncCounters = board.syncExecution.counters || {};
  const syncStats = board.syncStats || {};
  const errorMessage = board.syncExecution?.error?.message
    || board.lastSyncError
    || 'Sync failed with unknown error';

  return {
    boardId: board.boardId,
    boardName: board.boardName || board.boardId,
    status: board.syncExecution.status,
    syncType: board.syncExecution.syncType,
    startTime: board.syncExecution.startTime,
    duration: board.syncExecution.duration,
    progress: {
      foldersProcessed: syncProgress.foldersProcessed ?? syncStats.foldersProcessed ?? 0,
      totalFolders: syncProgress.totalFolders ?? 0,
      currentFolder: syncProgress.currentFolder || null,
      currentPage: syncProgress.currentPage,
      totalPages: syncProgress.totalPages,
      itemsProcessed: syncCounters.itemsProcessed ?? syncStats.itemsSynced ?? 0,
    },
    isManualSync: false,
    error: isFailed ? buildSyncError(board, errorMessage) : null,
  };
}

function mapSyncBoardFromPoll(board: any) {
  return isManualSyncBoard(board)
    ? mapManualSyncBoard(board)
    : mapExecutionSyncBoard(board);
}

function isRecentFailure(timestamp: string | number | undefined, windowMs: number) {
  if (!timestamp) return false;
  return (Date.now() - new Date(timestamp).getTime()) < windowMs;
}

function hasActiveSyncExecution(board: any) {
  const execution = board.syncExecution;
  return execution
    && ACTIVE_EXECUTION_STATUSES.has(execution.status)
    && !HIDDEN_INDICATOR_SYNC_TYPES.has(execution.syncType);
}

function hasFailedSyncExecution(board: any) {
  const execution = board.syncExecution;
  return execution
    && FAILED_EXECUTION_STATUSES.has(execution.status)
    && !HIDDEN_INDICATOR_SYNC_TYPES.has(execution.syncType)
    && isRecentFailure(execution.endTime, 60 * 1000);
}

function hasActiveJobStatus(board: any) {
  const jobStatus = board.jobStatus;
  return jobStatus
    && (jobStatus.state === 'active' || jobStatus.state === 'waiting')
    && !isHiddenFromIndicator(board);
}

function hasFailedJobStatus(board: any) {
  const jobStatus = board.jobStatus;
  return jobStatus
    && jobStatus.state === 'failed'
    && !isHiddenFromIndicator(board)
    && isRecentFailure(jobStatus.finishedOn, 5 * 60 * 1000);
}

function isActiveSyncBoard(board: any) {
  return hasActiveSyncExecution(board)
    || hasFailedSyncExecution(board)
    || hasActiveJobStatus(board)
    || hasFailedJobStatus(board);
}

function getElapsedTime(startTime: string, currentTime: number): number {
  const start = new Date(startTime).getTime();
  return Math.floor((currentTime - start) / 1000);
}

function formatElapsedTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

type SyncStatusCardProps = {
  sync: any;
  currentTime: number;
};

function SyncStatusIcon({ isFailed }: { isFailed: boolean }) {
  if (isFailed) {
    return (
      <div className="relative">
        <XCircle className="h-5 w-5 text-destructive" />
        <div className="absolute inset-0 bg-destructive/20 rounded-full blur-sm animate-pulse" />
      </div>
    );
  }

  return (
    <div className="relative">
      <RefreshCw className="h-5 w-5 text-primary animate-spin" />
      <div className="absolute inset-0 bg-primary/20 rounded-full blur-sm animate-pulse" />
    </div>
  );
}

function SyncErrorPanel({ error }: { error: { message: string } }) {
  return (
    <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 space-y-1">
      <div className="flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
        <div className="flex-1 space-y-1">
          <p className="text-xs font-medium text-destructive">Error</p>
          <p className="text-xs text-destructive/90 break-words">{error.message}</p>
        </div>
      </div>
    </div>
  );
}

function SyncProgressPanel({
  totalFolders,
  foldersProcessed,
  progressPercent,
}: {
  totalFolders: number;
  foldersProcessed: number;
  progressPercent: number;
}) {
  if (totalFolders > 0) {
    return (
      <>
        <Progress value={progressPercent} className="h-1.5" />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Folder {foldersProcessed} of {totalFolders}</span>
          <span>{progressPercent}%</span>
        </div>
      </>
    );
  }

  if (foldersProcessed === 0) {
    return <div className="text-xs text-muted-foreground">Initializing sync...</div>;
  }

  return null;
}

function SyncStatsPanel({ sync, itemsProcessed }: { sync: any; itemsProcessed: number }) {
  return (
    <div className="flex flex-col gap-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-1">
        <Database className="h-3 w-3" />
        <span>
          {itemsProcessed > 0 ? `${itemsProcessed} items processed` : 'No items processed yet'}
        </span>
      </div>
      {sync.syncType && (
        <div className="flex items-center gap-1">
          <Loader2 className="h-3 w-3" />
          <span className="capitalize">{sync.syncType.replace(/_/g, ' ')}</span>
        </div>
      )}
    </div>
  );
}

function SyncFailureStats({
  itemsProcessed,
  foldersProcessed,
  totalFolders,
}: {
  itemsProcessed: number;
  foldersProcessed: number;
  totalFolders: number;
}) {
  if (itemsProcessed <= 0 && !(foldersProcessed > 0 && totalFolders > 0)) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      {itemsProcessed > 0 && (
        <div className="flex items-center gap-1">
          <Database className="h-3 w-3" />
          <span>{itemsProcessed} items processed before failure</span>
        </div>
      )}
      {foldersProcessed > 0 && totalFolders > 0 && (
        <div className="text-xs text-muted-foreground">
          Completed {foldersProcessed} of {totalFolders} folders
        </div>
      )}
    </div>
  );
}

function SyncStatusCard({ sync, currentTime }: SyncStatusCardProps) {
  const elapsedSeconds = getElapsedTime(sync.startTime, currentTime);
  const progressPercent = sync.progress?.totalFolders
    ? Math.round((sync.progress.foldersProcessed || 0) / sync.progress.totalFolders * 100)
    : 0;
  const itemsProcessed = sync.progress?.itemsProcessed ?? 0;
  const foldersProcessed = sync.progress?.foldersProcessed ?? 0;
  const totalFolders = sync.progress?.totalFolders ?? 0;
  const isFailed = sync.status === 'failed' || sync.status === 'timeout';
  const error = sync.error;

  return (
    <Card
      className={`p-4 bg-background/95 backdrop-blur shadow-lg ${
        isFailed
          ? 'border-destructive/50 border-2'
          : 'border-primary/50'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-1">
          <SyncStatusIcon isFailed={isFailed} />
        </div>

        <div className="flex-1 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className={`font-semibold text-sm ${isFailed ? 'text-destructive' : ''}`}>
              {isFailed ? 'Sync Failed' : 'Syncing Data'}
            </h3>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span className="font-mono">{formatElapsedTime(elapsedSeconds)}</span>
            </div>
          </div>

          <div className="text-sm text-muted-foreground">
            <span className="font-medium">{sync.boardName}</span>
          </div>

          {isFailed && error && <SyncErrorPanel error={error} />}

          {!isFailed && (
            <div className="space-y-1">
              <SyncProgressPanel
                totalFolders={totalFolders}
                foldersProcessed={foldersProcessed}
                progressPercent={progressPercent}
              />
            </div>
          )}

          {!isFailed && <SyncStatsPanel sync={sync} itemsProcessed={itemsProcessed} />}

          {isFailed && (
            <SyncFailureStats
              itemsProcessed={itemsProcessed}
              foldersProcessed={foldersProcessed}
              totalFolders={totalFolders}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

export function SyncStatusIndicator() {
  const {
    syncStatuses,
    setSyncStatuses,
    setWorkspaceBoardStatuses,
    currentWorkspaceId,
  } = useAppContext();
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [currentTime, setCurrentTime] = useState(Date.now());

  const pollSyncStatus = async () => {
    if (!currentWorkspaceId) return;

    try {
      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/sync/workspace/status/${currentWorkspaceId}`
      );

      if (response.data?.boards) {
        setWorkspaceBoardStatuses(response.data.boards);
        const activeSyncs = response.data.boards
          .filter((board: any) => isActiveSyncBoard(board))
          .map((board: any) => mapSyncBoardFromPoll(board));

        setSyncStatuses(activeSyncs);
      }
    } catch (error: any) {
      console.error('Failed to poll sync status:', error);
    }
  };

  useEffect(() => {
    if (currentWorkspaceId) {
      pollSyncStatus();
      pollingIntervalRef.current = setInterval(pollSyncStatus, 10000);
    } else {
      setSyncStatuses([]);
      setWorkspaceBoardStatuses([]);
    }

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [currentWorkspaceId, setSyncStatuses, setWorkspaceBoardStatuses]);

  useEffect(() => {
    if (syncStatuses.length === 0) return;

    const timerInterval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);

    return () => clearInterval(timerInterval);
  }, [syncStatuses.length]);

  if (syncStatuses.length === 0) {
    return null;
  }

  return (
    <div className="fixed top-20 right-4 z-50 space-y-2 max-w-sm animate-in slide-in-from-right-5">
      {syncStatuses.map((sync) => (
        <SyncStatusCard key={sync.boardId} sync={sync} currentTime={currentTime} />
      ))}
    </div>
  );
}
