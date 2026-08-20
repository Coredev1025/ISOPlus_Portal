import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server';
import { BoardSyncStatusPanel } from '@/lib/board-sync-status-panel';

describe('BoardSyncStatusPanel', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:4001';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls board sync status while mounted', async () => {
    let hits = 0;
    server.use(
      http.get('*/api/sync/board/status/b-1', () => {
        hits += 1;
        return HttpResponse.json({
          schedule: {
            cron: '0 2 * * *',
            timezone: 'Australia/Sydney',
            previous: null,
            current: hits === 1
              ? { state: 'waiting', syncType: 'scheduled_sync' }
              : null,
            upcoming: { at: '2026-08-20T16:00:00.000Z' },
          },
        });
      }),
    );

    const pollCallbacks: Array<() => void> = [];
    const realSetInterval = global.setInterval.bind(global);
    vi.spyOn(global, 'setInterval').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === 10_000 && typeof handler === 'function') {
        pollCallbacks.push(handler as () => void);
        return 1 as unknown as ReturnType<typeof setInterval>;
      }
      return realSetInterval(handler, timeout, ...args);
    }) as typeof setInterval);

    render(<BoardSyncStatusPanel boardId="b-1" />);

    await waitFor(() => {
      expect(screen.getByText('Queued')).toBeInTheDocument();
    });
    expect(hits).toBe(1);

    expect(pollCallbacks.length).toBeGreaterThan(0);
    await pollCallbacks[0]();

    await waitFor(() => {
      expect(screen.getByText('Idle')).toBeInTheDocument();
    });
    expect(hits).toBe(2);
  });
});
