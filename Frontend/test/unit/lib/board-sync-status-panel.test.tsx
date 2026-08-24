import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BoardSyncStatusPanel } from '@/lib/board-sync-status-panel';
import { Context } from '@/app/context';
import type { ContextProps, WorkspaceBoardStatus } from '@/app/context';

function renderPanel(
  boardId: string,
  boards: WorkspaceBoardStatus[],
) {
  const value = {
    user: { id: '', name: '', email: '', role: 'isoplus_user' },
    setUser: () => {},
    workspaces: [],
    setWorkspaces: () => {},
    syncStatuses: [],
    setSyncStatuses: () => {},
    workspaceBoardStatuses: boards,
    setWorkspaceBoardStatuses: () => {},
    currentWorkspaceId: 'ws-1',
    setCurrentWorkspaceId: () => {},
  } as unknown as ContextProps;

  return render(
    <Context.Provider value={value}>
      <BoardSyncStatusPanel boardId={boardId} />
    </Context.Provider>,
  );
}

describe('BoardSyncStatusPanel', () => {
  it('renders schedule from the shared workspace status payload', () => {
    renderPanel('b-1', [{
      boardId: 'b-1',
      schedule: {
        cron: '0 2 * * *',
        timezone: 'Australia/Sydney',
        previous: null,
        current: { state: 'waiting', syncType: 'scheduled_sync' },
        upcoming: { at: '2026-08-20T16:00:00.000Z' },
      },
    }]);

    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('None yet')).toBeInTheDocument();
  });

  it('falls back to empty copy when the board is not in the workspace poll', () => {
    renderPanel('missing', []);
    expect(screen.getByText('Idle')).toBeInTheDocument();
    expect(screen.getByText('Not scheduled')).toBeInTheDocument();
  });
});
