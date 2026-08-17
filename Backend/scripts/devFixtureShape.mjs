// Pure normalization/validation for dev-fixture.mjs — its fixture files, and
// the local-only database guard it refuses to run without.
//
// A fixture may declare a single `board` (the original shape, e.g.
// ndis-quote-board.json) or a `boards` array, plus optional
// `automationSettings`, `scheduledJobs` and `invoiceNumbers` sections. This
// module turns either shape into one canonical { workspaceId, business,
// boards, items, automationSettings, scheduledJobs, invoiceNumbers } and
// throws on anything ambiguous — no mongoose, no dotenv, no I/O, so it is
// trivially unit-testable.

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

// Already-invoiced rows (InvoiceNumber model). type defaults to 'PDF'
// (the model's enum is PDF|Xero); workspaceId is the fixture's, always.
//
// It is pinned after the spread, not before: an entry declaring its own
// workspaceId used to win here, so the row was written under that workspace
// while --remove deleted by the fixture's — the row survived every cleanup.
// Nothing needs a per-entry workspace, so this is a pin rather than a default.
function normalizeInvoiceNumber(entry, boardIds, workspaceId) {
  if (!entry.itemId || !entry.boardId || !entry.invoiceNumber) {
    fail('every invoiceNumbers entry needs itemId, boardId and invoiceNumber');
  }
  if (!boardIds.has(entry.boardId)) {
    fail(`invoiceNumbers entry "${entry.itemId}" names boardId "${entry.boardId}", which is not one of the fixture's boards`);
  }
  return { type: 'PDF', ...entry, workspaceId };
}

// --- the local-only guard ----------------------------------------------------

// 'mongo' is the compose service name — inside the dev network that is the
// local database. URL keeps the brackets on an IPv6 hostname, hence '[::1]'.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', 'mongo']);

/**
 * The hostname of one `host[:port]` from a Mongo connection string, or null if
 * it will not parse. `new URL` does the work — bracketed IPv6, ports, defaults
 * — on one host at a time, because a multi-host authority is not a URL.
 */
function hostnameOf(host) {
  try {
    const { hostname } = new URL(`mongodb://${host}`);
    return hostname || null;
  } catch {
    return null;
  }
}

/**
 * Does this URI point at a database on this machine, and only at databases on
 * this machine?
 *
 * dev-fixture writes invented business and participant records and tells the
 * operator there is no override flag, so this has to be worth that promise.
 * The check it replaces was an unanchored substring match, which meant
 * `mongodb://mongo:27017,prod.example.com:27017/db` (a replica-set list whose
 * first host is local) and `mongodb://localhost:pw@prod.example.com/` (a
 * username that happens to read as a hostname) both passed while writing to a
 * remote host. Every host in the authority must be local; anything that will
 * not parse is refused rather than assumed.
 *
 * What no string check can see: an SSH tunnel or port-forward on localhost:27017
 * that terminates in production. This narrows the accident, it does not make
 * the operation safe by itself.
 */
export function isLocalMongoUri(uri) {
  const match = /^mongodb(\+srv)?:\/\/([^/?#]*)/i.exec(String(uri ?? ''));
  if (!match) return false;
  // +srv resolves its hosts from DNS, so the string names nothing local.
  if (match[1]) return false;

  const authority = match[2];
  const at = authority.lastIndexOf('@');
  const hosts = authority.slice(at + 1).split(',').filter(Boolean);
  if (hosts.length === 0) return false;

  return hosts.every((host) => LOCAL_HOSTNAMES.has(hostnameOf(host)));
}

export function normalizeFixture(fixture) {
  const boards = normalizeBoards(fixture);
  const workspaceId = fixture.business?.workspaceId ?? boards[0].workspaceId;
  if (!workspaceId) fail('fixture needs business.workspaceId or boards[0].workspaceId');
  const boardIds = new Set(boards.map((b) => b.boardId));

  return {
    workspaceId,
    business: fixture.business,
    boards,
    items: normalizeItems(fixture.items ?? [], boards, workspaceId),
    automationSettings: fixture.automationSettings ?? null,
    scheduledJobs: (fixture.scheduledJobs ?? []).map(normalizeScheduledJob),
    invoiceNumbers: (fixture.invoiceNumbers ?? [])
      .map((entry) => normalizeInvoiceNumber(entry, boardIds, workspaceId)),
  };
}
