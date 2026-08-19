'use client';

import { useEffect, useState } from 'react';
import axios from '@/app/utils/axiosConfig';
import {
  labelCurrentSync,
  labelPreviousSync,
  labelUpcomingSync,
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

function isCanceled(error: unknown) {
  const name = (error as { name?: string } | undefined)?.name;
  return name === 'CanceledError' || name === 'AbortError';
}

export function BoardSyncStatusPanel({ boardId }: BoardSyncStatusPanelProps) {
  const [schedule, setSchedule] = useState<BoardSyncSchedule>(EMPTY_SCHEDULE);

  useEffect(() => {
    if (!boardId) return;
    const abortController = new AbortController();

    const fetchStatus = async () => {
      try {
        const response = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/sync/board/status/${boardId}`,
          { signal: abortController.signal },
        );
        if (response.data?.schedule) {
          setSchedule(response.data.schedule);
        }
      } catch (error) {
        if (!isCanceled(error)) {
          setSchedule(EMPTY_SCHEDULE);
        }
      }
    };

    fetchStatus();
    return () => abortController.abort();
  }, [boardId]);

  const timezone = schedule.timezone;

  return (
    <section aria-label="Sync schedule" className="space-y-3 rounded-md border p-4">
      <h3 className="text-sm font-semibold">Sync schedule</h3>
      <dl className="grid gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Previous</dt>
          <dd>{labelPreviousSync(schedule.previous, timezone)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Current</dt>
          <dd>{labelCurrentSync(schedule.current)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Next scheduled run</dt>
          <dd>{labelUpcomingSync(schedule.upcoming, timezone)}</dd>
        </div>
      </dl>
    </section>
  );
}
