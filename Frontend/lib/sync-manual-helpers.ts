export function isValidRouteIdParam(value: unknown): value is string {
  return Boolean(
    value &&
    typeof value === 'string' &&
    value.trim() !== '' &&
    value !== 'undefined' &&
    value !== 'null',
  );
}

export function getBoardNameFromSession(boardId: string): string {
  try {
    const currentBoardData = sessionStorage.getItem('currentBoard');
    if (!currentBoardData) return boardId;
    const boardData = JSON.parse(currentBoardData);
    return boardData.boardName || boardId;
  } catch {
    return boardId;
  }
}

export type SyncStatusSnapshot = {
  status?: string;
};

export function isSyncActiveStatus(sync: SyncStatusSnapshot | undefined): boolean {
  return Boolean(sync && (sync.status === 'started' || sync.status === 'in-progress'));
}

export function isSyncCompletedStatus(sync: SyncStatusSnapshot | undefined): boolean {
  return sync?.status === 'completed';
}

export function isSyncFailedStatus(sync: SyncStatusSnapshot | undefined): boolean {
  return sync?.status === 'failed' || sync?.status === 'timeout';
}

export type SyncRefreshMode = 'completed' | 'active' | 'failed' | 'default';

export function getSyncRefreshMode(sync: SyncStatusSnapshot | undefined): SyncRefreshMode {
  if (isSyncCompletedStatus(sync)) return 'completed';
  if (isSyncActiveStatus(sync)) return 'active';
  if (isSyncFailedStatus(sync)) return 'failed';
  return 'default';
}
