// Pure normalization/validation for dev-fixture.mjs fixture files.
//
// A fixture may declare a single `board` (the original shape, e.g.
// ndis-quote-board.json) or a `boards` array, plus optional
// `automationSettings` and `scheduledJobs` sections. This module turns either
// shape into one canonical { workspaceId, business, boards, items,
// automationSettings, scheduledJobs } and throws on anything ambiguous —
// no mongoose, no dotenv, no I/O, so it is trivially unit-testable.

// $-prefixed keys are documentation inside the fixture, not document fields.
export const stripDollarKeys = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('$')));

const fail = (message) => {
  throw new Error(message);
};

function normalizeBoards(fixture) {
  const boards = fixture.boards ?? (fixture.board ? [fixture.board] : []);
  if (boards.length === 0) fail('fixture needs at least one board (`board` or `boards`)');
  for (const b of boards) {
    if (!b?.boardId) fail('every fixture board needs a boardId');
  }
  return boards;
}

function resolveItemBoardId(item, boards, boardIds) {
  const declared = item.boardId ?? (boards.length === 1 ? boards[0].boardId : undefined);
  if (declared === undefined) {
    fail(`item "${item.itemId}" needs a boardId — the fixture has ${boards.length} boards`);
  }
  if (!boardIds.has(declared)) {
    fail(`item "${item.itemId}" names boardId "${declared}", which is not one of the fixture's boards`);
  }
  return declared;
}

function normalizeItems(items, boards, workspaceId) {
  const boardIds = new Set(boards.map((b) => b.boardId));
  return items.map((item) => ({
    ...item,
    boardId: resolveItemBoardId(item, boards, boardIds),
    workspaceId,
    isoPlusItemId: item.itemId,
  }));
}

// ISO strings become Dates so the upsert writes real BSON dates rather than
// relying on cast behaviour. Absent/null values pass through untouched.
const toDate = (value) => (typeof value === 'string' ? new Date(value) : value);

function normalizeScheduledJob(job) {
  if (!job.kind || !job.targetId) {
    fail('every scheduledJobs entry needs both kind and targetId');
  }
  const normalized = { ...job, nextRunAt: toDate(job.nextRunAt) };
  if (job.schedule) {
    normalized.schedule = { ...job.schedule, startDate: toDate(job.schedule.startDate) };
  }
  return normalized;
}

export function normalizeFixture(fixture) {
  const boards = normalizeBoards(fixture);
  const workspaceId = fixture.business?.workspaceId ?? boards[0].workspaceId;
  if (!workspaceId) fail('fixture needs business.workspaceId or boards[0].workspaceId');

  return {
    workspaceId,
    business: fixture.business,
    boards,
    items: normalizeItems(fixture.items ?? [], boards, workspaceId),
    automationSettings: fixture.automationSettings ?? null,
    scheduledJobs: (fixture.scheduledJobs ?? []).map(normalizeScheduledJob),
  };
}
