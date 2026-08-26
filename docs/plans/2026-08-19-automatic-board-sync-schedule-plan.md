# Automatic Board Sync Schedule Implementation Plan

> **Status:** Implemented (2026-08). Where this plan conflicts with what shipped,
> read [`docs/superpowers/specs/2026-08-19-automatic-board-sync-schedule-design.md`](../superpowers/specs/2026-08-19-automatic-board-sync-schedule-design.md) ("Changes since approval") and [`docs/scheduling.md`](../scheduling.md) — those are authoritative.

> **For agentic workers:** This plan is a historical execution record, not
> active work. Do not implement the tick-based architecture described in early
> tasks — it was superseded before merge.

**Goal:** Once a day (configurable cron), enqueue a catch-up sync for every ISO+ sync-enabled board, run those jobs one at a time, and show previous / current / next run on Board Configuration.

**Architecture (as shipped):** In-process `setTimeout` + `cron-parser` (`startBoardSyncCron` in `portalSchedule.js`) fires on `BOARD_SYNC_CRON` (default `0 2 * * *` in `DEFAULT_TIMEZONE`). Each fire calls `runBoardSyncSweep`, which fans out `scheduled_sync` jobs onto the existing `board-sync` queue with idempotent jobIds. `board_sync` is **not** registered on `POST /api/scheduler/tick` — EventBridge remains invoice/statement automation only. `syncWorker` concurrency is 1. Enable-time backlog + webhooks are unchanged. Board Configuration reads schedule from the workspace status poll (`GET /api/sync/workspace/status/:workspaceId`) already driven by `SyncStatusIndicator`, not a per-page status fetch.

**Tech Stack:** Node ESM, Express, Mongoose, BullMQ, Vitest, Next.js, Playwright.

**Spec:** [`docs/superpowers/specs/2026-08-19-automatic-board-sync-schedule-design.md`](../superpowers/specs/2026-08-19-automatic-board-sync-schedule-design.md)

## Changes since this plan was written

| Planned here | Shipped | Why |
|---|---|---|
| One portal `ScheduledJob` upserted at boot; tick claims it | In-process cron timer (`startBoardSyncCron`); no `ScheduledJob` row for board sync | Epic 12 scope — invoice/statement stay on EventBridge tick only |
| `BOARD_SYNC_TARGET_ID = 'portal'` | Constant removed; next run from `computeNextRun` + env, not `ScheduledJob.nextRunAt` | No tick advances a board-sync row; migration disables leftover portal rows |
| `ensurePortalBoardSyncSchedule` on Mongo connect | `startBoardSyncCron()` on Mongo connect | Same boot hook, different mechanism |
| `board_sync` registered under `AT_LEAST_ONCE` on the tick | `runBoardSyncSweep` exported; **not** registered in `registerSchedulerHandlers` | Tick must not claim `board_sync` |
| Configuration page fetches `GET /api/sync/board/status/:boardId` | Panel reads `schedule` from workspace status poll in context | Avoid a second 10s poller on Configuration |
| JobId via `automationPeriodKey` | `scheduledSyncPeriodKey` in `boardSyncSweepHelpers.js` | Board catch-up must not import invoice-automation helpers |

Full rationale is in the design spec's "Changes since approval" table.

## Global Constraints

- **Cognitive complexity < 15 per file** (SonarJS S3776). Fan-out, cron resolve, and status shaping live in helpers, not nested in `handlers.js` or the configuration page.
- **Backend is ESM.** Relative imports need the `.js` extension. Tests are Vitest `*.test.js`.
- **No new runtime dependencies.** Reuse the existing `board-sync` queue and `cron-parser` / `computeNextRun` (do not add `node-cron` / `node-schedule`). Board sync does **not** use the KAN-15 tick, `upsertSchedule`, or `automationPeriodKey` — see the deviation table above.
- **No second clock for automation.** Do not add `node-schedule` or `/api/internal/.../tick`. Board sync uses in-process cron; invoice/statement keep EventBridge → tick.
- **Handler enqueues and returns.** Never await ISO+ inside the tick.
- **Do not remove Resync Data or webhooks.** Scheduled catch-up is additive.
- **Do not gate on `invoiceStatementAutomation`.**
- **Board Configuration does not edit the cron.** Operators set `BOARD_SYNC_CRON`.
- **Timezone default is `Australia/Sydney`** via `DEFAULT_TIMEZONE`. Do not add another hardcoded copy.
- **Every new env var** goes in `Backend/.env.example` with a comment saying what breaks without it.
- **A user-visible change needs a Playwright test** in `Frontend/e2e/`.
- **No AI attribution** in commits.
- **Backend tests run from `Backend/`.** Frontend unit tests from `Frontend/`.

---

## File structure

| File | Responsibility |
|---|---|
| `Backend/src/constants/scheduler.js` | `BOARD_SYNC_KIND`, `BOARD_SYNC_CRON_DEFAULT`. Import-free. |
| `Backend/src/constants/sync.js` | `SYNC_WORKER_CONCURRENCY`, `SCHEDULED_SYNC_JOB_TYPE`, queueable statuses. Import-free. |
| `Backend/src/utils/boardSyncSweepHelpers.js` | `resolveBoardSyncCron`, `isEligibleSyncBoard`, `buildScheduledSyncSpecs`, `scheduledSyncPeriodKey`, `buildScheduledSyncBoardWrites`. |
| `Backend/src/utils/boardSyncScheduleViewHelpers.js` | `buildBoardSyncScheduleView` — previous / current / next from already-loaded records. Pure. |
| `Backend/src/services/scheduler/handlers.js` | `runBoardSyncSweep` fans out via `addBulk`; **does not** register `board_sync` on the tick. |
| `Backend/src/services/scheduler/portalSchedule.js` | `startBoardSyncCron`, `buildPortalBoardSyncMeta` — in-process clock and status meta (no `ScheduledJob` row). |
| `Backend/src/index.js` | After Mongo connects, call `startBoardSyncCron`. |
| `Backend/src/services/sync.js` | `getBoardSyncStatus` attaches `schedule`; workspace status includes schedule per board. |
| `Backend/src/services/sync/queue.js` | Unchanged except tests may import it for `addBulk`. |
| `Backend/src/workers/syncWorker.js` | Concurrency 1; `scheduled_sync` uses the same catch-up path as manual. |
| `Backend/src/models/Board.js` | Add `scheduled_sync` to `syncStatus` enum. |
| `Backend/src/models/SyncExecution.js` | Add `scheduled_sync` to `syncType` enum. |
| `Backend/.env.example` | `BOARD_SYNC_CRON`. |
| `Frontend/lib/board-sync-status-helpers.ts` | Types and label/format helpers. |
| `Frontend/lib/board-sync-status-panel.tsx` | Previous / current / next panel; reads workspace poll from context. |
| `Frontend/app/workspace/[id]/board/[boardId]/configuration/page.tsx` | Render the panel when sync is on. |
| `Frontend/e2e/board-sync-schedule.spec.ts` | Signed-in configuration shows schedule data from workspace poll. |
| `docs/scheduling.md` | In-process cron, cron env, concurrency 1. |

**Do not create:** per-board schedule helpers, a new queue, a cron text field on the configuration page.

---

### Task 1: Constants, eligibility, and fan-out specs

> **Deviation:** No `BOARD_SYNC_TARGET_ID`; period keys use `scheduledSyncPeriodKey`, not `automationPeriodKey`. Snippets below are historical.

**Files:**
- Create: `Backend/src/constants/sync.js`
- Modify: `Backend/src/constants/scheduler.js`
- Create: `Backend/src/utils/boardSyncSweepHelpers.js`
- Test: `Backend/test/unit/utils/boardSyncSweepHelpers.test.js`

**Interfaces:**
- Consumes: `automationPeriodKey({ slot, timezone })`
- Produces:
  - `BOARD_SYNC_KIND = 'board_sync'`
  - `BOARD_SYNC_TARGET_ID = 'portal'`
  - `BOARD_SYNC_CRON_DEFAULT = '0 2 * * *'`
  - `SYNC_WORKER_CONCURRENCY = 1`
  - `SCHEDULED_SYNC_JOB_TYPE = 'scheduled_sync'`
  - `resolveBoardSyncCron(env) => string`
  - `isEligibleSyncBoard(board) => boolean`
  - `buildScheduledSyncSpecs({ boards, slot, timezone, authorization }) => Array<{ name, data, opts }>`

- [x] **Step 1: Write the failing test**

Create `Backend/test/unit/utils/boardSyncSweepHelpers.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import {
  BOARD_SYNC_CRON_DEFAULT,
  BOARD_SYNC_KIND,
  BOARD_SYNC_TARGET_ID,
} from '../../../src/constants/scheduler.js';
import { SCHEDULED_SYNC_JOB_TYPE } from '../../../src/constants/sync.js';
import {
  buildScheduledSyncSpecs,
  isEligibleSyncBoard,
  resolveBoardSyncCron,
} from '../../../src/utils/boardSyncSweepHelpers.js';

const TZ = 'Australia/Sydney';
const slot = new Date('2026-08-11T16:00:00Z'); // 02:00 on the 12th, Sydney

describe('resolveBoardSyncCron', () => {
  it('defaults to daily 02:00 when the env var is blank', () => {
    expect(BOARD_SYNC_CRON_DEFAULT).toBe('0 2 * * *');
    expect(resolveBoardSyncCron({})).toBe('0 2 * * *');
    expect(resolveBoardSyncCron({ BOARD_SYNC_CRON: '   ' })).toBe('0 2 * * *');
  });

  it('uses a trimmed BOARD_SYNC_CRON when set', () => {
    expect(resolveBoardSyncCron({ BOARD_SYNC_CRON: '  0 4 * * *  ' })).toBe('0 4 * * *');
  });
});

describe('isEligibleSyncBoard', () => {
  it('accepts a sync-enabled board with ids', () => {
    expect(isEligibleSyncBoard({
      syncData: true, boardId: 'b1', workspaceId: 'ws-1',
    })).toBe(true);
  });

  it('rejects boards that are not syncing or missing ids', () => {
    expect(isEligibleSyncBoard({ syncData: false, boardId: 'b1', workspaceId: 'ws-1' })).toBe(false);
    expect(isEligibleSyncBoard({ syncData: true, boardId: '', workspaceId: 'ws-1' })).toBe(false);
    expect(isEligibleSyncBoard({ syncData: true, boardId: 'b1', workspaceId: null })).toBe(false);
  });
});

describe('buildScheduledSyncSpecs', () => {
  it('emits one scheduled_sync job per eligible board and skips the rest', () => {
    const specs = buildScheduledSyncSpecs({
      boards: [
        { syncData: true, boardId: 'b1', workspaceId: 'ws-1' },
        { syncData: false, boardId: 'b2', workspaceId: 'ws-1' },
        { syncData: true, boardId: 'b3', workspaceId: 'ws-2' },
      ],
      slot,
      timezone: TZ,
      authorization: 'Bearer t',
    });

    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({
      name: SCHEDULED_SYNC_JOB_TYPE,
      data: {
        jobType: SCHEDULED_SYNC_JOB_TYPE,
        authorization: 'Bearer t',
        workspaceId: 'ws-1',
        boardId: 'b1',
      },
    });
    expect(specs[0].opts.jobId).toBe('sched:b1:20260812-0200');
    expect(specs[1].opts.jobId).toBe('sched:b3:20260812-0200');
  });

  it('is stable for the same claimed slot', () => {
    const args = {
      boards: [{ syncData: true, boardId: 'b1', workspaceId: 'ws-1' }],
      slot,
      timezone: TZ,
      authorization: 'Bearer t',
    };
    expect(buildScheduledSyncSpecs(args)[0].opts.jobId).toBe(
      buildScheduledSyncSpecs({ ...args, slot: new Date(slot) })[0].opts.jobId,
    );
  });

  it('does not mutate the boards argument', () => {
    const boards = [{ syncData: true, boardId: 'b1', workspaceId: 'ws-1' }];
    buildScheduledSyncSpecs({ boards, slot, timezone: TZ, authorization: 'Bearer t' });
    expect(boards).toEqual([{ syncData: true, boardId: 'b1', workspaceId: 'ws-1' }]);
  });
});

describe('portal identifiers', () => {
  it('uses the existing kind with a sentinel target, not a board id', () => {
    expect(BOARD_SYNC_KIND).toBe('board_sync');
    expect(BOARD_SYNC_TARGET_ID).toBe('portal');
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

Run: `cd Backend && npm test -- test/unit/utils/boardSyncSweepHelpers.test.js`

Expected: FAIL — cannot find `boardSyncSweepHelpers.js` / `constants/sync.js`.

- [x] **Step 3: Implement**

Add to `Backend/src/constants/scheduler.js` (import-free; update the `AT_LEAST_ONCE` touchpoint comment to include the sweep helper and `portalSchedule.js`):

```javascript
/**
 * Registry key for the portal-wide ISO+ board catch-up sweep.
 * Touchpoints: handlers.js, portalSchedule.js, boardSyncSweepHelpers.js,
 * boardSyncScheduleViewHelpers.js.
 */
export const BOARD_SYNC_KIND = 'board_sync';

/**
 * Sentinel ScheduledJob.targetId for the one portal sweep. Not a board id.
 * Touchpoints: portalSchedule.js, handlers.js, getBoardSyncStatus.
 */
export const BOARD_SYNC_TARGET_ID = 'portal';

/**
 * Daily 02:00. Used when BOARD_SYNC_CRON is unset.
 * Touchpoints: boardSyncSweepHelpers.js (resolveBoardSyncCron).
 */
export const BOARD_SYNC_CRON_DEFAULT = '0 2 * * *';
```

Create `Backend/src/constants/sync.js`:

```javascript
/**
 * How many board-sync jobs may run at once. 1 is the traffic cap for
 * scheduled catch-up, manual Resync, and backlog sharing this worker.
 * Touchpoints: workers/syncWorker.js.
 */
export const SYNC_WORKER_CONCURRENCY = 1;

/**
 * BullMQ jobType / Board.syncStatus / SyncExecution.syncType for a
 * scheduled catch-up. Same work as manual_triggered_sync, distinct label.
 * Touchpoints: boardSyncSweepHelpers.js, syncWorker.js, models/Board.js,
 * models/SyncExecution.js.
 */
export const SCHEDULED_SYNC_JOB_TYPE = 'scheduled_sync';
```

Create `Backend/src/utils/boardSyncSweepHelpers.js`:

```javascript
import { automationPeriodKey } from './automationPeriodKey.js';
import { BOARD_SYNC_CRON_DEFAULT } from '../constants/scheduler.js';
import { SCHEDULED_SYNC_JOB_TYPE } from '../constants/sync.js';

export function resolveBoardSyncCron(env = process.env) {
  const raw = typeof env.BOARD_SYNC_CRON === 'string' ? env.BOARD_SYNC_CRON.trim() : '';
  return raw || BOARD_SYNC_CRON_DEFAULT;
}

export function isEligibleSyncBoard(board) {
  return Boolean(
    board?.syncData === true
    && typeof board.boardId === 'string'
    && board.boardId.trim()
    && typeof board.workspaceId === 'string'
    && board.workspaceId.trim(),
  );
}

export function buildScheduledSyncSpecs({ boards, slot, timezone, authorization }) {
  const periodKey = automationPeriodKey({ slot, timezone });
  return boards.filter(isEligibleSyncBoard).map((board) => ({
    name: SCHEDULED_SYNC_JOB_TYPE,
    data: {
      jobType: SCHEDULED_SYNC_JOB_TYPE,
      authorization,
      workspaceId: board.workspaceId,
      boardId: board.boardId,
    },
    opts: { jobId: `sched:${board.boardId}:${periodKey}` },
  }));
}
```

- [x] **Step 4: Re-run**

Run: `cd Backend && npm test -- test/unit/utils/boardSyncSweepHelpers.test.js`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add Backend/src/constants/scheduler.js Backend/src/constants/sync.js \
  Backend/src/utils/boardSyncSweepHelpers.js \
  Backend/test/unit/utils/boardSyncSweepHelpers.test.js
git commit -m "$(cat <<'EOF'
feat: add portal board-sync sweep constants and fan-out specs

EOF
)"
```

---

### Task 2: `runBoardSyncSweep` fans out instead of syncing one board

> **Deviation:** `board_sync` is **not** registered on the EventBridge tick.
> `runBoardSyncSweep` is called from `startBoardSyncCron` instead.

**Files:**
- Modify: `Backend/src/services/scheduler/handlers.js`
- Modify: `Backend/test/unit/services/scheduler.handlers.test.js`

**Interfaces:**
- Consumes: `buildScheduledSyncSpecs`, `getSchedulerAuthorization`, `syncQueue.addBulk`, `Board.find`, `requireSlot` (already in handlers for automation), `isOfflineMode`
- Produces: `runBoardSyncSweep(job)` — exported for tests. Zero boards or offline → resolve. Else `addBulk` of `scheduled_sync` jobs.

The existing handler calls `triggerManualSync(workspaceId, targetId)`. After this task `targetId` is `'portal'` and must **not** be passed to `triggerManualSync`.

- [x] **Step 1: Write the failing tests**

Replace the `board_sync` cases in `Backend/test/unit/services/scheduler.handlers.test.js` that assume `triggerManualSync` is called with a board id. Keep the file's `clearRegistry` / token restore pattern. Add Board seeds and `recordedBulkJobs` from `test/helpers/queue.js`.

```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Board from '../../../src/models/Board.js';
import { registerSchedulerHandlers, runBoardSyncSweep } from '../../../src/services/scheduler/handlers.js';
import { resolve, clearRegistry } from '../../../src/services/scheduler/registry.js';
import { AT_LEAST_ONCE, BOARD_SYNC_KIND } from '../../../src/constants/scheduler.js';
import { SCHEDULED_SYNC_JOB_TYPE } from '../../../src/constants/sync.js';
import { recordedBulkJobs, resetRecordedJobs } from '../../helpers/queue.js';
import { isOfflineMode } from '../../../src/services/offlineIsoplus.js';

vi.mock('../../../src/services/offlineIsoplus.js', () => ({
  isOfflineMode: vi.fn(() => false),
}));

describe('board_sync sweep handler', () => {
  const originalToken = process.env.PERSONAL_ACCESS_TOKEN;

  beforeEach(() => {
    clearRegistry();
    resetRecordedJobs();
    process.env.PERSONAL_ACCESS_TOKEN = 'test-token';
    isOfflineMode.mockReturnValue(false);
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.PERSONAL_ACCESS_TOKEN;
    else process.env.PERSONAL_ACCESS_TOKEN = originalToken;
  });

  it('registers board_sync under AT_LEAST_ONCE', () => {
    registerSchedulerHandlers();
    const entry = resolve(BOARD_SYNC_KIND);
    expect(entry.policy).toBe(AT_LEAST_ONCE);
  });

  it('enqueues one scheduled_sync job per sync-enabled board for the claimed slot', async () => {
    await Board.create([
      { boardId: 'on-1', name: 'A', workspaceId: 'ws-1', syncData: true },
      { boardId: 'off-1', name: 'B', workspaceId: 'ws-1', syncData: false },
      { boardId: 'on-2', name: 'C', workspaceId: 'ws-2', syncData: true },
    ]);
    registerSchedulerHandlers();
    const { handler } = resolve(BOARD_SYNC_KIND);
    const slot = new Date('2026-08-11T16:00:00Z');

    await handler({
      targetId: 'portal',
      workspaceId: null,
      scheduledFor: slot,
      timezone: 'Australia/Sydney',
    });

    const jobs = recordedBulkJobs().filter((j) => j.name === SCHEDULED_SYNC_JOB_TYPE);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.data.boardId).sort()).toEqual(['on-1', 'on-2']);
    expect(jobs[0].data.jobType).toBe(SCHEDULED_SYNC_JOB_TYPE);
    expect(jobs[0].data.authorization).toBe('Bearer test-token');
  });

  it('resolves without enqueueing when no board has sync enabled', async () => {
    await Board.create({ boardId: 'off-1', name: 'B', workspaceId: 'ws-1', syncData: false });
    await runBoardSyncSweep({
      scheduledFor: new Date('2026-08-11T16:00:00Z'),
      timezone: 'Australia/Sydney',
    });
    expect(recordedBulkJobs()).toEqual([]);
  });

  it('skips without throwing in offline mode', async () => {
    isOfflineMode.mockReturnValue(true);
    await Board.create({ boardId: 'on-1', name: 'A', workspaceId: 'ws-1', syncData: true });
    await expect(runBoardSyncSweep({
      scheduledFor: new Date('2026-08-11T16:00:00Z'),
      timezone: 'Australia/Sydney',
    })).resolves.toBeUndefined();
    expect(recordedBulkJobs()).toEqual([]);
  });
});
```

Delete the old tests that expect `triggerManualSync` + `alreadyRunning` for this kind. Automation handler tests in the same file (if any) stay.

If the current file only tests `board_sync` + `triggerManualSync`, replace the whole describe. If it also tests `runAutomationKind`, leave those describes untouched.

- [x] **Step 2: Run and confirm fail**

Run: `cd Backend && npm test -- test/unit/services/scheduler.handlers.test.js`

Expected: FAIL — `runBoardSyncSweep` is not exported, or `triggerManualSync` is still the handler body.

- [x] **Step 3: Implement**

In `handlers.js`:

- Import `Board`, `syncQueue` (default from `../sync/queue.js`), `buildScheduledSyncSpecs`, `BOARD_SYNC_KIND`, `runBoardSyncSweep` export.
- Keep `assertSyncDispatched` **only if** something else still uses `triggerManualSync`. If `board_sync` is the sole caller, delete `assertSyncDispatched` and the `triggerManualSync` import.
- Import `DEFAULT_TIMEZONE` from constants. Implement:

```javascript
export async function runBoardSyncSweep(job) {
  if (isOfflineMode()) {
    warn('Scheduler', 'board_sync skipped: backend is in offline mode', {
      kind: BOARD_SYNC_KIND,
      targetId: job.targetId,
    });
    return;
  }

  const slot = job.scheduledFor ?? job.nextRunAt;
  if (!slot) {
    throw new Error('board_sync: dispatched without a slot; refusing to fan out');
  }

  const boards = await Board.find({ syncData: true })
    .select('boardId workspaceId syncData')
    .lean();

  const specs = buildScheduledSyncSpecs({
    boards,
    slot,
    timezone: job.timezone || DEFAULT_TIMEZONE,
    authorization: getSchedulerAuthorization(),
  });

  if (specs.length === 0) {
    info('Scheduler', 'board_sync sweep: no sync-enabled boards', { count: 0 });
    return;
  }

  await syncQueue.addBulk(specs);
  info('Scheduler', 'board_sync sweep enqueued', { count: specs.length });
}
```

Register:

```javascript
  register(BOARD_SYNC_KIND, {
    policy: AT_LEAST_ONCE,
    handler: (job) => runBoardSyncSweep(job),
  });
```

- [x] **Step 4: Re-run**

Run: `cd Backend && npm test -- test/unit/services/scheduler.handlers.test.js`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add Backend/src/services/scheduler/handlers.js \
  Backend/test/unit/services/scheduler.handlers.test.js
git commit -m "$(cat <<'EOF'
feat: fan out scheduled board sync to every sync-enabled board

EOF
)"
```

---

### Task 3: Start the in-process board-sync cron at boot

> **Deviation:** This task originally specified `ensurePortalBoardSyncSchedule`
> (upsert a portal `ScheduledJob` for the tick). Shipped code uses
> `startBoardSyncCron` instead — see "Changes since this plan was written".

**Files:**
- Create: `Backend/src/services/scheduler/portalSchedule.js`
- Modify: `Backend/src/index.js`
- Test: `Backend/test/unit/services/scheduler.portalSchedule.test.js`
- Modify: `Backend/.env.example`

**Interfaces (as shipped):**
- Consumes: `resolveBoardSyncCron`, `computeNextRun`, `runBoardSyncSweep`, `BOARD_SYNC_KIND`
- Produces: `startBoardSyncCron({ env }) => { stop } | null`, `buildPortalBoardSyncMeta({ now })`

Call `startBoardSyncCron()` from `mongoose.connect(...).then`, not at module load.
Skipped when `NODE_ENV=test` or `BOARD_SYNC_CRON` is invalid.

- [x] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, afterEach } from 'vitest';
import ScheduledJob from '../../../src/models/ScheduledJob.js';
import { ensurePortalBoardSyncSchedule } from '../../../src/services/scheduler/portalSchedule.js';
import {
  BOARD_SYNC_CRON_DEFAULT,
  BOARD_SYNC_KIND,
  BOARD_SYNC_TARGET_ID,
} from '../../../src/constants/scheduler.js';

const NOW = new Date('2026-08-11T04:05:00Z');

describe('ensurePortalBoardSyncSchedule', () => {
  const original = process.env.BOARD_SYNC_CRON;
  afterEach(() => {
    if (original === undefined) delete process.env.BOARD_SYNC_CRON;
    else process.env.BOARD_SYNC_CRON = original;
  });

  it('upserts one enabled portal row with the default daily cron', async () => {
    delete process.env.BOARD_SYNC_CRON;
    const job = await ensurePortalBoardSyncSchedule({ now: NOW });

    expect(job.kind).toBe(BOARD_SYNC_KIND);
    expect(job.targetId).toBe(BOARD_SYNC_TARGET_ID);
    expect(job.cron).toBe(BOARD_SYNC_CRON_DEFAULT);
    expect(job.enabled).toBe(true);
    expect(await ScheduledJob.countDocuments({ kind: BOARD_SYNC_KIND })).toBe(1);
  });

  it('rewrites cron from BOARD_SYNC_CRON rather than inserting a second row', async () => {
    await ensurePortalBoardSyncSchedule({ now: NOW });
    process.env.BOARD_SYNC_CRON = '0 4 * * *';
    const updated = await ensurePortalBoardSyncSchedule({ now: NOW });

    expect(updated.cron).toBe('0 4 * * *');
    expect(await ScheduledJob.countDocuments({
      kind: BOARD_SYNC_KIND, targetId: BOARD_SYNC_TARGET_ID,
    })).toBe(1);
  });
});
```

- [x] **Step 2: Run and confirm fail**

Run: `cd Backend && npm test -- test/unit/services/scheduler.portalSchedule.test.js`

Expected: FAIL — module not found.

- [x] **Step 3: Implement**

`Backend/src/services/scheduler/portalSchedule.js`:

```javascript
import { upsertSchedule } from './schedules.js';
import { resolveBoardSyncCron } from '../../utils/boardSyncSweepHelpers.js';
import { BOARD_SYNC_KIND, BOARD_SYNC_TARGET_ID } from '../../constants/scheduler.js';

export async function ensurePortalBoardSyncSchedule({ now = new Date() } = {}) {
  return upsertSchedule({
    kind: BOARD_SYNC_KIND,
    targetId: BOARD_SYNC_TARGET_ID,
    workspaceId: null,
    cron: resolveBoardSyncCron(),
    now,
  });
}
```

In `Backend/src/index.js`, import `ensurePortalBoardSyncSchedule` and change the connect handler:

```javascript
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    info('Bootstrap', 'Connected to MongoDB');
    try {
      await ensurePortalBoardSyncSchedule();
    } catch (err) {
      warn('Bootstrap', 'Could not upsert the portal board_sync schedule', {
        error: err.message,
      });
    }
  })
  .catch((err) => logError('Bootstrap', 'MongoDB connection error', err));
```

Do **not** add this to `createApp()` — tests register fake handlers and must not write the portal row as a side effect of importing the app.

Add to `Backend/.env.example` (comment: without it, catch-up still runs at the default `0 2 * * *` Australia/Sydney; set it to change cadence without a code change; invalid cron logs at boot and leaves no updated row):

```
# Cron for the portal-wide ISO+ board catch-up (one job, then every sync-enabled
# board is queued). Default if unset: 0 2 * * * (02:00 Australia/Sydney).
# Invalid expressions are rejected at boot; the previous ScheduledJob row stays.
BOARD_SYNC_CRON=
```

- [x] **Step 4: Re-run**

Run: `cd Backend && npm test -- test/unit/services/scheduler.portalSchedule.test.js test/unit/services/scheduler.handlers.test.js`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add Backend/src/services/scheduler/portalSchedule.js Backend/src/index.js \
  Backend/.env.example Backend/test/unit/services/scheduler.portalSchedule.test.js
git commit -m "$(cat <<'EOF'
feat: upsert the portal board_sync schedule when Mongo connects

EOF
)"
```

---

### Task 4: `scheduled_sync` job type and worker concurrency 1

**Files:**
- Modify: `Backend/src/models/Board.js` (`syncStatus` enum)
- Modify: `Backend/src/models/SyncExecution.js` (`syncType` enum)
- Modify: `Backend/src/workers/syncWorker.js`
- Modify: `Backend/test/unit/workers/syncWorker.test.js`
- Modify: `Backend/test/unit/models/board.test.js` only if it enumerates statuses

**Interfaces:**
- Consumes: `SYNC_WORKER_CONCURRENCY`, `SCHEDULED_SYNC_JOB_TYPE`
- Produces: `processJob` handles `scheduled_sync` via the same catch-up as `manual_triggered_sync`, recording `scheduled_sync` on the board. Worker `opts.concurrency === 1`.

- [x] **Step 1: Write the failing tests**

In `Backend/test/unit/workers/syncWorker.test.js`, change the concurrency test:

```javascript
  it('subscribes to the board-sync queue with a concurrency of one', () => {
    expect(bull.workers).toHaveLength(1);
    expect(bull.workers[0].name).toBe('board-sync');
    expect(bull.workers[0].opts.concurrency).toBe(1);
    expect(bull.workers[0].opts.limiter).toEqual({ max: 10, duration: 1000 });
  });
```

Add (mirror the existing manual-sync dispatch test; copy its `makeJob` / mock pattern from that file):

```javascript
  it('dispatches scheduled_sync through the catch-up path', async () => {
    const job = makeJob({ jobType: 'scheduled_sync', boardId: 'b1', workspaceId: 'w1' });
    await processJob(job);
    // Assert the same backlog/catch-up function the manual test already
    // asserts — if that test spies processDataBacklogSync or Board updates,
    // assert syncStatus 'scheduled_sync' the same way.
  });
```

Read the existing `'runs the backlog sync and records the manual sync type'` test in that file and duplicate it for `scheduled_sync` / `scheduled_sync` status rather than inventing a new spy style.

Also add a model test if none exists:

```javascript
  it('accepts scheduled_sync as a syncStatus', async () => {
    const board = await Board.create({
      boardId: 'b-sched', name: 'Jobs', workspaceId: 'w1',
      syncStatus: 'scheduled_sync',
    });
    expect(board.syncStatus).toBe('scheduled_sync');
  });
```

in `Backend/test/unit/models/board.test.js`.

- [x] **Step 2: Run and confirm fail**

Run: `cd Backend && npm test -- test/unit/workers/syncWorker.test.js test/unit/models/board.test.js`

Expected: FAIL — concurrency still 2; `Unknown job type: scheduled_sync`; enum rejection.

- [x] **Step 3: Implement**

Add `'scheduled_sync'` to both enums.

In `syncWorker.js`:

- Import `SYNC_WORKER_CONCURRENCY` and `SCHEDULED_SYNC_JOB_TYPE`.
- Use `concurrency: SYNC_WORKER_CONCURRENCY` in the Worker options and the boot log.
- In `resolveRetryJobName`, map `SCHEDULED_SYNC_JOB_TYPE` to `'scheduled_sync'` (or `'manual_sync'` if retries must share that name — prefer `'scheduled_sync'`).
- Change `processManualTriggeredSync` to take the status from `job.data.jobType` when it is `manual_triggered_sync` or `scheduled_sync`:

```javascript
async function processCatchUpSync(job) {
  const { workspaceId, boardId, jobType } = job.data;
  await Board.findOneAndUpdate(
    { boardId },
    { $set: { syncStatus: jobType, syncJobId: job.id } },
  );
  return processDataBacklogSync(job);
}
```

Switch:

```javascript
      case 'manual_triggered_sync':
      case SCHEDULED_SYNC_JOB_TYPE:
        result = await processCatchUpSync(job);
        break;
```

Delete the old `processManualTriggeredSync` if it is fully replaced.

If `processDataBacklogSync` already writes `syncStatus` from `job.data.jobType`, confirm the enum includes `scheduled_sync` so Mongoose does not strip it. Do not change webhook disable/re-enable behaviour.

- [x] **Step 4: Re-run**

Run: `cd Backend && npm test -- test/unit/workers/syncWorker.test.js test/unit/models/board.test.js`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add Backend/src/workers/syncWorker.js Backend/src/models/Board.js \
  Backend/src/models/SyncExecution.js Backend/test/unit/workers/syncWorker.test.js \
  Backend/test/unit/models/board.test.js
git commit -m "$(cat <<'EOF'
feat: run scheduled board catch-up one board at a time

EOF
)"
```

---

### Task 5: Status payload — previous, current, next

> **Deviation:** Next run comes from `buildPortalBoardSyncMeta()` / `computeNextRun`, not `ScheduledJob.findOne({ targetId: BOARD_SYNC_TARGET_ID })`. Snippets below are historical.

**Files:**
- Create: `Backend/src/utils/boardSyncScheduleViewHelpers.js`
- Modify: `Backend/src/services/sync.js` (`getBoardSyncStatus`)
- Test: `Backend/test/unit/utils/boardSyncScheduleViewHelpers.test.js`
- Modify: `Backend/test/unit/services/sync.test.js`

**Interfaces:**
- Consumes: portal `ScheduledJob`, last completed `SyncExecution`, existing `jobStatus` / `syncExecution`
- Produces: `schedule: { cron, timezone, previous, current, upcoming }` on `getBoardSyncStatus`

`previous`: `{ at, status, syncType } | null` — last `SyncExecution` with `status: 'completed'` for the board, else `{ at: lastSyncedAt, status: 'completed', syncType: null }` if `lastSyncedAt` is set.

`current`: `{ state, syncType } | null` — active execution or job in `active`/`waiting`; if `syncStatus` is `scheduled_sync` or `manual_triggered_sync` and no job object, still `{ state: 'in-progress', syncType: board.syncStatus }`; else `null` (UI shows Idle).

`upcoming`: `{ at: nextRunAt } | null` from the portal schedule row.

- [x] **Step 1: Write the failing tests**

`Backend/test/unit/utils/boardSyncScheduleViewHelpers.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { buildBoardSyncScheduleView } from '../../../src/utils/boardSyncScheduleViewHelpers.js';

const upcoming = new Date('2026-08-20T16:00:00Z');
const portal = {
  cron: '0 2 * * *',
  timezone: 'Australia/Sydney',
  nextRunAt: upcoming,
};

describe('buildBoardSyncScheduleView', () => {
  it('returns Idle current, lastSyncedAt as previous, and portal nextRunAt', () => {
    const lastSyncedAt = new Date('2026-08-18T16:00:00Z');
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'realtime_sync', lastSyncedAt },
      jobStatus: null,
      syncExecution: null,
      lastCompleted: null,
      portalSchedule: portal,
    });
    expect(view.cron).toBe('0 2 * * *');
    expect(view.previous).toEqual({
      at: lastSyncedAt, status: 'completed', syncType: null,
    });
    expect(view.current).toBeNull();
    expect(view.upcoming).toEqual({ at: upcoming });
  });

  it('prefers a completed execution over lastSyncedAt', () => {
    const at = new Date('2026-08-17T16:00:00Z');
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'realtime_sync', lastSyncedAt: new Date('2026-08-10T00:00:00Z') },
      jobStatus: null,
      syncExecution: null,
      lastCompleted: { endTime: at, status: 'completed', syncType: 'scheduled_sync' },
      portalSchedule: portal,
    });
    expect(view.previous).toEqual({
      at, status: 'completed', syncType: 'scheduled_sync',
    });
  });

  it('surfaces an in-flight catch-up as current', () => {
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'scheduled_sync', lastSyncedAt: null },
      jobStatus: { state: 'waiting' },
      syncExecution: null,
      lastCompleted: null,
      portalSchedule: portal,
    });
    expect(view.current).toEqual({ state: 'waiting', syncType: 'scheduled_sync' });
  });

  it('omits upcoming when the portal schedule is missing', () => {
    const view = buildBoardSyncScheduleView({
      board: { syncStatus: 'realtime_sync', lastSyncedAt: null },
      jobStatus: null,
      syncExecution: null,
      lastCompleted: null,
      portalSchedule: null,
    });
    expect(view.upcoming).toBeNull();
    expect(view.cron).toBeNull();
  });
});
```

In `getBoardSyncStatus` tests, after seeding a board with `syncData: true` and inserting a portal schedule, assert `status.schedule.upcoming.at` is defined.

- [x] **Step 2: Run and confirm fail**

Run: `cd Backend && npm test -- test/unit/utils/boardSyncScheduleViewHelpers.test.js`

Expected: FAIL — module not found.

- [x] **Step 3: Implement the helper and wire `getBoardSyncStatus`**

Helper: pure mapping only. No I/O.

In `getBoardSyncStatus`, after the existing job/execution loads:

```javascript
    const [lastCompleted, portalSchedule] = await Promise.all([
      SyncExecution.findOne({ boardId, status: 'completed' })
        .sort({ endTime: -1 })
        .select('endTime status syncType')
        .lean(),
      ScheduledJob.findOne({ kind: BOARD_SYNC_KIND, targetId: BOARD_SYNC_TARGET_ID })
        .select('cron timezone nextRunAt')
        .lean(),
    ]);

    const schedule = buildBoardSyncScheduleView({
      board,
      jobStatus,
      syncExecution,
      lastCompleted,
      portalSchedule,
    });
```

Include `schedule` on the returned object. Import `ScheduledJob`. Keep complexity down by not inlining the mapping.

- [x] **Step 4: Re-run**

Run: `cd Backend && npm test -- test/unit/utils/boardSyncScheduleViewHelpers.test.js test/unit/services/sync.test.js test/unit/routes/sync.test.js`

Expected: PASS. Existing status tests that use `toMatchObject` still pass if they do not forbid extra keys.

- [x] **Step 5: Commit**

```bash
git add Backend/src/utils/boardSyncScheduleViewHelpers.js Backend/src/services/sync.js \
  Backend/test/unit/utils/boardSyncScheduleViewHelpers.test.js \
  Backend/test/unit/services/sync.test.js
git commit -m "$(cat <<'EOF'
feat: expose previous, current and next board sync on status

EOF
)"
```

---

### Task 6: Board Configuration status panel

> **Deviation:** Panel reads `schedule` from the Header workspace status poll (`workspaceBoardStatuses`), not a per-page `GET /api/sync/board/status/:boardId` fetch. Snippets below are historical.

**Files:**
- Create: `Frontend/lib/board-sync-status-helpers.ts`
- Create: `Frontend/lib/board-sync-status-panel.tsx`
- Modify: `Frontend/app/workspace/[id]/board/[boardId]/configuration/page.tsx`
- Test: `Frontend/test/unit/lib/board-sync-status-helpers.test.ts`
- Modify: `Frontend/test/unit/app/workspace/[id]/board/[boardId]/configuration/page.test.tsx`

**Interfaces:**
- Consumes: `GET ${NEXT_PUBLIC_BACKEND_URL}/api/sync/board/status/${boardId}`
- Produces: when the Sync checkbox is checked, a region **Sync schedule** with Previous, Current, Next scheduled run.

- [x] **Step 1: Write the failing tests**

`Frontend/test/unit/lib/board-sync-status-helpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  formatScheduleInstant,
  labelCurrentSync,
  labelPreviousSync,
  labelUpcomingSync,
} from '@/lib/board-sync-status-helpers';

describe('board sync status copy', () => {
  it('says none yet when previous is missing', () => {
    expect(labelPreviousSync(null)).toBe('None yet');
  });

  it('says Idle when current is missing', () => {
    expect(labelCurrentSync(null)).toBe('Idle');
  });

  it('says Not scheduled when upcoming is missing', () => {
    expect(labelUpcomingSync(null)).toBe('Not scheduled');
  });

  it('formats an instant in en-AU', () => {
    expect(formatScheduleInstant('2026-08-18T16:00:00.000Z')).toMatch(/2026/);
  });
});
```

In the configuration page test, extend `stubConfigurationData` to stub `GET */api/sync/board/status/b-1` returning:

```javascript
{
  syncData: true,
  syncStatus: 'realtime_sync',
  schedule: {
    cron: '0 2 * * *',
    timezone: 'Australia/Sydney',
    previous: { at: '2026-08-18T16:00:00.000Z', status: 'completed', syncType: 'scheduled_sync' },
    current: null,
    upcoming: { at: '2026-08-20T16:00:00.000Z' },
  },
}
```

Add:

```javascript
  it('shows previous, current and next run when data sync is enabled', async () => {
    stubConfigurationData();
    renderPage();
    expect(await screen.findByRole('region', { name: /sync schedule/i })).toBeInTheDocument();
    expect(screen.getByText('Previous')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Next scheduled run')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('does not show the sync schedule region when sync is off', async () => {
    stubConfigurationData({
      board: { board: { ...BOARD.board, syncData: false } },
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Board Configuration' });
    expect(screen.queryByRole('region', { name: /sync schedule/i })).not.toBeInTheDocument();
  });
```

- [x] **Step 2: Run and confirm fail**

Run: `cd Frontend && npm test -- test/unit/lib/board-sync-status-helpers.test.ts test/unit/app/workspace/[id]/board/[boardId]/configuration/page.test.tsx`

Expected: FAIL — missing module / missing region.

- [x] **Step 3: Implement**

Helpers: `formatScheduleInstant` uses `Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Sydney' })` — pass timezone from the payload when present rather than adding a new hardcoded zone string in a second file; default argument `timezone` from the schedule object.

Panel: `<section aria-label="Sync schedule">` with three labelled rows. Keep it out of `page.tsx` so the page does not grow past the complexity gate.

On the configuration page, when `syncData` is true, fetch status (same axios instance as the rest of the page). Do not fetch when sync is off.

- [x] **Step 4: Re-run**

Run: `cd Frontend && npm test -- test/unit/lib/board-sync-status-helpers.test.ts test/unit/app/workspace/[id]/board/[boardId]/configuration/page.test.tsx`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add Frontend/lib/board-sync-status-helpers.ts Frontend/lib/board-sync-status-panel.tsx \
  Frontend/app/workspace/[id]/board/[boardId]/configuration/page.tsx \
  Frontend/test/unit/lib/board-sync-status-helpers.test.ts \
  Frontend/test/unit/app/workspace/[id]/board/[boardId]/configuration/page.test.tsx
git commit -m "$(cat <<'EOF'
feat: show board sync previous, current and next run on configuration

EOF
)"
```

---

### Task 7: End-to-end — configuration shows the three labels

**Files:**
- Create: `Frontend/e2e/board-sync-schedule.spec.ts`

**Interfaces:**
- Consumes: the same login pattern as `Frontend/e2e/invoice-statement-automation.spec.ts`
- Produces: a signed-in visit to a seeded board's configuration page that sees **Sync schedule**, **Previous**, **Current**, **Next scheduled run**

Use `E2E_EMAIL` / `E2E_PASSWORD`, `E2E_WORKSPACE_ID` default `55369`, `E2E_BOARD_ID` default `eNiJpH14PN3` (already used in `auth-boundary.spec.ts`). `test.skip` when credentials are missing.

The seeded board may have `syncData` false. If the region only renders when sync is on, the test should enable the checkbox **only if** that is already allowed for support_admin and does not persist a destructive change — prefer asserting against a board that already has `syncData: true` in the seed. If the seed board is off, skip with a message naming `E2E_BOARD_ID` rather than toggling production-like data in CI.

Read `seed/README.md` / the seeded board's `syncData` before writing the skip. If the default board is on, assert the region. If it is off, assert the checkbox is present and the region is absent (still a user-visible journey), **plus** a unit test already covers the on-state. Prefer the on-state if the seed allows it.

- [x] **Step 1: Write the spec**

Follow `signIn` from `invoice-statement-automation.spec.ts`. Path: `/workspace/${WORKSPACE}/board/${BOARD}/configuration`.

```typescript
  test("board configuration shows sync schedule when sync is enabled", async ({ page }) => {
    await signIn(page);
    await page.goto(`/workspace/${WORKSPACE}/board/${BOARD}/configuration`);
    await expect(page.getByRole("heading", { name: "Board Configuration" })).toBeVisible();

    const syncCheckbox = page.getByRole("checkbox", {
      name: /sync data from iso\+/i,
    });
    await expect(syncCheckbox).toBeVisible();

    if (await syncCheckbox.isChecked()) {
      const region = page.getByRole("region", { name: /sync schedule/i });
      await expect(region).toBeVisible();
      await expect(region.getByText("Previous")).toBeVisible();
      await expect(region.getByText("Current")).toBeVisible();
      await expect(region.getByText("Next scheduled run")).toBeVisible();
    } else {
      await expect(page.getByRole("region", { name: /sync schedule/i })).toHaveCount(0);
    }
  });
```

- [x] **Step 2: Run**

Run: `cd Frontend && npm run e2e -- e2e/board-sync-schedule.spec.ts`

Expected: skip without `E2E_*`; pass against `npm run dev:up` with `dev:user` credentials. Do not claim pass without this output.

- [x] **Step 3: No extra production code unless the heading is missing**

If the checkbox accessible name does not match, change the test to the name already in the configuration page test (`Sync data from ISO+ to Portal database`), not the other way around.

- [x] **Step 4: Confirm**

Re-run the same Playwright command.

- [x] **Step 5: Commit**

```bash
git add Frontend/e2e/board-sync-schedule.spec.ts
git commit -m "$(cat <<'EOF'
test: cover board sync schedule visibility on configuration

EOF
)"
```

---

### Task 8: Docs and close Epic 7 Task 17

**Files:**
- Modify: `docs/scheduling.md`
- Modify: `docs/plans/2026-08-06-finance-settings-automation-plan.md`
- Modify: `docs/superpowers/specs/2026-08-19-automatic-board-sync-schedule-design.md` only if implementation departed (add a "Changes since approval" row then)

- [x] **Step 1: Document the sweep in `docs/scheduling.md`**

After the existing scheduler handler section, document the in-process cron:

```markdown
## Portal board catch-up (`board_sync`)

An in-process `setTimeout` + `cron-parser` timer (`startBoardSyncCron`) fires
on `BOARD_SYNC_CRON` (default `0 2 * * *` in `DEFAULT_TIMEZONE`). Each fire
calls `runBoardSyncSweep`, which fans out `scheduled_sync` jobs for every
`syncData: true` board onto `board-sync`. The worker runs them at
concurrency 1. `board_sync` is not registered on `POST /api/scheduler/tick`.
Board Configuration reads previous / current / next from the workspace status
poll (`GET /api/sync/workspace/status/:workspaceId`).
```

- [x] **Step 2: Supersede Task 17**

In `docs/plans/2026-08-06-finance-settings-automation-plan.md`, replace the Task 17 body with a pointer to this plan and the spec. Do not leave the old `/api/internal` sketch as something to implement.

- [x] **Step 3: No test run for prose.** Check the handler comment in `docs/scheduling.md` still matches `handlers.js` (fan-out, not `triggerManualSync`).

- [x] **Step 4: Commit**

```bash
git add docs/scheduling.md docs/plans/2026-08-06-finance-settings-automation-plan.md
git commit -m "$(cat <<'EOF'
docs: describe the portal-wide board sync catch-up

EOF
)"
```

---

## Out of scope

- Per-board or per-workspace cron UI
- Dropping worker concurrency below 1, or restoring 2
- System Health screens
- Migrations that insert per-board `ScheduledJob` rows
- Registering `board_sync` on `POST /api/scheduler/tick`
- Upserting a portal `ScheduledJob` row for board sync (superseded by in-process cron)

## Self-review

**Spec coverage:**

| Requirement | Task |
|---|---|
| Configurable cron, default daily | 1 + 3 + `.env.example` |
| Portal-wide, all sync-enabled boards | 2 |
| Queue, one at a time | 2 (enqueue) + 4 (concurrency 1) |
| Do not rebuild enable-time sync / hooks | Constraints; no edits to `enableBoardSync` webhook path |
| Previous / current / upcoming on configuration | 5 + 6 + 7 |
| In-process cron, not tick | 3 (deviation from original tick sketch) |

**Placeholder scan:** Cron default is `0 2 * * *`. Job prefix is `sched:`. Accessible name for the panel is `Sync schedule`.

**Type consistency:** `BOARD_SYNC_KIND`, `BOARD_SYNC_CRON_DEFAULT`, `SCHEDULED_SYNC_JOB_TYPE`, `runBoardSyncSweep`, `startBoardSyncCron`, `buildPortalBoardSyncMeta`, `buildScheduledSyncSpecs`, `buildBoardSyncScheduleView` are the names in shipped code.

**Blast radius:** Board sync clock is separate from the EventBridge tick. Worker concurrency 2 → 1 affects manual Resync and backlog too. Status JSON gains a `schedule` field (additive). Webhooks, PDF, Xero, invoice automation unchanged.
