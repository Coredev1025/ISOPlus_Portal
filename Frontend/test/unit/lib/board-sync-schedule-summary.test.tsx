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

  it('renders bold label and instants in the compact line', () => {
    renderSummary('b-1', [{
      boardId: 'b-1',
      schedule: {
        timezone: 'Australia/Sydney',
        previous: { at: '2026-08-26T11:44:00.000Z', status: 'completed' },
        current: null,
        upcoming: { at: '2026-08-27T08:00:00.000Z' },
      },
    }]);

    const summary = screen.getByLabelText('Sync schedule');
    expect(summary.textContent).toBe(
      'Sync schedule: Previous run: 26 Aug 2026, 9:44 PM (successful). Next scheduled run: 27 Aug 2026, 6:00 PM.',
    );
    const bold = [...summary.querySelectorAll('.font-semibold')].map((el) => el.textContent);
    expect(bold).toEqual([
      'Sync schedule:',
      '26 Aug 2026, 9:44 PM',
      '27 Aug 2026, 6:00 PM',
    ]);
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
        previous: { at: '2026-08-26T11:44:00.000Z', status: 'failed' },
        current: { state: 'waiting', syncType: 'scheduled_sync' },
        upcoming: { at: '2026-08-27T08:00:00.000Z' },
      },
    }]);

    expect(screen.getByLabelText('Sync schedule').textContent).toMatch(
      /Previous run: .+ \(failed\)\. Current \(In progress\)\.$/,
    );
  });
});
