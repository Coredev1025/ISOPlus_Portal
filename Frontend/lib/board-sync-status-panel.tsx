'use client';

import { useMemo } from 'react';
import { useAppContext } from '@/app/context';
import {
  labelCurrentSync,
  labelInstant,
  type BoardSyncSchedule,
} from '@/lib/board-sync-status-helpers';

type BoardSyncStatusPanelProps = Readonly<{
  boardId: string;
}>;

const EMPTY_SCHEDULE: BoardSyncSchedule = {
  cron: null,
  timezone: null,
  previous: null,
  current: null,
  upcoming: null,
};

/**
 * Reads schedule from the workspace status poll already driven by
 * SyncStatusIndicator — no second 10s poller on Configuration.
 */
export function BoardSyncStatusPanel({ boardId }: BoardSyncStatusPanelProps) {
  const { workspaceBoardStatuses } = useAppContext();

  const schedule = useMemo(() => {
    const board = workspaceBoardStatuses.find((row) => row.boardId === boardId);
    return board?.schedule ?? EMPTY_SCHEDULE;
  }, [workspaceBoardStatuses, boardId]);

  const timezone = schedule.timezone;

  return (
    <section aria-label="Sync schedule" className="space-y-3 rounded-md border p-4">
      <h3 className="text-sm font-semibold">Sync schedule</h3>
      <dl className="grid gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Previous</dt>
          <dd>{labelInstant(schedule.previous, timezone, 'None yet')}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Current</dt>
          <dd>{labelCurrentSync(schedule.current)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Next scheduled run</dt>
          <dd>{labelInstant(schedule.upcoming, timezone, 'Not scheduled')}</dd>
        </div>
      </dl>
    </section>
  );
}
