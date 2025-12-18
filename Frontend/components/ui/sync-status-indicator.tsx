"use client";

import { useAppContext } from "@/app/context";
import { useEffect, useRef, useState } from "react";
import axios from "@/app/utils/axiosConfig";
import { RefreshCw, Clock, Database, Loader2, AlertCircle, XCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export function SyncStatusIndicator() {
  const { syncStatuses, setSyncStatuses, currentWorkspaceId } = useAppContext();
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [currentTime, setCurrentTime] = useState(Date.now());

  // Calculate elapsed time in seconds
  const getElapsedTime = (startTime: string, currentTime: number): number => {
    const start = new Date(startTime).getTime();
    return Math.floor((currentTime - start) / 1000);
  };

  // Format time as HH:MM:SS
  const formatElapsedTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Poll for sync status
  const pollSyncStatus = async () => {
    if (!currentWorkspaceId) return;

    try {
      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/sync/workspace/status/${currentWorkspaceId}`
      );

      if (response.data && response.data.boards) {
        // Filter boards that have active syncs OR recently failed syncs
        // Check for both syncExecution and jobStatus to catch manual syncs
        const activeSyncs = response.data.boards
          .filter((board: any) => {
            // Check if there's an active syncExecution
            const hasActiveSyncExecution = board.syncExecution && 
              (board.syncExecution.status === 'started' || board.syncExecution.status === 'in-progress') &&
              board.syncExecution.syncType !== 'realtime_sync';
            
            // Check if there's a failed syncExecution (show for 5 minutes after failure)
            const hasFailedSyncExecution = board.syncExecution && 
              (board.syncExecution.status === 'failed' || board.syncExecution.status === 'timeout') &&
              board.syncExecution.syncType !== 'realtime_sync' &&
              board.syncExecution.endTime &&
              (Date.now() - new Date(board.syncExecution.endTime).getTime()) < 60 * 1000; 
            
            // Check if there's an active jobStatus (for manual syncs)
            const hasActiveJobStatus = board.jobStatus && 
              (board.jobStatus.state === 'active' || board.jobStatus.state === 'waiting') &&
              board.syncStatus !== 'realtime_sync';
            
            // Check if there's a failed jobStatus (show for 5 minutes after failure)
            const hasFailedJobStatus = board.jobStatus && 
              board.jobStatus.state === 'failed' &&
              board.syncStatus !== 'realtime_sync' &&
              board.jobStatus.finishedOn &&
              (Date.now() - new Date(board.jobStatus.finishedOn).getTime()) < 5 * 60 * 1000; // 5 minutes
            
            return hasActiveSyncExecution || hasFailedSyncExecution || hasActiveJobStatus || hasFailedJobStatus;
          })
          .map((board: any) => {
            // Determine if this is a manual sync (has jobStatus) or regular sync (has syncExecution)
            const isManualSync = board.jobStatus && 
              (board.jobStatus.state === 'active' || board.jobStatus.state === 'waiting' || board.jobStatus.state === 'failed');
            
            // Check if sync is failed
            const isFailed = (board.syncExecution && (board.syncExecution.status === 'failed' || board.syncExecution.status === 'timeout')) ||
                            (board.jobStatus && board.jobStatus.state === 'failed');
            
            if (isManualSync) {
              // For manual syncs, use jobStatus.progress for both folders and items
              const jobProgress = board.jobStatus?.progress || {};
              const syncStats = board.syncStats || {};
              
              // Get error information
              const errorMessage = board.jobStatus?.failedReason || 
                                  board.lastSyncError || 
                                  (board.syncExecution?.error?.message) ||
                                  'Sync failed with unknown error';
              
              // Extract folder progress from jobStatus.progress
              const foldersProcessed = jobProgress.foldersProcessed ?? syncStats.foldersProcessed ?? 0;
              const totalFolders = jobProgress.totalFolders ?? 0;
              const currentFolder = jobProgress.currentFolder || null;
              
              // Extract item counters from jobStatus.progress (real-time), fallback to syncStats
              const itemsProcessed = jobProgress.itemsProcessed ?? syncStats.itemsSynced ?? 0;
              
              return {
                boardId: board.boardId,
                boardName: board.boardName || board.boardId,
                status: board.jobStatus.state === 'active' ? 'in-progress' : 
                        board.jobStatus.state === 'failed' ? 'failed' : 'started',
                syncType: board.syncStatus || 'manual_triggered_sync',
                startTime: board.jobStatus.processedOn 
                  ? new Date(board.jobStatus.processedOn).toISOString()
                  : new Date().toISOString(),
                duration: board.jobStatus.finishedOn && board.jobStatus.processedOn
                  ? board.jobStatus.finishedOn - board.jobStatus.processedOn
                  : undefined,
                // Use jobStatus.progress for folder and item counters
                progress: {
                  foldersProcessed: foldersProcessed,
                  totalFolders: totalFolders,
                  currentFolder: currentFolder,
                  itemsProcessed: itemsProcessed
                },
                isManualSync: true,
                error: isFailed ? {
                  message: errorMessage,
                  stack: board.syncExecution?.error?.stack || null,
                  details: board.syncExecution?.error?.details || null
                } : null
              };
            } else {
              // For regular syncs, use syncExecution data
              const errorMessage = board.syncExecution?.error?.message || 
                                  board.lastSyncError || 
                                  'Sync failed with unknown error';
              
              // Extract progress and counters from syncExecution, with fallbacks
              const syncProgress = board.syncExecution.progress || {};
              const syncCounters = board.syncExecution.counters || {};
              const syncStats = board.syncStats || {};
              
              return {
                boardId: board.boardId,
                boardName: board.boardName || board.boardId,
                status: board.syncExecution.status,
                syncType: board.syncExecution.syncType,
                startTime: board.syncExecution.startTime,
                duration: board.syncExecution.duration,
                // Use syncExecution.progress, fallback to syncStats for folders
                progress: {
                  foldersProcessed: syncProgress.foldersProcessed ?? syncStats.foldersProcessed ?? 0,
                  totalFolders: syncProgress.totalFolders ?? 0,
                  currentFolder: syncProgress.currentFolder || null,
                  currentPage: syncProgress.currentPage,
                  totalPages: syncProgress.totalPages,
                  itemsProcessed: syncCounters.itemsProcessed ?? syncStats.itemsSynced ?? 0
                },
                isManualSync: false,
                error: isFailed ? {
                  message: errorMessage,
                  stack: board.syncExecution.error?.stack || null,
                  details: board.syncExecution.error?.details || null
                } : null
              };
            }
          });

        setSyncStatuses(activeSyncs);
      }
    } catch (error: any) {
      // Silently fail - don't disrupt the user experience
      console.error('Failed to poll sync status:', error);
    }
  };

  // Start polling when workspace changes
  useEffect(() => {
    if (currentWorkspaceId) {
      // Initial poll
      pollSyncStatus();

      // Set up polling interval (every 10 seconds)
      pollingIntervalRef.current = setInterval(pollSyncStatus, 10000);
    } else {
      // Clear sync statuses if no workspace
      setSyncStatuses([]);
    }

    // Cleanup on unmount or workspace change
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [currentWorkspaceId]);

  // Update current time every second for elapsed time calculation
  // This ensures elapsed time updates smoothly while sync data comes from context
  useEffect(() => {
    if (syncStatuses.length === 0) return;

    const timerInterval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);

    return () => clearInterval(timerInterval);
  }, [syncStatuses.length]);

  // Don't render if no active syncs
  if (syncStatuses.length === 0) {
    return null;
  }

  return (
    <div className="fixed top-20 right-4 z-50 space-y-2 max-w-sm animate-in slide-in-from-right-5">
      {syncStatuses.map((sync) => {
        // Use currentTime state to ensure elapsed time updates every second
        // while sync data (counters, progress) comes directly from context
        const elapsedSeconds = getElapsedTime(sync.startTime, currentTime);
        const progressPercent = sync.progress?.totalFolders 
          ? Math.round((sync.progress.foldersProcessed || 0) / sync.progress.totalFolders * 100)
          : 0;
        
        // Get latest counters and progress from context (updated every 10 seconds via polling)
        // These values will automatically update when context changes
        // For manual syncs: progress (including itemsProcessed) comes from jobStatus.progress
        // For regular syncs: progress comes from syncExecution
        const itemsProcessed = sync.progress?.itemsProcessed ?? 0;
        const foldersProcessed = sync.progress?.foldersProcessed ?? 0;
        const totalFolders = sync.progress?.totalFolders ?? 0;
        const isManualSync = (sync as any).isManualSync || false;
        const isFailed = sync.status === 'failed' || sync.status === 'timeout';
        const error = (sync as any).error;

        return (
          <Card 
            key={sync.boardId} 
            className={`p-4 bg-background/95 backdrop-blur shadow-lg ${
              isFailed 
                ? 'border-destructive/50 border-2' 
                : 'border-primary/50'
            }`}
          >
            <div className="flex items-start gap-3">
              {/* Animated sync icon or error icon */}
              <div className="flex-shrink-0 mt-1">
                {isFailed ? (
                  <div className="relative">
                    <XCircle className="h-5 w-5 text-destructive" />
                    <div className="absolute inset-0 bg-destructive/20 rounded-full blur-sm animate-pulse" />
                  </div>
                ) : (
                  <div className="relative">
                    <RefreshCw className="h-5 w-5 text-primary animate-spin" />
                    <div className="absolute inset-0 bg-primary/20 rounded-full blur-sm animate-pulse" />
                  </div>
                )}
              </div>

              {/* Content */}
              <div className="flex-1 space-y-2">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <h3 className={`font-semibold text-sm ${isFailed ? 'text-destructive' : ''}`}>
                    {isFailed ? 'Sync Failed' : 'Syncing Data'}
                  </h3>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    <span className="font-mono">{formatElapsedTime(elapsedSeconds)}</span>
                  </div>
                </div>

                {/* Board name */}
                <div className="text-sm text-muted-foreground">
                  <span className="font-medium">{sync.boardName}</span>
                </div>

                {/* Error message - show prominently for failed syncs */}
                {isFailed && error && (
                  <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 space-y-1">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                      <div className="flex-1 space-y-1">
                        <p className="text-xs font-medium text-destructive">
                          Error
                        </p>
                        <p className="text-xs text-destructive/90 break-words">
                          {error.message}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Progress bar - uses latest data from context */}
                {!isFailed && (
                  <div className="space-y-1">
                    {totalFolders > 0 && (
                      <>
                        <Progress value={progressPercent} className="h-1.5" />
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>
                            Folder {foldersProcessed} of {totalFolders}
                          </span>
                          <span>{progressPercent}%</span>
                        </div>
                      </>
                    )}
                    {totalFolders === 0 && foldersProcessed === 0 && (
                      <div className="text-xs text-muted-foreground">
                        Initializing sync...
                      </div>
                    )}
                  </div>
                )}

                {/* Stats - uses latest counters from context */}
                {!isFailed && (
                  <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                    {/* Item processed count - always show, even if 0 initially */}
                    <div className="flex items-center gap-1">
                      <Database className="h-3 w-3" />
                      <span>
                        {itemsProcessed > 0 ? `${itemsProcessed} items processed` : 'No items processed yet'}
                      </span>
                    </div>
                    {/* Sync type */}
                    {sync.syncType && (
                      <div className="flex items-center gap-1">
                        <Loader2 className="h-3 w-3" />
                        <span className="capitalize">{sync.syncType.replace(/_/g, ' ')}</span>
                      </div>
                    )}
                  </div>
                )}
                
                {/* Show partial progress for failed syncs */}
                {isFailed && (itemsProcessed > 0 || foldersProcessed > 0) && (
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
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}