'use client';

import { useAppContext } from '@/app/context';
import { formatBoardSyncScheduleSummary } from '@/lib/board-sync-status-helpers';

type BoardSyncScheduleSummaryProps = Readonly<{
  boardId: string;
  className?: string;
}>;

/**
 * Compact sync schedule line for Invoice / Statement generators.
 * Only boards with syncData:true appear in the workspace poll — absence means
 * auto-sync is off and we render nothing.
 */
export function BoardSyncScheduleSummary({
  boardId,
  className,
}: BoardSyncScheduleSummaryProps) {
  const { workspaceBoardStatuses } = useAppContext();
  const board = workspaceBoardStatuses.find((row) => row.boardId === boardId);
  const summary = formatBoardSyncScheduleSummary(board?.schedule ?? null);
  if (!summary) return null;

  return (
    <p
      className={
        className
        ?? 'max-w-md text-left text-sm leading-snug text-muted-foreground'
      }
      aria-label="Sync schedule"
    >
      {summary}
    </p>
  );
}
