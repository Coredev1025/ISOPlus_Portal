import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../../msw/server';
import { ContextProvider, useAppContext } from '@/app/context';
import { SyncStatusIndicator } from '@/components/ui/sync-status-indicator';

/**
 * SyncStatusIndicator polls /api/sync/workspace/status/:id whenever a workspace
 * is current, maps each board's raw poll payload onto a card, and renders
 * nothing at all when no sync is in flight. These tests drive the real
 * ContextProvider and stub only the HTTP.
 */

// NEXT_PUBLIC_BACKEND_URL is unset under vitest, so the app requests
// `undefined/api/...`. A leading * matches whatever origin it ends up with.

/** Sets the current workspace on the real context, as a page would. */
function WorkspaceSetter({ id }: { id: string | null }) {
  const { setCurrentWorkspaceId } = useAppContext();
  const applied = React.useRef(false);
  if (!applied.current) {
    applied.current = true;
  }
  React.useEffect(() => {
    setCurrentWorkspaceId(id);
  }, [id, setCurrentWorkspaceId]);
  return null;
}

import React from 'react';

function renderIndicator(workspaceId: string | null) {
  return render(
    <ContextProvider>
      <WorkspaceSetter id={workspaceId} />
      <SyncStatusIndicator />
    </ContextProvider>,
  );
}

/** A board mid first-time backlog sync — the shape the poll endpoint returns. */
function inProgressBoard(overrides: Record<string, unknown> = {}) {
  return {
    boardId: 'b-1',
    boardName: 'NDIS Services',
    syncStatus: 'data_backlog_sync',
    syncStats: { foldersProcessed: 1, itemsSynced: 10 },
    syncExecution: {
      status: 'in-progress',
      syncType: 'data_backlog_sync',
      startTime: '2026-08-10T00:00:00.000Z',
      duration: undefined,
      progress: { foldersProcessed: 2, totalFolders: 5, currentFolder: 'Participants' },
      counters: { itemsProcessed: 40 },
    },
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SyncStatusIndicator', () => {
  it('renders nothing when no workspace is current', async () => {
    const { container } = renderIndicator(null);

    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });

  it('renders nothing when the workspace has no active sync', async () => {
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () =>
        HttpResponse.json({ boards: [] }),
      ),
    );

    const { container } = renderIndicator('ws-1');

    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });

  it('polls the endpoint for the current workspace', async () => {
    const requested: string[] = [];
    server.use(
      http.get(`*/api/sync/workspace/status/:id`, ({ params }) => {
        requested.push(String(params.id));
        return HttpResponse.json({ boards: [] });
      }),
    );

    renderIndicator('ws-42');

    await waitFor(() => {
      expect(requested).toContain('ws-42');
    });
  });

  it('shows a card naming the board that is syncing', async () => {
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () =>
        HttpResponse.json({ boards: [inProgressBoard()] }),
      ),
    );

    renderIndicator('ws-1');

    expect(await screen.findByText('NDIS Services')).toBeInTheDocument();
  });

  it('falls back to the board id when the board has no name', async () => {
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () =>
        HttpResponse.json({ boards: [inProgressBoard({ boardName: undefined })] }),
      ),
    );

    renderIndicator('ws-1');

    expect(await screen.findByText('b-1')).toBeInTheDocument();
  });

  it('reports the folder progress from the execution payload', async () => {
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () =>
        HttpResponse.json({ boards: [inProgressBoard()] }),
      ),
    );

    const { container } = renderIndicator('ws-1');
    await screen.findByText('NDIS Services');

    // progress.foldersProcessed = 2 of totalFolders = 5
    expect(container.textContent).toContain('2');
    expect(container.textContent).toContain('5');
  });

  it('surfaces the failure message for a failed sync', async () => {
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () =>
        HttpResponse.json({
          boards: [
            inProgressBoard({
              syncExecution: {
                status: 'failed',
                syncType: 'data_backlog_sync',
                startTime: '2026-08-10T00:00:00.000Z',
                // A failed execution only surfaces while endTime is within the
                // last 60 seconds — see hasFailedSyncExecution.
                endTime: new Date().toISOString(),
                progress: {},
                counters: {},
                error: { message: 'ISO+ returned 502' },
              },
            }),
          ],
        }),
      ),
    );

    const { container } = renderIndicator('ws-1');

    expect(await screen.findByText('Sync Failed')).toBeInTheDocument();
    await waitFor(() => {
      expect(container.textContent).toContain('ISO+ returned 502');
    });
  });

  it('does not surface a failed nightly scheduled_sync on the floating card', async () => {
    let polled = false;
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () => {
        polled = true;
        return HttpResponse.json({
          boards: [
            inProgressBoard({
              syncStatus: 'scheduled_sync',
              syncExecution: {
                status: 'failed',
                syncType: 'scheduled_sync',
                startTime: '2026-08-10T00:00:00.000Z',
                endTime: new Date().toISOString(),
                progress: {},
                counters: {},
                error: { message: 'Nightly catch-up failed' },
              },
            }),
          ],
        });
      }),
    );

    const { container } = renderIndicator('ws-1');

    await waitFor(() => {
      expect(polled).toBe(true);
    });
    expect(container.textContent).not.toContain('Sync Failed');
    expect(container.textContent).not.toContain('Nightly catch-up failed');
  });

  it('does not sticky-show overnight catch-up failures on the floating card', async () => {
    let polled = false;
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () => {
        polled = true;
        return HttpResponse.json({
          boards: [
            {
              boardId: 'b-1',
              boardName: 'NDIS Services',
              // Worker sets syncStatus to failed and stamps lastSyncError; the
              // in-progress SyncExecution is gone from the poll by morning.
              // Schedule / config panels still read lastSyncError — floating UI does not.
              syncStatus: 'failed',
              lastSyncError: 'ISO+ returned 429 at 02:00',
              jobStatus: null,
              syncExecution: null,
            },
          ],
        });
      }),
    );

    const { container } = renderIndicator('ws-1');

    await waitFor(() => {
      expect(polled).toBe(true);
    });
    expect(container.textContent).not.toContain('Sync Failed');
    expect(container.textContent).not.toContain('ISO+ returned 429 at 02:00');
  });

  it('does not surface a failed scheduled_sync BullMQ job on the floating card', async () => {
    let polled = false;
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () => {
        polled = true;
        return HttpResponse.json({
          boards: [
            {
              boardId: 'b-1',
              boardName: 'NDIS Services',
              syncStatus: 'failed',
              lastSyncError: 'ISO+ returned 502',
              jobStatus: {
                state: 'failed',
                jobType: 'scheduled_sync',
                finishedOn: Date.now(),
                failedReason: 'ISO+ returned 502',
              },
              syncExecution: null,
            },
          ],
        });
      }),
    );

    const { container } = renderIndicator('ws-1');

    await waitFor(() => {
      expect(polled).toBe(true);
    });
    expect(container.textContent).not.toContain('Sync Failed');
  });

  it('does not sticky-fail a board the user deliberately cancelled', async () => {
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () =>
        HttpResponse.json({
          boards: [
            {
              boardId: 'b-1',
              boardName: 'NDIS Services',
              syncStatus: 'sync_cancelled',
              lastSyncError: 'Sync cancelled by user',
              jobStatus: null,
              syncExecution: null,
            },
          ],
        }),
      ),
    );

    const { container } = renderIndicator('ws-1');

    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });

  it('prefers the manual job payload when a manual sync is running', async () => {
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () =>
        HttpResponse.json({
          boards: [
            inProgressBoard({
              jobStatus: {
                state: 'active',
                processedOn: Date.parse('2026-08-10T00:00:00.000Z'),
                progress: { foldersProcessed: 7, totalFolders: 9, currentFolder: 'Items' },
              },
            }),
          ],
        }),
      ),
    );

    const { container } = renderIndicator('ws-1');
    await screen.findByText('NDIS Services');

    expect(container.textContent).toContain('7');
    expect(container.textContent).toContain('9');
  });

  it('renders nothing again once the sync disappears from the poll', async () => {
    let boards: unknown[] = [inProgressBoard()];
    const pollCallbacks: Array<() => void> = [];
    const realSetInterval = global.setInterval.bind(global);
    vi.spyOn(global, 'setInterval').mockImplementation(((
      handler: TimerHandler,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (typeof handler === 'function' && ms === 10_000) {
        pollCallbacks.push(handler as () => void);
        // Keep a long-lived handle so clearInterval in cleanup still works.
        return realSetInterval(() => {}, 60_000);
      }
      return realSetInterval(handler as never, ms as never, ...(args as never[]));
    }) as typeof setInterval);

    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () =>
        HttpResponse.json({ boards }),
      ),
    );

    const { container } = renderIndicator('ws-1');
    await screen.findByText('NDIS Services');

    boards = [];
    expect(pollCallbacks.length).toBeGreaterThan(0);
    await act(async () => {
      await pollCallbacks[0]();
    });

    await waitFor(() => {
      expect(container.textContent).not.toContain('NDIS Services');
    });
  });

  it('survives a failing poll without crashing', async () => {
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 }),
      ),
    );

    const { container } = renderIndicator('ws-1');

    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });

  it('does not surface a failure that finished more than a minute ago', async () => {
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () =>
        HttpResponse.json({
          boards: [
            inProgressBoard({
              syncExecution: {
                status: 'failed',
                syncType: 'data_backlog_sync',
                startTime: '2026-08-10T00:00:00.000Z',
                endTime: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
                progress: {},
                counters: {},
                error: { message: 'ISO+ returned 502' },
              },
            }),
          ],
        }),
      ),
    );

    const { container } = renderIndicator('ws-1');

    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });

  it('ignores a realtime sync, which is not worth an indicator', async () => {
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () =>
        HttpResponse.json({
          boards: [
            inProgressBoard({
              syncExecution: {
                status: 'in-progress',
                syncType: 'realtime_sync',
                startTime: '2026-08-10T00:00:00.000Z',
                progress: {},
                counters: {},
              },
            }),
          ],
        }),
      ),
    );

    const { container } = renderIndicator('ws-1');

    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });

  it('ignores a scheduled catch-up — the floating span is for first-time enable only', async () => {
    let polled = false;
    server.use(
      http.get(`*/api/sync/workspace/status/ws-1`, () => {
        polled = true;
        return HttpResponse.json({
          boards: [
            inProgressBoard({
              syncStatus: 'scheduled_sync',
              syncExecution: {
                status: 'in-progress',
                syncType: 'scheduled_sync',
                startTime: '2026-08-10T00:00:00.000Z',
                progress: { foldersProcessed: 2, totalFolders: 5 },
                counters: { itemsProcessed: 40 },
              },
              jobStatus: { state: 'active', progress: {} },
            }),
          ],
        });
      }),
    );

    const { container } = renderIndicator('ws-1');

    await waitFor(() => {
      expect(polled).toBe(true);
    });
    expect(container.textContent).not.toContain('NDIS Services');
    expect(container.textContent).not.toContain('Syncing Data');
  });
});
