import { KIND_INVOICE, KIND_STATEMENT } from '../../constants/automation.js';
import { automationPeriodKey } from '../../utils/automationPeriodKey.js';

// The prefix keeps an invoice and a statement falling on the same slot for
// the same board as two distinct jobs rather than one silently deduped away.
const KIND_PREFIX = {
  [KIND_INVOICE]: 'inv',
  [KIND_STATEMENT]: 'stmt',
};

function pickerForJob(schedule) {
  if (!schedule?.every) return undefined;
  return {
    every: { n: schedule.every.n, unit: schedule.every.unit },
    runOn: schedule.runOn ?? null,
  };
}

/**
 * One job spec per board in the workspace. Every board is included: no
 * eligibility concept exists in the data model (Board.syncData governs ISO+
 * sync, not billing), so whether a board has anything to bill is the generation
 * step's question.
 */
export function buildFanOutSpecs({ kind, workspaceId, boards, slot, timezone, schedule }) {
  const periodKey = automationPeriodKey({ slot, timezone });
  const prefix = KIND_PREFIX[kind];
  const picker = pickerForJob(schedule);

  return boards.map((board) => ({
    name: kind,
    data: {
      kind,
      workspaceId,
      boardId: board.boardId,
      slot,
      periodKey,
      timezone,
      ...(picker ? { schedule: picker } : {}),
    },
    opts: { jobId: `${prefix}:${board.boardId}:${periodKey}` },
  }));
}
