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

/** A board mid-sync, in the shape the poll endpoint really returns. */
function inProgressBoard(overrides: Record<string, unknown> = {}) {
  return {
    boardId: 'b-1',
    boardName: 'NDIS Services',
    syncStatus: 'scheduled_sync',
    syncStats: { foldersProcessed: 1, itemsSynced: 10 },
    syncExecution: {
      status: 'in-progress',
      syncType: 'scheduled_sync',
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
                syncType: 'scheduled_sync',
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
                syncType: 'scheduled_sync',
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
});
