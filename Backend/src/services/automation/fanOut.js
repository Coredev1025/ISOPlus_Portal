import { automationPeriodKey } from '../../utils/automationPeriodKey.js';

export const KIND_INVOICE = 'invoice_automation';
export const KIND_STATEMENT = 'statement_automation';

// The prefix keeps an invoice and a statement falling on the same slot for
// the same board as two distinct jobs rather than one silently deduped away.
// Intentionally not exported: the jobId format is fanOut's concern alone —
// callers key on KIND_INVOICE/KIND_STATEMENT, never on the prefix directly.
const KIND_PREFIX = {
  [KIND_INVOICE]: 'inv',
  [KIND_STATEMENT]: 'stmt',
};

/**
 * One job spec per board in the workspace.
 *
 * Every board is included: no eligibility concept exists in the data model
 * (Board.syncData governs ISO+ sync, not billing), and inventing a billing
 * flag is out of scope. Whether a board has anything to bill is the
 * generation step's question. If a real eligibility rule ever appears, this
 * is the only place it goes.
 */
export function buildFanOutSpecs({ kind, workspaceId, boards, slot, timezone }) {
  const periodKey = automationPeriodKey({ slot, timezone });
  const prefix = KIND_PREFIX[kind];

  return boards.map((board) => ({
    name: kind,
    data: { kind, workspaceId, boardId: board.boardId, slot, periodKey },
    opts: { jobId: `${prefix}:${board.boardId}:${periodKey}` },
  }));
}
