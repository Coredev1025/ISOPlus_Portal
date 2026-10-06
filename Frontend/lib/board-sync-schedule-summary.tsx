'use client';

import { useAppContext } from '@/app/context';
import { boardSyncScheduleSummaryParts } from '@/lib/board-sync-status-helpers';

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
  const parts = boardSyncScheduleSummaryParts(board?.schedule ?? null);
  if (!parts) return null;

  return (
    <p
      className={
        className
        ?? 'min-w-0 max-w-xl text-left text-sm leading-snug text-foreground'
      }
      aria-label="Sync schedule"
    >
      {parts.map((part, index) => (
        <span
          key={index}
          className={part.bold ? 'font-semibold' : undefined}
        >
          {part.text}
        </span>
      ))}
    </p>
  );
}
