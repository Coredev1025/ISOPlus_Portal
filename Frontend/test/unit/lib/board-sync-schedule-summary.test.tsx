import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BoardSyncScheduleSummary } from '@/lib/board-sync-schedule-summary';
import { Context } from '@/app/context';
import type { ContextProps, WorkspaceBoardStatus } from '@/app/context';

function renderSummary(boardId: string, boards: WorkspaceBoardStatus[]) {
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
      <BoardSyncScheduleSummary boardId={boardId} />
      <button type="button">Resync Data</button>
    </Context.Provider>,
  );
}

describe('BoardSyncScheduleSummary', () => {
  it('renders nothing when the board is not in the workspace poll', () => {
    renderSummary('b-1', []);
    expect(screen.queryByLabelText('Sync schedule')).not.toBeInTheDocument();
  });

  it('renders the compact line before Resync when schedule has data', () => {
    renderSummary('b-1', [{
      boardId: 'b-1',
      schedule: {
        timezone: 'Australia/Sydney',
        previous: { at: '2026-08-26T09:11:00.000Z', status: 'completed' },
        current: null,
        upcoming: { at: '2026-08-27T09:00:00.000Z' },
      },
    }]);

    const summary = screen.getByLabelText('Sync schedule');
    expect(summary.textContent).toMatch(/^Sync schedule: Previous .+ \(Success\), Next scheduled run .+$/);
    const resync = screen.getByRole('button', { name: /Resync Data/ });
    expect(
      summary.compareDocumentPosition(resync) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('prefers Current In progress over Next when a catch-up is live', () => {
    renderSummary('b-1', [{
      boardId: 'b-1',
      schedule: {
        timezone: 'Australia/Sydney',
        previous: { at: '2026-08-26T09:11:00.000Z', status: 'failed' },
        current: { state: 'waiting', syncType: 'scheduled_sync' },
        upcoming: { at: '2026-08-27T09:00:00.000Z' },
      },
    }]);

    expect(screen.getByLabelText('Sync schedule').textContent).toMatch(
      /Previous .+ \(Failed\), Current \(In progress\)$/,
    );
  });
});
