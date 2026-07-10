type SyncBoardSnapshot = {
  boardId: string;
  boardName?: string;
  jobStatus?: { state?: string; failedReason?: string; processedOn?: string; progress?: Record<string, unknown> };
  syncExecution?: { status?: string; error?: { message?: string } };
  lastSyncError?: string;
  syncStats?: Record<string, unknown>;
  syncStatus?: string;
};

export function buildManualSyncStatus(board: SyncBoardSnapshot, previousSync?: { startTime?: number }) {
  const jobProgress = board.jobStatus?.progress || {};
  const syncStats = board.syncStats || {};
  const foldersProcessed = (jobProgress.foldersProcessed as number | undefined) ?? (syncStats.foldersProcessed as number | undefined) ?? 0;
  const totalFolders = (jobProgress.totalFolders as number | undefined) ?? 0;
  const currentFolder = (jobProgress.currentFolder as string | null | undefined) || null;
  const itemsProcessed = (jobProgress.itemsProcessed as number | undefined) ?? (syncStats.itemsSynced as number | undefined) ?? 0;
  const isFailed = board.jobStatus?.state === 'failed';

  return {
    boardId: board.boardId,
    boardName: board.boardName || board.boardId,
    status: board.jobStatus?.state === 'active' ? 'in-progress' as const :
      board.jobStatus?.state === 'failed' ? 'failed' as const : 'started' as const,
    syncType: board.syncStatus || 'manual_triggered_sync',
    startTime: board.jobStatus?.processedOn
      ? new Date(board.jobStatus.processedOn).toISOString()
      : previousSync?.startTime ? new Date(previousSync.startTime).toISOString() : new Date().toISOString(),
    progress: { foldersProcessed, totalFolders, currentFolder, itemsProcessed },
    isManualSync: true,
    error: isFailed ? {
      message: board.jobStatus?.failedReason || board.lastSyncError || 'Sync failed with unknown error',
      stack: null,
      details: null,
    } : null,
  };
}

export function getSyncBoardState(board: SyncBoardSnapshot) {
  const isManualSync = Boolean(
    board.jobStatus &&
    (board.jobStatus.state === 'active' || board.jobStatus.state === 'waiting' || board.jobStatus.state === 'failed'),
  );
  const isFailed = Boolean(
    (board.syncExecution && (board.syncExecution.status === 'failed' || board.syncExecution.status === 'timeout')) ||
    (board.jobStatus && board.jobStatus.state === 'failed'),
  );
  const isActive = Boolean(
    (board.syncExecution && (board.syncExecution.status === 'started' || board.syncExecution.status === 'in-progress')) ||
    (board.jobStatus && (board.jobStatus.state === 'active' || board.jobStatus.state === 'waiting')),
  );
  return { isManualSync, isFailed, isActive, isCompleted: (wasActive: boolean) => !isActive && !isFailed && wasActive };
}

function handleBoardNotFoundDuringSync(options: {
  timeSinceStart: number;
  boardNotFoundGraceMs: number;
  boardId: string;
  onCompleted?: () => void;
  showSuccessToast: (message: string, options?: { description?: string }) => void;
  setSyncStatuses: (updater: (prev: any[]) => any[]) => void;
  stopSyncChecking: () => void;
}) {
  if (options.timeSinceStart <= options.boardNotFoundGraceMs) return;
  options.showSuccessToast('Sync completed', {
    description: options.onCompleted
      ? 'The sync job has finished successfully. Refreshing data with latest records and clearing filters...'
      : 'The sync job has finished successfully.',
  });
  options.setSyncStatuses((prev) => prev.filter((s) => s.boardId !== options.boardId));
  options.stopSyncChecking();
  if (options.onCompleted) {
    setTimeout(options.onCompleted, 500);
  }
}

function updateManualSyncStatusEntry(
  board: SyncBoardSnapshot,
  boardId: string,
  previousSync: { startTime?: number } | null | undefined,
  setSyncStatuses: (updater: (prev: any[]) => any[]) => void,
  previousSyncStatusRef: { current: { boardId: string; status: string; startTime?: number } | null },
) {
  const updatedSyncStatus = buildManualSyncStatus(board, previousSync || undefined);
  setSyncStatuses((prev) => {
    const existingIndex = prev.findIndex((s) => s.boardId === boardId);
    if (existingIndex >= 0) {
      const updated = [...prev];
      updated[existingIndex] = updatedSyncStatus;
      return updated;
    }
    return [...prev, updatedSyncStatus];
  });
  previousSyncStatusRef.current = {
    boardId: board.boardId,
    status: updatedSyncStatus.status,
    startTime: previousSync?.startTime || Date.now(),
  };
}

function handleSyncCompleted(options: {
  boardId: string;
  onCompleted?: () => void;
  showSuccessToast: (message: string, options?: { description?: string }) => void;
  setSyncStatuses: (updater: (prev: any[]) => any[]) => void;
  stopSyncChecking: () => void;
}) {
  options.showSuccessToast('Sync completed', {
    description: options.onCompleted
      ? 'The sync job has finished successfully. Refreshing data with latest records and clearing filters...'
      : 'The sync job has finished successfully.',
  });
  options.setSyncStatuses((prev) => prev.filter((s) => s.boardId !== options.boardId));
  options.stopSyncChecking();
  if (options.onCompleted) {
    setTimeout(options.onCompleted, 500);
  }
}

export async function pollBoardManualSyncStatus({
  workspaceId,
  boardId,
  previousSync,
  axios,
  setSyncStatuses,
  previousSyncStatusRef,
  stopSyncChecking,
  showErrorToast,
  showSuccessToast,
  onCompleted,
  boardNotFoundGraceMs = 15000,
}: {
  workspaceId: string;
  boardId: string;
  previousSync: { boardId: string; status: string; startTime?: number } | null;
  axios: { get: (url: string) => Promise<{ data?: { boards?: SyncBoardSnapshot[] } }> };
  setSyncStatuses: (updater: (prev: any[]) => any[]) => void;
  previousSyncStatusRef: { current: { boardId: string; status: string; startTime?: number } | null };
  stopSyncChecking: () => void;
  showErrorToast: (message: string, options?: { description?: string }) => void;
  showSuccessToast: (message: string, options?: { description?: string }) => void;
  onCompleted?: () => void;
  boardNotFoundGraceMs?: number;
}) {
  const wasActive = Boolean(
    previousSync &&
    previousSync.boardId === boardId &&
    (previousSync.status === 'started' || previousSync.status === 'in-progress'),
  );
  if (!wasActive) return;

  const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/sync/workspace/status/${workspaceId}`);
  const boards = response.data?.boards;
  if (!boards) return;

  const board = boards.find((b) => b.boardId === boardId);
  if (!board) {
    const timeSinceStart = previousSync?.startTime ? Date.now() - previousSync.startTime : 0;
    handleBoardNotFoundDuringSync({
      timeSinceStart,
      boardNotFoundGraceMs,
      boardId,
      onCompleted,
      showSuccessToast,
      setSyncStatuses,
      stopSyncChecking,
    });
    return;
  }

  const { isManualSync, isFailed, isActive, isCompleted } = getSyncBoardState(board);
  const completed = isCompleted(wasActive);

  if (isManualSync) {
    updateManualSyncStatusEntry(board, boardId, previousSync, setSyncStatuses, previousSyncStatusRef);
  }

  if (isFailed && wasActive) {
    const errorMessage = board.jobStatus?.failedReason ||
      board.lastSyncError ||
      board.syncExecution?.error?.message ||
      'The sync job encountered an error. Please try again.';
    showErrorToast('Sync job failed', { description: errorMessage });
    stopSyncChecking();
    return;
  }

  if (completed) {
    handleSyncCompleted({ boardId, onCompleted, showSuccessToast, setSyncStatuses, stopSyncChecking });
  }
}

export async function pollInvoiceGeneratorSyncStatus(options: {
  workspaceId: string;
  boardId: string;
  previousSync: { boardId: string; status: string; startTime?: number } | null;
  axios: { get: (url: string) => Promise<{ data?: { boards?: SyncBoardSnapshot[] } }> };
  setSyncStatuses: (updater: (prev: any[]) => any[]) => void;
  previousSyncStatusRef: { current: { boardId: string; status: string; startTime?: number } | null };
  stopSyncChecking: () => void;
  handleManualRefresh: (silent?: boolean, clearFilters?: boolean) => void;
  showErrorToast: (message: string, options?: { description?: string }) => void;
  showSuccessToast: (message: string, options?: { description?: string }) => void;
}) {
  return pollBoardManualSyncStatus({
    ...options,
    onCompleted: () => options.handleManualRefresh(true, true),
  });
}
