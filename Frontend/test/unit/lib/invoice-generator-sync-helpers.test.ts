import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  buildManualSyncStatus,
  getSyncBoardState,
  pollBoardManualSyncStatus,
  pollInvoiceGeneratorSyncStatus,
} from '@/lib/invoice-generator-sync-helpers';

const NOW_ISO = '2026-03-15T09:00:00.000Z';
const STARTED_AT = Date.parse('2026-03-15T08:55:00.000Z');

beforeEach(() => {
  process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:4001';
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildManualSyncStatus', () => {
  it('maps an active BullMQ job to an in-progress status with its own progress counters', () => {
    expect(
      buildManualSyncStatus({
        boardId: 'board-9',
        boardName: 'Care Management - NDIS',
        syncStatus: 'manual_triggered_sync',
        jobStatus: {
          state: 'active',
          processedOn: '2026-03-15T08:55:00.000Z',
          progress: { foldersProcessed: 2, totalFolders: 5, currentFolder: 'March 2026', itemsProcessed: 120 },
        },
        syncStats: { foldersProcessed: 99, itemsSynced: 999 },
      }),
    ).toEqual({
      boardId: 'board-9',
      boardName: 'Care Management - NDIS',
      status: 'in-progress',
      syncType: 'manual_triggered_sync',
      startTime: '2026-03-15T08:55:00.000Z',
      progress: { foldersProcessed: 2, totalFolders: 5, currentFolder: 'March 2026', itemsProcessed: 120 },
      isManualSync: true,
      error: null,
    });
  });

  it('falls back to the persisted sync stats when the job reports no progress', () => {
    const status = buildManualSyncStatus(
      {
        boardId: 'board-9',
        jobStatus: { state: 'waiting' },
        syncStats: { foldersProcessed: 3, itemsSynced: 40 },
      },
      { startTime: STARTED_AT },
    );

    expect(status.status).toBe('started');
    expect(status.progress).toEqual({
      foldersProcessed: 3,
      totalFolders: 0,
      currentFolder: null,
      itemsProcessed: 40,
    });
    expect(status.startTime).toBe('2026-03-15T08:55:00.000Z');
  });

  it('prefers a zero from the live job over a stale stat', () => {
    const status = buildManualSyncStatus({
      boardId: 'board-9',
      jobStatus: { state: 'active', progress: { foldersProcessed: 0, itemsProcessed: 0 } },
      syncStats: { foldersProcessed: 7, itemsSynced: 700 },
    });
    expect(status.progress).toEqual({
      foldersProcessed: 0,
      totalFolders: 0,
      currentFolder: null,
      itemsProcessed: 0,
    });
  });

  it('defaults the name, sync type, counters and start time when the snapshot is bare', () => {
    expect(buildManualSyncStatus({ boardId: 'board-9' })).toEqual({
      boardId: 'board-9',
      boardName: 'board-9',
      status: 'started',
      syncType: 'manual_triggered_sync',
      startTime: NOW_ISO,
      progress: { foldersProcessed: 0, totalFolders: 0, currentFolder: null, itemsProcessed: 0 },
      isManualSync: true,
      error: null,
    });
  });

  it('normalises an empty current folder to null', () => {
    const status = buildManualSyncStatus({
      boardId: 'board-9',
      jobStatus: { state: 'active', progress: { currentFolder: '' } },
    });
    expect(status.progress.currentFolder).toBeNull();
  });

  it('reports a failed job with the queue failure reason', () => {
    const status = buildManualSyncStatus({
      boardId: 'board-9',
      jobStatus: { state: 'failed', failedReason: 'ISO+ returned 502' },
      lastSyncError: 'older error',
    });
    expect(status.status).toBe('failed');
    expect(status.error).toEqual({ message: 'ISO+ returned 502', stack: null, details: null });
  });

  it('falls back to the last recorded sync error, then to a generic message', () => {
    expect(
      buildManualSyncStatus({ boardId: 'board-9', jobStatus: { state: 'failed' }, lastSyncError: 'timed out' }).error,
    ).toEqual({ message: 'timed out', stack: null, details: null });
    expect(buildManualSyncStatus({ boardId: 'board-9', jobStatus: { state: 'failed' } }).error).toEqual({
      message: 'Sync failed with unknown error',
      stack: null,
      details: null,
    });
  });
});

describe('getSyncBoardState', () => {
  it('treats an active queue job as a manual, active sync', () => {
    const state = getSyncBoardState({ boardId: 'b', jobStatus: { state: 'active' } });
    expect(state.isManualSync).toBe(true);
    expect(state.isActive).toBe(true);
    expect(state.isFailed).toBe(false);
  });

  it('treats a waiting queue job as manual and active too', () => {
    const state = getSyncBoardState({ boardId: 'b', jobStatus: { state: 'waiting' } });
    expect(state.isManualSync).toBe(true);
    expect(state.isActive).toBe(true);
  });

  it('does not treat a completed queue job as a manual sync', () => {
    const state = getSyncBoardState({ boardId: 'b', jobStatus: { state: 'completed' } });
    expect(state.isManualSync).toBe(false);
    expect(state.isActive).toBe(false);
    expect(state.isFailed).toBe(false);
  });

  it('flags a failed or timed-out sync execution as failed without calling it manual', () => {
    expect(getSyncBoardState({ boardId: 'b', syncExecution: { status: 'failed' } })).toMatchObject({
      isFailed: true,
      isManualSync: false,
      isActive: false,
    });
    expect(getSyncBoardState({ boardId: 'b', syncExecution: { status: 'timeout' } }).isFailed).toBe(true);
  });

  it('flags a started or in-progress sync execution as active', () => {
    expect(getSyncBoardState({ boardId: 'b', syncExecution: { status: 'started' } }).isActive).toBe(true);
    expect(getSyncBoardState({ boardId: 'b', syncExecution: { status: 'in-progress' } }).isActive).toBe(true);
    expect(getSyncBoardState({ boardId: 'b', syncExecution: { status: 'completed' } }).isActive).toBe(false);
  });

  it('reports completion only for a board that was active and is now neither active nor failed', () => {
    expect(getSyncBoardState({ boardId: 'b', syncExecution: { status: 'completed' } }).isCompleted(true)).toBe(true);
    expect(getSyncBoardState({ boardId: 'b', syncExecution: { status: 'completed' } }).isCompleted(false)).toBe(false);
    expect(getSyncBoardState({ boardId: 'b', jobStatus: { state: 'active' } }).isCompleted(true)).toBe(false);
    expect(getSyncBoardState({ boardId: 'b', jobStatus: { state: 'failed' } }).isCompleted(true)).toBe(false);
  });
});

function makePollHarness(boards: unknown, initialStatuses: Array<{ boardId: string }> = []) {
  let syncStatuses: any[] = initialStatuses;
  const get = vi.fn().mockResolvedValue({ data: boards });
  const showErrorToast = vi.fn();
  const showSuccessToast = vi.fn();
  const stopSyncChecking = vi.fn();
  const previousSyncStatusRef: { current: { boardId: string; status: string; startTime?: number } | null } = {
    current: null,
  };

  return {
    get,
    showErrorToast,
    showSuccessToast,
    stopSyncChecking,
    previousSyncStatusRef,
    statuses: () => syncStatuses,
    args: {
      workspaceId: 'ws-1',
      boardId: 'board-9',
      previousSync: { boardId: 'board-9', status: 'in-progress', startTime: STARTED_AT },
      axios: { get },
      setSyncStatuses: (updater: (prev: any[]) => any[]) => {
        syncStatuses = updater(syncStatuses);
      },
      previousSyncStatusRef,
      stopSyncChecking,
      showErrorToast,
      showSuccessToast,
    },
  };
}

describe('pollBoardManualSyncStatus', () => {
  it('does not poll at all when no sync was running for this board', async () => {
    const h = makePollHarness({ boards: [] });

    await pollBoardManualSyncStatus({ ...h.args, previousSync: null });
    await pollBoardManualSyncStatus({ ...h.args, previousSync: { boardId: 'other', status: 'in-progress' } });
    await pollBoardManualSyncStatus({ ...h.args, previousSync: { boardId: 'board-9', status: 'completed' } });

    expect(h.get).not.toHaveBeenCalled();
  });

  it('polls the workspace sync status endpoint for a running sync', async () => {
    const h = makePollHarness({ boards: [{ boardId: 'board-9', jobStatus: { state: 'active' } }] });
    await pollBoardManualSyncStatus(h.args);
    expect(h.get).toHaveBeenCalledWith('http://localhost:4001/api/sync/workspace/status/ws-1');
  });

  it('does nothing when the response carries no boards array', async () => {
    const h = makePollHarness({});
    await pollBoardManualSyncStatus(h.args);
    expect(h.statuses()).toEqual([]);
    expect(h.stopSyncChecking).not.toHaveBeenCalled();
    expect(h.showSuccessToast).not.toHaveBeenCalled();
  });

  it('adds a status entry for a board whose manual sync is running', async () => {
    const h = makePollHarness({
      boards: [
        {
          boardId: 'board-9',
          boardName: 'Care Management - NDIS',
          jobStatus: { state: 'active', progress: { foldersProcessed: 1, totalFolders: 4 } },
        },
      ],
    });

    await pollBoardManualSyncStatus(h.args);

    expect(h.statuses()).toHaveLength(1);
    expect(h.statuses()[0]).toMatchObject({
      boardId: 'board-9',
      status: 'in-progress',
      progress: { foldersProcessed: 1, totalFolders: 4, currentFolder: null, itemsProcessed: 0 },
    });
    expect(h.previousSyncStatusRef.current).toEqual({
      boardId: 'board-9',
      status: 'in-progress',
      startTime: STARTED_AT,
    });
  });

  it('replaces the existing entry for that board and leaves the others alone', async () => {
    const h = makePollHarness(
      { boards: [{ boardId: 'board-9', jobStatus: { state: 'active' } }] },
      [
        { boardId: 'board-1', status: 'in-progress' } as never,
        { boardId: 'board-9', status: 'started' } as never,
      ],
    );

    await pollBoardManualSyncStatus(h.args);

    expect(h.statuses()).toHaveLength(2);
    expect(h.statuses()[0]).toEqual({ boardId: 'board-1', status: 'in-progress' });
    expect(h.statuses()[1]).toMatchObject({ boardId: 'board-9', status: 'in-progress', isManualSync: true });
  });

  it('stamps the ref with the current time when the previous sync had no start time', async () => {
    const h = makePollHarness({ boards: [{ boardId: 'board-9', jobStatus: { state: 'active' } }] });
    await pollBoardManualSyncStatus({
      ...h.args,
      previousSync: { boardId: 'board-9', status: 'in-progress' },
    });
    expect(h.previousSyncStatusRef.current?.startTime).toBe(Date.parse(NOW_ISO));
  });

  it('reports a failed job and stops polling without announcing completion', async () => {
    const h = makePollHarness({
      boards: [{ boardId: 'board-9', jobStatus: { state: 'failed', failedReason: 'ISO+ returned 502' } }],
    });

    await pollBoardManualSyncStatus(h.args);

    expect(h.showErrorToast).toHaveBeenCalledWith('Sync job failed', { description: 'ISO+ returned 502' });
    expect(h.stopSyncChecking).toHaveBeenCalledTimes(1);
    expect(h.showSuccessToast).not.toHaveBeenCalled();
    // The failed job is still a manual sync, so its status entry was refreshed first.
    expect(h.statuses()[0]).toMatchObject({ boardId: 'board-9', status: 'failed' });
  });

  it('prefers lastSyncError, then the sync execution error, for the failure description', async () => {
    const lastError = makePollHarness({
      boards: [{ boardId: 'board-9', jobStatus: { state: 'failed' }, lastSyncError: 'connection reset' }],
    });
    await pollBoardManualSyncStatus(lastError.args);
    expect(lastError.showErrorToast).toHaveBeenCalledWith('Sync job failed', { description: 'connection reset' });

    const execError = makePollHarness({
      boards: [{ boardId: 'board-9', syncExecution: { status: 'failed', error: { message: 'board vanished' } } }],
    });
    await pollBoardManualSyncStatus(execError.args);
    expect(execError.showErrorToast).toHaveBeenCalledWith('Sync job failed', { description: 'board vanished' });

    const noDetail = makePollHarness({ boards: [{ boardId: 'board-9', syncExecution: { status: 'timeout' } }] });
    await pollBoardManualSyncStatus(noDetail.args);
    expect(noDetail.showErrorToast).toHaveBeenCalledWith('Sync job failed', {
      description: 'The sync job encountered an error. Please try again.',
    });
  });

  it('announces completion, drops the board from the status list and stops polling', async () => {
    const h = makePollHarness(
      { boards: [{ boardId: 'board-9', syncExecution: { status: 'completed' } }] },
      [{ boardId: 'board-9' }, { boardId: 'board-1' }],
    );

    await pollBoardManualSyncStatus(h.args);

    expect(h.showSuccessToast).toHaveBeenCalledWith('Sync completed', {
      description: 'The sync job has finished successfully.',
    });
    expect(h.statuses()).toEqual([{ boardId: 'board-1' }]);
    expect(h.stopSyncChecking).toHaveBeenCalledTimes(1);
  });

  it('mentions the refresh in the completion toast and runs the callback half a second later', async () => {
    const onCompleted = vi.fn();
    const h = makePollHarness({ boards: [{ boardId: 'board-9', syncExecution: { status: 'completed' } }] });

    await pollBoardManualSyncStatus({ ...h.args, onCompleted });

    expect(h.showSuccessToast).toHaveBeenCalledWith('Sync completed', {
      description:
        'The sync job has finished successfully. Refreshing data with latest records and clearing filters...',
    });
    expect(onCompleted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('waits out the grace period before treating a missing board as finished', async () => {
    const h = makePollHarness({ boards: [{ boardId: 'board-1' }] });

    await pollBoardManualSyncStatus({
      ...h.args,
      previousSync: { boardId: 'board-9', status: 'in-progress', startTime: Date.parse(NOW_ISO) - 15000 },
      boardNotFoundGraceMs: 15000,
    });

    expect(h.showSuccessToast).not.toHaveBeenCalled();
    expect(h.stopSyncChecking).not.toHaveBeenCalled();
  });

  it('treats a board that disappeared after the grace period as a completed sync', async () => {
    const h = makePollHarness({ boards: [{ boardId: 'board-1' }] }, [{ boardId: 'board-9' }, { boardId: 'board-1' }]);

    await pollBoardManualSyncStatus({
      ...h.args,
      previousSync: { boardId: 'board-9', status: 'in-progress', startTime: Date.parse(NOW_ISO) - 15001 },
      boardNotFoundGraceMs: 15000,
    });

    expect(h.showSuccessToast).toHaveBeenCalledWith('Sync completed', {
      description: 'The sync job has finished successfully.',
    });
    expect(h.statuses()).toEqual([{ boardId: 'board-1' }]);
    expect(h.stopSyncChecking).toHaveBeenCalledTimes(1);
  });

  it('runs the completion callback for a board that disappeared, half a second later', async () => {
    const onCompleted = vi.fn();
    const h = makePollHarness({ boards: [] });

    await pollBoardManualSyncStatus({
      ...h.args,
      previousSync: { boardId: 'board-9', status: 'in-progress', startTime: Date.parse(NOW_ISO) - 20000 },
      onCompleted,
    });

    expect(h.showSuccessToast).toHaveBeenCalledWith('Sync completed', {
      description:
        'The sync job has finished successfully. Refreshing data with latest records and clearing filters...',
    });
    expect(onCompleted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('treats a missing board with no recorded start time as still inside the grace period', async () => {
    const h = makePollHarness({ boards: [] });

    await pollBoardManualSyncStatus({
      ...h.args,
      previousSync: { boardId: 'board-9', status: 'started' },
    });

    expect(h.showSuccessToast).not.toHaveBeenCalled();
    expect(h.stopSyncChecking).not.toHaveBeenCalled();
  });
});

describe('pollInvoiceGeneratorSyncStatus', () => {
  it('refreshes the table and clears the filters once the sync completes', async () => {
    const handleManualRefresh = vi.fn();
    const h = makePollHarness({ boards: [{ boardId: 'board-9', syncExecution: { status: 'completed' } }] });

    await pollInvoiceGeneratorSyncStatus({ ...h.args, handleManualRefresh });

    expect(h.showSuccessToast).toHaveBeenCalledWith('Sync completed', {
      description:
        'The sync job has finished successfully. Refreshing data with latest records and clearing filters...',
    });
    vi.advanceTimersByTime(500);
    expect(handleManualRefresh).toHaveBeenCalledWith(true, true);
  });

  it('does not refresh while the sync is still running', async () => {
    const handleManualRefresh = vi.fn();
    const h = makePollHarness({ boards: [{ boardId: 'board-9', jobStatus: { state: 'active' } }] });

    await pollInvoiceGeneratorSyncStatus({ ...h.args, handleManualRefresh });
    vi.advanceTimersByTime(5000);

    expect(handleManualRefresh).not.toHaveBeenCalled();
  });
});
