# Visibility & Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every automation run, and surface it as a client-facing status panel plus an admin System Health tab with a per-client drill-down.

**Architecture:** A new `AutomationRun` collection is written at fan-out (one `queued` row per board, upserted on the BullMQ `jobId`) and closed by the automation worker. Pure helpers aggregate those rows into counts, an error rate and a trend; a new admin-only `/api/system-health` router serves them, and the existing automation router serves the client-scoped subset.

**Tech Stack:** Node 22, Express (ESM), Mongoose, BullMQ, Vitest + supertest, Next.js 15 App Router, React 18, shadcn/ui, Tailwind, Playwright.

**Spec:** [`docs/superpowers/specs/2026-08-13-visibility-and-monitoring-design.md`](../superpowers/specs/2026-08-13-visibility-and-monitoring-design.md)

## Global Constraints

- **Ticket:** KAN-11. Branch `feature/KAN-11_visibility_and_monitoring`, PR targets `feature/KAN-10_invoice_statement_automation_full`.
- **Failing test first**, always. Never weaken an assertion to reach green — decide whether the code or the expectation was wrong, and say which.
- **Cognitive complexity < 15 per file** (SonarJS S3776). Extract helpers rather than nesting.
- **Constants** live in `Backend/src/constants/systemHealth.js` / `Frontend/constants/system-health.ts`. The constants file imports nothing. Record each constant's touchpoints in a comment. Do not re-export a constant from its old home.
- **No new hardcoded `'Australia/Sydney'`** — read `DEFAULT_TIMEZONE` from `constants/scheduler.js`.
- **Every new route is mounted in BOTH `Backend/src/app.js` and `Backend/src/index.js`.** They are parallel express apps; `Backend/test/unit/routeMountParity.test.js` fails if only one is updated.
- **No migration** — see spec decision 1. `AutomationRun` is new, has nothing to backfill, and its indexes are declared on the schema and built by `autoIndex`.
- **Pure functions** for logic; keep Express and React concerns at the edges. `lodash-es` is available in both apps; prefer native where native is already clear.
- **No AI attribution** in commit messages or the PR body.
- Run backend tests from `Backend/` (`npm test`), frontend from `Frontend/`.

---

### Task 1: Constants and the `AutomationRun` model

**Files:**
- Create: `Backend/src/constants/systemHealth.js`
- Create: `Backend/src/models/AutomationRun.js`
- Test: `Backend/test/unit/models/automationRun.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `RUN_QUEUED`, `RUN_RUNNING`, `RUN_SUCCEEDED`, `RUN_FAILED`, `RUN_SKIPPED`, `RUN_STATUSES`, `TRIGGER_SCHEDULE`, `TRIGGER_MANUAL`, `RUN_TRIGGERS`, `SKIP_DELIVERY_NOT_IMPLEMENTED`, `ERROR_RATE_WINDOW_HOURS`, `TREND_BUCKETS`, `HISTORY_PAGE_SIZE`, `QUEUE_DEPTH_WARN` from `constants/systemHealth.js`; default export `AutomationRun` (Mongoose model) with fields `workspaceId, boardId, kind, periodKey, jobId, status, skipReason, trigger, startedAt, finishedAt, durationMs, recipient, error` plus timestamps.

- [ ] **Step 1: Write the failing test**

```js
// Backend/test/unit/models/automationRun.test.js
import { describe, it, expect } from 'vitest';

import AutomationRun from '../../../src/models/AutomationRun.js';
import {
  RUN_QUEUED,
  RUN_SKIPPED,
  TRIGGER_SCHEDULE,
  SKIP_DELIVERY_NOT_IMPLEMENTED,
} from '../../../src/constants/systemHealth.js';

const base = {
  workspaceId: 'ws-1',
  boardId: 'board-a',
  kind: 'invoice_automation',
  periodKey: '20260116-0900',
  jobId: 'inv:board-a:20260116-0900',
};

describe('AutomationRun', () => {
  it('defaults a new row to queued, scheduled, with no outcome yet', async () => {
    const run = await AutomationRun.create(base);

    expect(run.status).toBe(RUN_QUEUED);
    expect(run.trigger).toBe(TRIGGER_SCHEDULE);
    // Null, not 0: a skipped or queued run that rendered "0ms" would read as
    // an instant success.
    expect(run.durationMs).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.recipient).toBeNull();
    expect(run.startedAt).toBeInstanceOf(Date);
  });

  it('rejects a status outside the enum', async () => {
    await expect(AutomationRun.create({ ...base, status: 'nearly' })).rejects.toThrow(/status/);
  });

  it('rejects a trigger outside the enum', async () => {
    await expect(AutomationRun.create({ ...base, trigger: 'cron' })).rejects.toThrow(/trigger/);
  });

  it('requires the fields every query filters on', async () => {
    for (const field of ['workspaceId', 'boardId', 'kind', 'periodKey', 'jobId']) {
      const missing = { ...base };
      delete missing[field];
      await expect(AutomationRun.create(missing)).rejects.toThrow(new RegExp(field));
    }
  });

  it('refuses a second row for the same jobId', async () => {
    await AutomationRun.create(base);
    await AutomationRun.init(); // ensure the unique index is built before asserting on it
    await expect(AutomationRun.create(base)).rejects.toThrow(/E11000|duplicate/i);
  });

  it('carries a skip reason', async () => {
    const run = await AutomationRun.create({
      ...base,
      status: RUN_SKIPPED,
      skipReason: SKIP_DELIVERY_NOT_IMPLEMENTED,
    });
    expect(run.skipReason).toBe(SKIP_DELIVERY_NOT_IMPLEMENTED);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Backend && npx vitest run test/unit/models/automationRun.test.js`
Expected: FAIL with `Cannot find module '../../../src/models/AutomationRun.js'`

- [ ] **Step 3: Write the constants**

```js
// Backend/src/constants/systemHealth.js
/**
 * Every fixed value the Visibility & Monitoring feature depends on.
 *
 * Each entry records its touchpoints — the modules that read it — so changing
 * one here tells you what it reaches without a grep. Keep those lists current:
 * a stale touchpoint comment is worse than none, because it will be believed.
 *
 * This file imports nothing, deliberately, so a model and a service can both
 * read it without risking a cycle.
 */

// ── Run lifecycle ───────────────────────────────────────────────────────────

/**
 * The states one automation run passes through.
 *
 * RUN_RUNNING is unused until Epic 5.6/5.7: the worker is inert and goes
 * queued -> skipped in one step, because it does no work to be in the middle
 * of. It exists now so the real worker can mark a long generation in flight
 * without the enum changing shape later.
 *
 * Touchpoints: models/AutomationRun.js (enum), services/automation/runs.js
 * (transitions), utils/automationRunMetrics.js (counts), routes/systemHealth.js
 * (retry eligibility).
 */
export const RUN_QUEUED = 'queued';
export const RUN_RUNNING = 'running';
export const RUN_SUCCEEDED = 'succeeded';
export const RUN_FAILED = 'failed';
export const RUN_SKIPPED = 'skipped';

/** Read-only by convention — nothing freezes it. */
export const RUN_STATUSES = [RUN_QUEUED, RUN_RUNNING, RUN_SUCCEEDED, RUN_FAILED, RUN_SKIPPED];

/**
 * Why a run was skipped. One value today.
 *
 * Touchpoints: workers/automationWorker.js (writes it),
 * lib/system-health-helpers.ts (renders it as "Pending setup").
 */
export const SKIP_DELIVERY_NOT_IMPLEMENTED = 'delivery_not_implemented';

/**
 * What caused a run. Manual runs are distinguished so a forced re-run does not
 * read as a duplicate bug in the history it exists to help debug.
 *
 * Touchpoints: models/AutomationRun.js (enum), services/scheduler/handlers.js
 * (schedule), routes/systemHealth.js (manual).
 */
export const TRIGGER_SCHEDULE = 'schedule';
export const TRIGGER_MANUAL = 'manual';

/** Read-only by convention. */
export const RUN_TRIGGERS = [TRIGGER_SCHEDULE, TRIGGER_MANUAL];

// ── Metrics ─────────────────────────────────────────────────────────────────

/**
 * The window the headline error rate is computed over, and how many buckets
 * the sparkline splits it into. 24 hours over 12 buckets is two hours each —
 * coarse enough that one failure does not spike the whole chart, fine enough
 * that a burst is visible.
 *
 * Touchpoints: utils/automationRunMetrics.js, routes/systemHealth.js.
 */
export const ERROR_RATE_WINDOW_HOURS = 24;
export const TREND_BUCKETS = 12;

/**
 * Rows per page in the drill-down history. The spec requires the history be
 * uncapped, so this paginates rather than truncates — the response carries a
 * total and the UI pages through it.
 *
 * Touchpoints: routes/systemHealth.js, lib/use-system-health.ts.
 */
export const HISTORY_PAGE_SIZE = 50;

/**
 * Queue depth at or above which the overview flags a backlog. Not an alert —
 * no alerting infrastructure ships this round — just the threshold the tile
 * turns amber at.
 *
 * Touchpoints: routes/systemHealth.js, lib/system-health-helpers.ts.
 */
export const QUEUE_DEPTH_WARN = 50;

/**
 * How many runs the client-facing panel shows. The admin drill-down is
 * deliberately not capped this way.
 *
 * Touchpoints: routes/automation.js.
 */
export const CLIENT_PANEL_RUN_LIMIT = 10;
```

- [ ] **Step 4: Write the model**

```js
// Backend/src/models/AutomationRun.js
import mongoose from 'mongoose';

import {
  RUN_QUEUED,
  RUN_STATUSES,
  RUN_TRIGGERS,
  TRIGGER_SCHEDULE,
} from '../constants/systemHealth.js';

/**
 * One automation run, per board per slot.
 *
 * Written at fan-out and closed by the worker. Keyed on `jobId`, which is the
 * same string BullMQ dedupes on (`inv:<boardId>:<periodKey>`), so a retried
 * at-least-once dispatch updates the row it already created instead of adding
 * a second one — and so "retry this run" names exactly one queue job.
 *
 * finishedAt/durationMs/recipient stay null until a run actually terminates.
 * A skipped run leaves all three null: nothing ran, and nobody was written to.
 */
const automationRunSchema = new mongoose.Schema(
  {
    workspaceId: { type: String, required: true },
    boardId: { type: String, required: true },
    kind: { type: String, required: true },
    periodKey: { type: String, required: true },
    jobId: { type: String, required: true },

    status: { type: String, required: true, enum: RUN_STATUSES, default: RUN_QUEUED },
    skipReason: { type: String, default: null },
    trigger: { type: String, required: true, enum: RUN_TRIGGERS, default: TRIGGER_SCHEDULE },

    startedAt: { type: Date, required: true, default: () => new Date() },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },

    recipient: { type: String, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

// The drill-down and client panel both read one workspace newest-first.
automationRunSchema.index({ workspaceId: 1, startedAt: -1 });
// The overview counts by outcome within a time window.
automationRunSchema.index({ status: 1, startedAt: -1 });
// The idempotency join. Unique, so a double fan-out cannot record twice.
automationRunSchema.index({ jobId: 1 }, { unique: true });

export default mongoose.model('AutomationRun', automationRunSchema);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd Backend && npx vitest run test/unit/models/automationRun.test.js`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add Backend/src/constants/systemHealth.js Backend/src/models/AutomationRun.js Backend/test/unit/models/automationRun.test.js
git commit -m "feat: AutomationRun model and system-health constants"
```

---

### Task 2: The runs service — create and close rows

**Files:**
- Create: `Backend/src/services/automation/runs.js`
- Test: `Backend/test/unit/services/automation.runs.test.js`

**Interfaces:**
- Consumes: `AutomationRun` (Task 1), the status/trigger constants (Task 1).
- Produces:
  - `recordQueuedRuns({ specs, trigger })` → `Promise<number>` (rows upserted). `specs` is the array `buildFanOutSpecs` returns: `[{ name, data: { kind, workspaceId, boardId, periodKey }, opts: { jobId } }]`.
  - `markRunSkipped({ jobId, skipReason })` → `Promise<void>`
  - `markRunSucceeded({ jobId, recipient })` → `Promise<void>`
  - `markRunFailed({ jobId, error })` → `Promise<void>`

- [ ] **Step 1: Write the failing test**

```js
// Backend/test/unit/services/automation.runs.test.js
import { describe, it, expect, beforeEach } from 'vitest';

import AutomationRun from '../../../src/models/AutomationRun.js';
import {
  recordQueuedRuns,
  markRunSkipped,
  markRunSucceeded,
  markRunFailed,
} from '../../../src/services/automation/runs.js';
import {
  RUN_QUEUED,
  RUN_SKIPPED,
  RUN_SUCCEEDED,
  RUN_FAILED,
  TRIGGER_SCHEDULE,
  TRIGGER_MANUAL,
  SKIP_DELIVERY_NOT_IMPLEMENTED,
} from '../../../src/constants/systemHealth.js';

const spec = (boardId) => ({
  name: 'invoice_automation',
  data: {
    kind: 'invoice_automation',
    workspaceId: 'ws-1',
    boardId,
    periodKey: '20260116-0900',
  },
  opts: { jobId: `inv:${boardId}:20260116-0900` },
});

describe('recordQueuedRuns', () => {
  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await AutomationRun.init();
  });

  it('writes one queued row per spec', async () => {
    const written = await recordQueuedRuns({
      specs: [spec('board-a'), spec('board-b')],
      trigger: TRIGGER_SCHEDULE,
    });

    expect(written).toBe(2);
    const rows = await AutomationRun.find({}).sort({ boardId: 1 }).lean();
    expect(rows.map((r) => r.boardId)).toEqual(['board-a', 'board-b']);
    expect(rows[0].status).toBe(RUN_QUEUED);
    expect(rows[0].jobId).toBe('inv:board-a:20260116-0900');
  });

  it('is idempotent: a redispatch of the same slot does not duplicate rows', async () => {
    await recordQueuedRuns({ specs: [spec('board-a')], trigger: TRIGGER_SCHEDULE });
    await recordQueuedRuns({ specs: [spec('board-a')], trigger: TRIGGER_SCHEDULE });

    expect(await AutomationRun.countDocuments({})).toBe(1);
  });

  it('does not resurrect a finished run when the same slot is redispatched', async () => {
    await recordQueuedRuns({ specs: [spec('board-a')], trigger: TRIGGER_SCHEDULE });
    await markRunSucceeded({ jobId: 'inv:board-a:20260116-0900', recipient: 'a@b.com' });

    await recordQueuedRuns({ specs: [spec('board-a')], trigger: TRIGGER_SCHEDULE });

    const row = await AutomationRun.findOne({}).lean();
    expect(row.status).toBe(RUN_SUCCEEDED);
    expect(row.recipient).toBe('a@b.com');
  });

  it('records the trigger it was given', async () => {
    await recordQueuedRuns({ specs: [spec('board-a')], trigger: TRIGGER_MANUAL });
    const row = await AutomationRun.findOne({}).lean();
    expect(row.trigger).toBe(TRIGGER_MANUAL);
  });

  it('writes nothing, and does not throw, for an empty fan-out', async () => {
    expect(await recordQueuedRuns({ specs: [], trigger: TRIGGER_SCHEDULE })).toBe(0);
    expect(await AutomationRun.countDocuments({})).toBe(0);
  });
});

describe('closing a run', () => {
  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await recordQueuedRuns({ specs: [spec('board-a')], trigger: TRIGGER_SCHEDULE });
  });

  const jobId = 'inv:board-a:20260116-0900';

  it('marks skipped with a reason and no duration', async () => {
    await markRunSkipped({ jobId, skipReason: SKIP_DELIVERY_NOT_IMPLEMENTED });

    const row = await AutomationRun.findOne({ jobId }).lean();
    expect(row.status).toBe(RUN_SKIPPED);
    expect(row.skipReason).toBe(SKIP_DELIVERY_NOT_IMPLEMENTED);
    expect(row.finishedAt).toBeInstanceOf(Date);
    // Nothing ran, so there is no duration to report.
    expect(row.durationMs).toBeNull();
  });

  it('marks succeeded with a recipient and a measured duration', async () => {
    await markRunSucceeded({ jobId, recipient: 'billing@client.com' });

    const row = await AutomationRun.findOne({ jobId }).lean();
    expect(row.status).toBe(RUN_SUCCEEDED);
    expect(row.recipient).toBe('billing@client.com');
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.error).toBeNull();
  });

  it('marks failed with the error text', async () => {
    await markRunFailed({ jobId, error: 'Xero rejected the invoice' });

    const row = await AutomationRun.findOne({ jobId }).lean();
    expect(row.status).toBe(RUN_FAILED);
    expect(row.error).toBe('Xero rejected the invoice');
  });

  it('ignores a jobId that has no row rather than throwing', async () => {
    await expect(markRunSucceeded({ jobId: 'inv:ghost:1', recipient: null })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Backend && npx vitest run test/unit/services/automation.runs.test.js`
Expected: FAIL with `Cannot find module '.../services/automation/runs.js'`

- [ ] **Step 3: Write the implementation**

```js
// Backend/src/services/automation/runs.js
import AutomationRun from '../../models/AutomationRun.js';
import {
  RUN_QUEUED,
  RUN_RUNNING,
  RUN_SKIPPED,
  RUN_SUCCEEDED,
  RUN_FAILED,
  TRIGGER_SCHEDULE,
} from '../../constants/systemHealth.js';

/**
 * One queued row per fan-out spec.
 *
 * `$setOnInsert` only, deliberately: a redispatch of the same slot must not
 * reopen a run that already finished. The jobId is the same key BullMQ dedupes
 * on, so the second dispatch enqueues nothing — recording it as freshly queued
 * would contradict the queue.
 *
 * `ordered: false` so one duplicate does not abandon the rest of the batch.
 * Returns the number of rows actually inserted, which is what the caller logs.
 */
export async function recordQueuedRuns({ specs, trigger = TRIGGER_SCHEDULE }) {
  if (!specs?.length) return 0;

  const operations = specs.map(({ data, opts }) => ({
    updateOne: {
      filter: { jobId: opts.jobId },
      update: {
        $setOnInsert: {
          jobId: opts.jobId,
          workspaceId: data.workspaceId,
          boardId: data.boardId,
          kind: data.kind,
          periodKey: data.periodKey,
          status: RUN_QUEUED,
          trigger,
          startedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  const result = await AutomationRun.bulkWrite(operations, { ordered: false });
  return result.upsertedCount ?? 0;
}

/**
 * Close a run.
 *
 * Guarded on the row not already being terminal, so a late duplicate delivery
 * cannot overwrite the outcome that was recorded first. A jobId with no row is
 * a no-op rather than an error: the worker must not fail a job because its
 * bookkeeping row was pruned or never written.
 */
async function closeRun(jobId, fields) {
  const run = await AutomationRun.findOne({ jobId }).lean();
  if (!run) return;

  const finishedAt = new Date();
  await AutomationRun.updateOne(
    { jobId, status: { $in: [RUN_QUEUED, RUN_RUNNING] } },
    {
      $set: {
        finishedAt,
        durationMs: fields.measureDuration
          ? finishedAt.getTime() - new Date(run.startedAt).getTime()
          : null,
        ...fields.set,
      },
    },
  );
}

export function markRunSkipped({ jobId, skipReason }) {
  // No duration: nothing ran, and "0ms" would read as an instant success.
  return closeRun(jobId, { measureDuration: false, set: { status: RUN_SKIPPED, skipReason } });
}

export function markRunSucceeded({ jobId, recipient = null }) {
  return closeRun(jobId, {
    measureDuration: true,
    set: { status: RUN_SUCCEEDED, recipient, error: null },
  });
}

export function markRunFailed({ jobId, error }) {
  return closeRun(jobId, {
    measureDuration: true,
    set: { status: RUN_FAILED, error: String(error ?? 'unknown error') },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Backend && npx vitest run test/unit/services/automation.runs.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add Backend/src/services/automation/runs.js Backend/test/unit/services/automation.runs.test.js
git commit -m "feat: record and close automation runs"
```

---

### Task 3: Write runs at fan-out, close them in the worker

**Files:**
- Modify: `Backend/src/services/scheduler/handlers.js` (in `runAutomationKind`, after `addBulk`)
- Modify: `Backend/src/workers/automationWorker.js`
- Modify: `Backend/test/unit/workers/automationWorker.test.js` (the inert-contract assertion changes meaning — read Step 3 before editing)
- Modify: `Backend/test/integration/automation.pipeline.route.test.js`

**Interfaces:**
- Consumes: `recordQueuedRuns`, `markRunSkipped` (Task 2); `SKIP_DELIVERY_NOT_IMPLEMENTED`, `TRIGGER_SCHEDULE` (Task 1).
- Produces: no new exports. After this task, ticking a due schedule leaves one `AutomationRun` per board in terminal state `skipped`.

- [ ] **Step 1: Write the failing integration test**

Append to `Backend/test/integration/automation.pipeline.route.test.js`, inside the existing `describe('automation pipeline: settings → tick → queue')`:

```js
  it('records one AutomationRun per board when a schedule fans out', async () => {
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });
    await makeDue(KIND_INVOICE);

    await tick();

    const runs = await AutomationRun.find({ workspaceId: WS }).sort({ boardId: 1 }).lean();
    expect(runs).toHaveLength(BOARDS.length);
    expect(runs.map((r) => r.boardId)).toEqual([...BOARDS].sort());
    for (const run of runs) {
      expect(run.periodKey).toBe(DUE_PERIOD_KEY);
      expect(run.jobId).toBe(`inv:${run.boardId}:${DUE_PERIOD_KEY}`);
      expect(run.trigger).toBe(TRIGGER_SCHEDULE);
    }
  });

  it('does not duplicate runs when the same slot is dispatched twice', async () => {
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });

    await makeDue(KIND_INVOICE);
    await tick();
    await makeDue(KIND_INVOICE);
    await tick();

    // Same guarantee the jobId gives BullMQ, now visible in the run history:
    // a crash-and-retry must not read as two billing runs.
    expect(await AutomationRun.countDocuments({ workspaceId: WS })).toBe(BOARDS.length);
  });
```

Add the imports at the top of that file:

```js
import AutomationRun from '../../src/models/AutomationRun.js';
import { TRIGGER_SCHEDULE } from '../../src/constants/systemHealth.js';
```

And add `await AutomationRun.deleteMany({});` to that file's existing `beforeEach`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Backend && npx vitest run test/integration/automation.pipeline.route.test.js`
Expected: FAIL — `expected [] to have a length of 3 but got +0`

- [ ] **Step 3: Update the worker's inert-contract test**

`Backend/test/unit/workers/automationWorker.test.js` currently asserts the worker enqueues nothing, as a proxy for "does no work". That assertion stays true and stays. What changes is that the worker now also writes bookkeeping, which is not generation or delivery — so add a test rather than relaxing the existing one.

Replace the `is inert` test body with:

```js
  it('is inert: generates nothing and sends nothing', async () => {
    startAutomationWorker();
    await registeredHandler()(JOB);

    // Still the worker's documented contract while Epic 5 parts 3-4 are
    // unbuilt: it drains the queue and does no work of its own. Recording that
    // it declined to work is bookkeeping, not work — see the skipped-run test
    // below, which is the assertion that must change when delivery lands.
    expect(globalThis.__BULLMQ_BULK_JOBS__ ?? []).toHaveLength(0);
  });

  it('closes the run as skipped, naming delivery as the reason', async () => {
    await AutomationRun.create({
      workspaceId: 'ws-1',
      boardId: 'board-a',
      kind: 'invoice_automation',
      periodKey: '20260116-0900',
      jobId: 'inv:board-a:20260116-0900',
    });

    startAutomationWorker();
    await registeredHandler()(JOB);

    const run = await AutomationRun.findOne({ jobId: 'inv:board-a:20260116-0900' }).lean();
    expect(run.status).toBe(RUN_SKIPPED);
    expect(run.skipReason).toBe(SKIP_DELIVERY_NOT_IMPLEMENTED);
    expect(run.durationMs).toBeNull();
  });
```

Add to that file's imports:

```js
import AutomationRun from '../../../src/models/AutomationRun.js';
import { RUN_SKIPPED, SKIP_DELIVERY_NOT_IMPLEMENTED } from '../../../src/constants/systemHealth.js';
```

and give `JOB.data.jobId` a value by changing the fixture to:

```js
const JOB = {
  id: 'inv:board-a:20260116-0900',
  data: {
    kind: 'invoice_automation',
    workspaceId: 'ws-1',
    boardId: 'board-a',
    periodKey: '20260116-0900',
  },
};
```

- [ ] **Step 4: Write the fan-out side**

In `Backend/src/services/scheduler/handlers.js`, inside `runAutomationKind`, replace:

```js
  await getAutomationQueue().addBulk(specs);

  info('Automation', 'Enqueued automation jobs', { kind, targetId, count: specs.length });
```

with:

```js
  await getAutomationQueue().addBulk(specs);

  // After the enqueue, not before: a run recorded for a job that never reached
  // the queue would show as a permanently queued run nothing will ever close.
  // recordQueuedRuns is keyed on the same jobId BullMQ dedupes on, so a
  // redispatch of this slot updates nothing rather than duplicating.
  const recorded = await recordQueuedRuns({ specs, trigger: TRIGGER_SCHEDULE });

  info('Automation', 'Enqueued automation jobs', {
    kind,
    targetId,
    count: specs.length,
    runsRecorded: recorded,
  });
```

and add the imports:

```js
import { recordQueuedRuns } from '../automation/runs.js';
import { TRIGGER_SCHEDULE } from '../../constants/systemHealth.js';
```

- [ ] **Step 5: Write the worker side**

Replace the body of the handler in `Backend/src/workers/automationWorker.js`:

```js
import { Worker } from 'bullmq';

import { AUTOMATION_QUEUE_NAME } from '../services/automation/queue.js';
import { buildRedisConnection } from '../services/redisConnection.js';
import { markRunSkipped } from '../services/automation/runs.js';
import { SKIP_DELIVERY_NOT_IMPLEMENTED } from '../constants/systemHealth.js';
import { info } from '../utils/logger.js';

/**
 * INTENTIONALLY INERT. This worker generates nothing and sends nothing.
 *
 * It exists so enqueued jobs are drained and completed rather than
 * accumulating in the queue and triggering BullMQ retry/backoff against a
 * consumer that was never meant to act on them. PDF generation and SES
 * delivery are Epic 5 parts 3-4 and replace the body of this handler.
 *
 * It does now close the run record, as `skipped`. That is bookkeeping, not
 * work: a run left `queued` forever would show on the System Health screen as
 * a growing backlog, when the truth is an unbuilt feature. When delivery
 * lands, this call becomes markRunSucceeded/markRunFailed and every screen
 * starts reporting real outcomes with no further change.
 *
 * The queue name is imported rather than written out: it already carries the
 * Redis Cluster hash tag ('{automation}'), and a Worker listening on the wrong
 * name silently processes nothing while the queue grows.
 */
export function startAutomationWorker() {
  return new Worker(
    AUTOMATION_QUEUE_NAME,
    async (job) => {
      await markRunSkipped({
        jobId: job.id,
        skipReason: SKIP_DELIVERY_NOT_IMPLEMENTED,
      });

      info('Automation', 'Received automation job (stub — nothing generated or sent)', {
        kind: job.data.kind,
        workspaceId: job.data.workspaceId,
        boardId: job.data.boardId,
        periodKey: job.data.periodKey,
      });
    },
    { connection: buildRedisConnection() },
  );
}
```

- [ ] **Step 6: Run the tests**

Run: `cd Backend && npx vitest run test/unit/workers/automationWorker.test.js test/integration/automation.pipeline.route.test.js test/unit/services/automation.handler.test.js`
Expected: PASS. If `automation.handler.test.js` fails, it is because it mocks `services/automation/queue.js` but not the new `runs.js` import — it should not need a mock, since `test/setup.js` provides a real in-memory Mongo. Read the failure before changing anything.

- [ ] **Step 7: Commit**

```bash
git add Backend/src/services/scheduler/handlers.js Backend/src/workers/automationWorker.js Backend/test/unit/workers/automationWorker.test.js Backend/test/integration/automation.pipeline.route.test.js
git commit -m "feat: record a run per board at fan-out and close it in the worker"
```

---

### Task 4: `automationRunMetrics` — counts, error rate, trend

**Files:**
- Create: `Backend/src/utils/automationRunMetrics.js`
- Test: `Backend/test/unit/utils/automationRunMetrics.test.js`

**Interfaces:**
- Consumes: `RUN_SUCCEEDED`, `RUN_FAILED`, `ERROR_RATE_WINDOW_HOURS`, `TREND_BUCKETS` (Task 1).
- Produces: `summariseRuns(rows, now)` → `{ runsToday, runsThisWeek, succeeded, failed, errorRate24h, trend }` where `trend` is an array of `TREND_BUCKETS` integers (failed count per bucket, oldest first) and `errorRate24h` is a number 0–1 rounded to three decimals.

Pure: takes rows and a clock, returns a value. No database access — the route does the query.

- [ ] **Step 1: Write the failing test**

```js
// Backend/test/unit/utils/automationRunMetrics.test.js
import { describe, it, expect } from 'vitest';

import { summariseRuns } from '../../../src/utils/automationRunMetrics.js';
import { TREND_BUCKETS } from '../../../src/constants/systemHealth.js';
import {
  RUN_SUCCEEDED,
  RUN_FAILED,
  RUN_SKIPPED,
} from '../../../src/constants/systemHealth.js';

const NOW = new Date('2026-08-13T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const run = (status, startedAt) => ({ status, startedAt });

describe('summariseRuns', () => {
  it('returns zeroes for an empty history rather than NaN', () => {
    const out = summariseRuns([], NOW);

    expect(out.runsToday).toBe(0);
    expect(out.succeeded).toBe(0);
    expect(out.failed).toBe(0);
    // 0/0 is the case that produces NaN and renders as "NaN%".
    expect(out.errorRate24h).toBe(0);
    expect(out.trend).toHaveLength(TREND_BUCKETS);
    expect(out.trend.every((n) => n === 0)).toBe(true);
  });

  it('counts today and this week separately', () => {
    const out = summariseRuns(
      [
        run(RUN_SUCCEEDED, hoursAgo(1)),
        run(RUN_SUCCEEDED, hoursAgo(5)),
        run(RUN_SUCCEEDED, hoursAgo(30)), // yesterday, still this week
        run(RUN_SUCCEEDED, hoursAgo(24 * 9)), // last week
      ],
      NOW,
    );

    expect(out.runsToday).toBe(2);
    expect(out.runsThisWeek).toBe(3);
  });

  it('splits success from failure', () => {
    const out = summariseRuns(
      [run(RUN_SUCCEEDED, hoursAgo(1)), run(RUN_FAILED, hoursAgo(2)), run(RUN_FAILED, hoursAgo(3))],
      NOW,
    );

    expect(out.succeeded).toBe(1);
    expect(out.failed).toBe(2);
  });

  it('computes the error rate over the 24h window only', () => {
    const out = summariseRuns(
      [
        run(RUN_FAILED, hoursAgo(1)),
        run(RUN_SUCCEEDED, hoursAgo(2)),
        run(RUN_SUCCEEDED, hoursAgo(3)),
        run(RUN_FAILED, hoursAgo(48)), // outside the window, must not count
      ],
      NOW,
    );

    expect(out.errorRate24h).toBe(0.333);
  });

  it('excludes skipped runs from the error rate, which is about failures', () => {
    // Every run is skipped while delivery is unbuilt. Counting those as errors
    // would show a 100% error rate on a system that is merely not finished.
    const out = summariseRuns(
      [run(RUN_SKIPPED, hoursAgo(1)), run(RUN_SKIPPED, hoursAgo(2))],
      NOW,
    );

    expect(out.errorRate24h).toBe(0);
    expect(out.failed).toBe(0);
  });

  it('buckets failures oldest-first across the window', () => {
    // 24h over 12 buckets = 2h each. A failure 1h ago lands in the last bucket.
    const out = summariseRuns([run(RUN_FAILED, hoursAgo(1))], NOW);

    expect(out.trend).toHaveLength(TREND_BUCKETS);
    expect(out.trend.at(-1)).toBe(1);
    expect(out.trend.slice(0, -1).every((n) => n === 0)).toBe(true);
  });

  it('ignores a run older than the window when bucketing', () => {
    const out = summariseRuns([run(RUN_FAILED, hoursAgo(100))], NOW);
    expect(out.trend.every((n) => n === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Backend && npx vitest run test/unit/utils/automationRunMetrics.test.js`
Expected: FAIL with `Cannot find module '.../utils/automationRunMetrics.js'`

- [ ] **Step 3: Write the implementation**

```js
// Backend/src/utils/automationRunMetrics.js
import {
  RUN_SUCCEEDED,
  RUN_FAILED,
  ERROR_RATE_WINDOW_HOURS,
  TREND_BUCKETS,
} from '../constants/systemHealth.js';

const HOUR_MS = 60 * 60 * 1000;

/** Rows started at or after `from`. */
function since(rows, from) {
  return rows.filter((row) => new Date(row.startedAt).getTime() >= from);
}

/**
 * Failures per bucket across the error-rate window, oldest first.
 *
 * Bucketed by elapsed time rather than by clock hour, so the last bucket
 * always ends at `now` and the sparkline's right edge is the present.
 */
function failureTrend(windowRows, now, windowMs) {
  const buckets = new Array(TREND_BUCKETS).fill(0);
  const bucketMs = windowMs / TREND_BUCKETS;

  for (const row of windowRows) {
    if (row.status !== RUN_FAILED) continue;
    const age = now - new Date(row.startedAt).getTime();
    // Clamp: a row exactly at the window edge would otherwise index -1.
    const index = Math.min(TREND_BUCKETS - 1, Math.max(0, TREND_BUCKETS - 1 - Math.floor(age / bucketMs)));
    buckets[index] += 1;
  }

  return buckets;
}

/**
 * Headline figures for the System Health overview.
 *
 * Pure — the caller does the query and passes the rows in, which is what makes
 * every branch here testable without a database.
 *
 * The error rate counts failed against succeeded+failed, deliberately
 * excluding skipped. While delivery is unbuilt every run is skipped, and
 * counting those as errors would report a 100% error rate for a system that is
 * simply not finished yet.
 */
export function summariseRuns(rows, now = new Date()) {
  const nowMs = now.getTime();
  const windowMs = ERROR_RATE_WINDOW_HOURS * HOUR_MS;

  const todayRows = since(rows, nowMs - 24 * HOUR_MS);
  const weekRows = since(rows, nowMs - 7 * 24 * HOUR_MS);
  const windowRows = since(rows, nowMs - windowMs);

  const succeeded = windowRows.filter((r) => r.status === RUN_SUCCEEDED).length;
  const failed = windowRows.filter((r) => r.status === RUN_FAILED).length;
  const decided = succeeded + failed;

  return {
    runsToday: todayRows.length,
    runsThisWeek: weekRows.length,
    succeeded,
    failed,
    // Guarded: 0/0 is NaN, which renders as "NaN%" on the tile.
    errorRate24h: decided === 0 ? 0 : Math.round((failed / decided) * 1000) / 1000,
    trend: failureTrend(windowRows, nowMs, windowMs),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Backend && npx vitest run test/unit/utils/automationRunMetrics.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add Backend/src/utils/automationRunMetrics.js Backend/test/unit/utils/automationRunMetrics.test.js
git commit -m "feat: summarise automation runs into counts, error rate and trend"
```

---

### Task 5: `automationConnectionStatus` — Xero connection per client

**Files:**
- Create: `Backend/src/utils/automationConnectionStatus.js`
- Test: `Backend/test/unit/utils/automationConnectionStatus.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `CONNECTED`, `DISCONNECTED`, `NEEDS_REAUTH`, and `xeroConnectionStatus(business, now)` → one of those three strings.

This implements spec decision 6. Read it before writing the code — the absent-field case is the whole point.

- [ ] **Step 1: Write the failing test**

```js
// Backend/test/unit/utils/automationConnectionStatus.test.js
import { describe, it, expect } from 'vitest';

import {
  xeroConnectionStatus,
  CONNECTED,
  DISCONNECTED,
  NEEDS_REAUTH,
} from '../../../src/utils/automationConnectionStatus.js';

const NOW = new Date('2026-08-13T00:00:00Z');
const daysFromNow = (d) => NOW.getTime() + d * 24 * 60 * 60 * 1000;

describe('xeroConnectionStatus', () => {
  it('reports disconnected when the integration was never enabled', () => {
    expect(xeroConnectionStatus({ xeroIntegrated: false }, NOW)).toBe(DISCONNECTED);
  });

  it('reports disconnected for a missing business', () => {
    expect(xeroConnectionStatus(null, NOW)).toBe(DISCONNECTED);
    expect(xeroConnectionStatus(undefined, NOW)).toBe(DISCONNECTED);
  });

  it('reports connected when the refresh token is still valid', () => {
    const business = {
      xeroIntegrated: true,
      xeroTokens: { refreshTokenExpiresAt: daysFromNow(30) },
    };
    expect(xeroConnectionStatus(business, NOW)).toBe(CONNECTED);
  });

  it('reports needs_reauth once the refresh token has expired', () => {
    const business = {
      xeroIntegrated: true,
      xeroTokens: { refreshTokenExpiresAt: daysFromNow(-1) },
    };
    expect(xeroConnectionStatus(business, NOW)).toBe(NEEDS_REAUTH);
  });

  it('reports connected when integrated but no expiry was ever stored', () => {
    // `npm run schema` shows xeroTokens.refreshTokenExpiresAt is declared but
    // absent on every existing business. Treating absent as expired would mark
    // the entire client grid as needing re-auth the day this ships, which is
    // the fastest way to make a monitoring screen ignored. Absent means "this
    // document predates the field", not "the token died".
    expect(xeroConnectionStatus({ xeroIntegrated: true }, NOW)).toBe(CONNECTED);
    expect(xeroConnectionStatus({ xeroIntegrated: true, xeroTokens: {} }, NOW)).toBe(CONNECTED);
    expect(
      xeroConnectionStatus({ xeroIntegrated: true, xeroTokens: { refreshTokenExpiresAt: null } }, NOW),
    ).toBe(CONNECTED);
  });

  it('treats an unparseable expiry as absent rather than expired', () => {
    const business = {
      xeroIntegrated: true,
      xeroTokens: { refreshTokenExpiresAt: 'not-a-date' },
    };
    expect(xeroConnectionStatus(business, NOW)).toBe(CONNECTED);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Backend && npx vitest run test/unit/utils/automationConnectionStatus.test.js`
Expected: FAIL with `Cannot find module '.../utils/automationConnectionStatus.js'`

- [ ] **Step 3: Write the implementation**

```js
// Backend/src/utils/automationConnectionStatus.js

/**
 * The three states the System Health connection grid renders, matching the
 * wording in the source spec.
 */
export const CONNECTED = 'connected';
export const DISCONNECTED = 'disconnected';
export const NEEDS_REAUTH = 'needs_reauth';

/**
 * One client's accounting-integration status, derived from its Business row.
 *
 * Xero only: MYOB and QuickBooks are disabled stubs in the Accounting
 * Integrations tab, so there is no state to read for them.
 *
 * A Xero refresh token dies after 60 days idle, which is what makes
 * `refreshTokenExpiresAt` the natural re-auth signal — but `npm run schema`
 * reports it as declared-and-absent on existing businesses. An absent or
 * unparseable value is therefore read as "not recorded", not "expired": a grid
 * that flags every client on day one is a grid nobody reads twice. A backfill
 * would make this exact, and belongs to the epic that owns the field.
 */
export function xeroConnectionStatus(business, now = new Date()) {
  if (!business?.xeroIntegrated) return DISCONNECTED;

  const raw = business.xeroTokens?.refreshTokenExpiresAt;
  if (raw === null || raw === undefined) return CONNECTED;

  const expiresAt = new Date(raw).getTime();
  if (Number.isNaN(expiresAt)) return CONNECTED;

  return expiresAt <= now.getTime() ? NEEDS_REAUTH : CONNECTED;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Backend && npx vitest run test/unit/utils/automationConnectionStatus.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add Backend/src/utils/automationConnectionStatus.js Backend/test/unit/utils/automationConnectionStatus.test.js
git commit -m "feat: derive Xero connection status, tolerating an absent expiry"
```

---

### Task 6: Queue metrics

**Files:**
- Create: `Backend/src/services/automation/queueMetrics.js`
- Test: `Backend/test/unit/services/automation.queueMetrics.test.js`
- Modify: `Backend/test/setup.js` (add `getJobCounts` to the global `QueueMock`)

**Interfaces:**
- Consumes: `getAutomationQueue` from `services/automation/queue.js`; `QUEUE_DEPTH_WARN` (Task 1).
- Produces: `readQueueDepth()` → `Promise<{ waiting, active, failed, delayed, total, backlogged }>`.

- [ ] **Step 1: Extend the global BullMQ mock**

`QueueMock` in `Backend/test/setup.js` has `getWaitingCount`/`getActiveCount`/`getFailedCount` but no `getJobCounts`. Add it beside `addBulk`, returning a shape a test can override:

```js
    getJobCounts() {
      return globalThis.__BULLMQ_JOB_COUNTS__ ?? {
        waiting: 0, active: 0, failed: 0, delayed: 0, completed: 0,
      };
    }
```

and initialise the handle next to the existing `__BULLMQ_BULK_JOBS__` assignment:

```js
globalThis.__BULLMQ_JOB_COUNTS__ = null;
```

then reset it in the existing `afterEach`:

```js
  globalThis.__BULLMQ_JOB_COUNTS__ = null;
```

- [ ] **Step 2: Write the failing test**

```js
// Backend/test/unit/services/automation.queueMetrics.test.js
import { describe, it, expect, afterEach } from 'vitest';

import { readQueueDepth } from '../../../src/services/automation/queueMetrics.js';
import { QUEUE_DEPTH_WARN } from '../../../src/constants/systemHealth.js';

afterEach(() => {
  globalThis.__BULLMQ_JOB_COUNTS__ = null;
});

describe('readQueueDepth', () => {
  it('reports zeroes for an idle queue', async () => {
    expect(await readQueueDepth()).toMatchObject({
      waiting: 0, active: 0, failed: 0, delayed: 0, total: 0, backlogged: false,
    });
  });

  it('totals the states that represent outstanding work', async () => {
    globalThis.__BULLMQ_JOB_COUNTS__ = {
      waiting: 3, active: 2, delayed: 1, failed: 7, completed: 999,
    };

    const depth = await readQueueDepth();

    // completed is not outstanding work, and failed is reported but not
    // counted as depth — a failed job is not waiting for a worker.
    expect(depth.total).toBe(6);
    expect(depth.failed).toBe(7);
  });

  it('flags a backlog at the threshold, not above it', async () => {
    globalThis.__BULLMQ_JOB_COUNTS__ = { waiting: QUEUE_DEPTH_WARN, active: 0, delayed: 0, failed: 0 };
    expect((await readQueueDepth()).backlogged).toBe(true);

    globalThis.__BULLMQ_JOB_COUNTS__ = { waiting: QUEUE_DEPTH_WARN - 1, active: 0, delayed: 0, failed: 0 };
    expect((await readQueueDepth()).backlogged).toBe(false);
  });

  it('reports zeroes rather than throwing when the queue is unreachable', async () => {
    // Redis being down must degrade one tile, not 500 the whole overview.
    globalThis.__BULLMQ_JOB_COUNTS__ = 'explode';
    const depth = await readQueueDepth();
    expect(depth).toMatchObject({ total: 0, available: false });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd Backend && npx vitest run test/unit/services/automation.queueMetrics.test.js`
Expected: FAIL with `Cannot find module '.../services/automation/queueMetrics.js'`

- [ ] **Step 4: Write the implementation**

```js
// Backend/src/services/automation/queueMetrics.js
import { getAutomationQueue } from './queue.js';
import { QUEUE_DEPTH_WARN } from '../../constants/systemHealth.js';
import { warn } from '../../utils/logger.js';

const EMPTY = { waiting: 0, active: 0, delayed: 0, failed: 0 };

/**
 * Outstanding work on the automation queue.
 *
 * `total` counts waiting + active + delayed — the jobs still owed a worker.
 * Failed jobs are reported but excluded from depth: a failed job is not
 * waiting for anything, and folding it in makes a backlog alarm that never
 * clears.
 *
 * Never throws. Redis being unreachable should grey out one tile, not take the
 * whole System Health overview down with it, so the failure is logged and
 * reported as `available: false`.
 */
export async function readQueueDepth() {
  let counts = EMPTY;
  let available = true;

  try {
    const raw = await getAutomationQueue().getJobCounts();
    // Shape-checked, not just spread: a non-object answer (a string, null)
    // spreads to nothing and would otherwise be reported as a genuine zero
    // queue rather than as "could not read it".
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError(`getJobCounts returned ${typeof raw}`);
    }
    counts = { ...EMPTY, ...raw };
  } catch (err) {
    available = false;
    warn('SystemHealth', 'Could not read automation queue depth', { error: err?.message });
  }

  const total = counts.waiting + counts.active + counts.delayed;

  return {
    waiting: counts.waiting,
    active: counts.active,
    delayed: counts.delayed,
    failed: counts.failed,
    total,
    backlogged: total >= QUEUE_DEPTH_WARN,
    available,
  };
}
```

The shape check is what makes the `'explode'` case in the test deterministic. Without it, spreading a string yields no numeric keys, the zeroes survive, and an unreadable queue would be reported as a genuinely empty one — `available: true` on a lie.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd Backend && npx vitest run test/unit/services/automation.queueMetrics.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add Backend/src/services/automation/queueMetrics.js Backend/test/unit/services/automation.queueMetrics.test.js Backend/test/setup.js
git commit -m "feat: read automation queue depth without failing the overview"
```

---

### Task 7: The admin guard and the System Health router — overview and clients

**Files:**
- Create: `Backend/src/middleware/requireOwnerOrSupport.js`
- Create: `Backend/src/routes/systemHealth.js`
- Modify: `Backend/src/app.js` (mount `/api/system-health`)
- Modify: `Backend/src/index.js` (mount `/api/system-health` — parity test enforces this)
- Test: `Backend/test/integration/systemHealth.route.test.js`

**Interfaces:**
- Consumes: `summariseRuns` (Task 4), `xeroConnectionStatus` (Task 5), `readQueueDepth` (Task 6), `AutomationRun` (Task 1), `authenticateToken` from `middleware/auth.js`.
- Produces: `requireOwnerOrSupport` (Express middleware); `GET /api/system-health/overview`, `GET /api/system-health/clients`.

- [ ] **Step 1: Write the failing test**

```js
// Backend/test/integration/systemHealth.route.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import { createApp } from '../../src/app.js';
import AutomationRun from '../../src/models/AutomationRun.js';
import AutomationSettings from '../../src/models/AutomationSettings.js';
import Business from '../../src/models/Business.js';
import SchedulerHealth from '../../src/models/SchedulerHealth.js';
import { authenticatedAgent } from '../helpers/auth.js';
import { RUN_FAILED, RUN_SUCCEEDED } from '../../src/constants/systemHealth.js';

const WS = 'ws-health-1';

describe('GET /api/system-health/overview', () => {
  let app;

  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await AutomationSettings.deleteMany({});
    await Business.deleteMany({});
    await SchedulerHealth.deleteMany({});
    app = createApp();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/system-health/overview');
    expect(res.status).toBe(401);
  });

  it('refuses an isoplus_user, who must not see every client', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    const res = await agent.get('/api/system-health/overview');
    expect(res.status).toBe(403);
  });

  for (const role of ['support_admin', 'owner']) {
    it(`admits ${role}`, async () => {
      const { agent } = await authenticatedAgent(app, { role });
      const res = await agent.get('/api/system-health/overview');
      expect(res.status).toBe(200);
    });
  }

  it('returns a whole overview for an empty system without dividing by zero', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/overview');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      activeAutomations: 0,
      runsToday: 0,
      failed: 0,
      errorRate24h: 0,
    });
    expect(res.body.queue).toMatchObject({ total: 0, backlogged: false });
    expect(Array.isArray(res.body.trend)).toBe(true);
  });

  it('counts a workspace with either block enabled exactly once', async () => {
    await AutomationSettings.create({
      workspaceId: WS,
      invoice: { enabled: true },
      statement: { enabled: true },
    });
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get('/api/system-health/overview');
    expect(res.body.activeAutomations).toBe(1);
  });

  it('reports a null last tick when the scheduler has never run', async () => {
    // The failure every other figure hides: with no ticks, runsToday is
    // legitimately 0 and the error rate is legitimately 0, and the overview
    // looks healthy while nothing is firing at all.
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/overview');

    expect(res.body).toHaveProperty('lastTickAt', null);
  });

  it('reports the last tick once the scheduler has run', async () => {
    const lastTickAt = new Date('2026-08-13T09:00:00.000Z');
    await SchedulerHealth.create({ lastTickAt });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/overview');

    expect(new Date(res.body.lastTickAt).toISOString()).toBe(lastTickAt.toISOString());
  });

  it('summarises recent runs', async () => {
    const base = {
      workspaceId: WS, boardId: 'b1', kind: 'invoice_automation', periodKey: 'p',
    };
    await AutomationRun.create({ ...base, jobId: 'j1', status: RUN_SUCCEEDED });
    await AutomationRun.create({ ...base, jobId: 'j2', status: RUN_FAILED });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/overview');

    expect(res.body.runsToday).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.errorRate24h).toBe(0.5);
  });
});

describe('GET /api/system-health/clients', () => {
  let app;

  beforeEach(async () => {
    await AutomationSettings.deleteMany({});
    await Business.deleteMany({});
    app = createApp();
  });

  it('refuses an isoplus_user', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    expect((await agent.get('/api/system-health/clients')).status).toBe(403);
  });

  it('lists each configured workspace with its connection status', async () => {
    await AutomationSettings.create({ workspaceId: WS, invoice: { enabled: true } });
    await Business.create({ workspaceId: WS, xeroIntegrated: true });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/clients');

    expect(res.status).toBe(200);
    expect(res.body.clients).toHaveLength(1);
    expect(res.body.clients[0]).toMatchObject({
      workspaceId: WS,
      connection: 'connected',
      provider: 'xero',
    });
  });

  it('reports disconnected for a configured workspace with no Business row', async () => {
    await AutomationSettings.create({ workspaceId: 'ws-no-business', invoice: { enabled: true } });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/clients');

    expect(res.body.clients[0].connection).toBe('disconnected');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Backend && npx vitest run test/integration/systemHealth.route.test.js`
Expected: FAIL — every request 404s, because the router does not exist.

- [ ] **Step 3: Write the guard**

```js
// Backend/src/middleware/requireOwnerOrSupport.js
import { warn } from '../utils/logger.js';

/**
 * Admin-only gate for the System Health screens.
 *
 * Mounted after `authenticateToken`, which is what puts `req.user` there. The
 * roles mirror `Frontend/lib/access.ts`'s `isOwnerOrSupport`, so the button and
 * the endpoint agree about who may see every client's data.
 *
 * 403, not 404: the caller is authenticated and the route exists — hiding that
 * would only make a permissions problem look like a deploy problem.
 */
export function requireOwnerOrSupport(req, res, next) {
  const role = req.user?.role;

  if (role === 'owner' || role === 'support_admin') {
    next();
    return;
  }

  warn('SystemHealth', 'Refused a non-admin request', { role, path: req.path }, req);
  res.status(403).json({ message: 'Forbidden' });
}
```

Confirm the property name before writing this: check how `middleware/auth.js` attaches the user (`req.user`, `req.userData`, …) and match it. If it differs, use the real one and say so in the commit message.

- [ ] **Step 4: Write the router**

```js
// Backend/src/routes/systemHealth.js
import express from 'express';

import AutomationRun from '../models/AutomationRun.js';
import AutomationSettings from '../models/AutomationSettings.js';
import Business from '../models/Business.js';
import SchedulerHealth from '../models/SchedulerHealth.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireOwnerOrSupport } from '../middleware/requireOwnerOrSupport.js';
import { summariseRuns } from '../utils/automationRunMetrics.js';
import { xeroConnectionStatus } from '../utils/automationConnectionStatus.js';
import { readQueueDepth } from '../services/automation/queueMetrics.js';
import { ERROR_RATE_WINDOW_HOURS } from '../constants/systemHealth.js';
import { error as logError } from '../utils/logger.js';

const router = express.Router();

router.use(authenticateToken, requireOwnerOrSupport);

/** Workspaces with at least one automation block enabled. */
function enabledWorkspaceFilter() {
  return { $or: [{ 'invoice.enabled': true }, { 'statement.enabled': true }] };
}

router.get('/overview', async (req, res) => {
  try {
    const now = new Date();
    // One week back covers every figure summariseRuns computes, so the route
    // makes a single query rather than one per window.
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [rows, activeAutomations, queue, health] = await Promise.all([
      AutomationRun.find({ startedAt: { $gte: from } }).select('status startedAt').lean(),
      AutomationSettings.countDocuments(enabledWorkspaceFilter()),
      readQueueDepth(),
      SchedulerHealth.findOne({}).select('lastTickAt').lean(),
    ]);

    res.json({
      ...summariseRuns(rows, now),
      activeAutomations,
      queue,
      // A stopped clock is the failure every other figure here hides: with no
      // ticks, runsToday is legitimately 0 and the error rate is legitimately
      // 0, and the screen looks healthy. null means the scheduler has never
      // ticked in this environment, which is usually a missing EventBridge
      // rule — see docs/scheduling.md.
      lastTickAt: health?.lastTickAt ?? null,
      errorRateWindowHours: ERROR_RATE_WINDOW_HOURS,
    });
  } catch (err) {
    logError('SystemHealth', 'Overview failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not load system health' });
  }
});

router.get('/clients', async (req, res) => {
  try {
    const settings = await AutomationSettings.find(enabledWorkspaceFilter())
      .select('workspaceId invoice.enabled statement.enabled')
      .lean();

    const businesses = await Business.find({
      workspaceId: { $in: settings.map((s) => s.workspaceId) },
    })
      .select('workspaceId xeroIntegrated xeroTokens.refreshTokenExpiresAt')
      .lean();

    const byWorkspace = new Map(businesses.map((b) => [b.workspaceId, b]));

    res.json({
      clients: settings.map((s) => ({
        workspaceId: s.workspaceId,
        invoiceEnabled: Boolean(s.invoice?.enabled),
        statementEnabled: Boolean(s.statement?.enabled),
        provider: 'xero',
        connection: xeroConnectionStatus(byWorkspace.get(s.workspaceId)),
      })),
    });
  } catch (err) {
    logError('SystemHealth', 'Client list failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not load clients' });
  }
});

export default router;
```

- [ ] **Step 5: Mount it in BOTH apps**

In `Backend/src/app.js`, beside the other `app.use('/api/...')` lines:

```js
  app.use('/api/system-health', systemHealthRoutes);
```

with `import systemHealthRoutes from './routes/systemHealth.js';` at the top. Then make the identical change in `Backend/src/index.js`. Mounting in only one is the failure `routeMountParity.test.js` exists to catch.

- [ ] **Step 6: Run the tests**

Run: `cd Backend && npx vitest run test/integration/systemHealth.route.test.js test/unit/routeMountParity.test.js`
Expected: PASS (11 + 3 tests)

- [ ] **Step 7: Commit**

```bash
git add Backend/src/middleware/requireOwnerOrSupport.js Backend/src/routes/systemHealth.js Backend/src/app.js Backend/src/index.js Backend/test/integration/systemHealth.route.test.js
git commit -m "feat: System Health overview and client connection grid"
```

---

### Task 8: Per-client drill-down history

**Files:**
- Modify: `Backend/src/routes/systemHealth.js`
- Modify: `Backend/test/integration/systemHealth.route.test.js`

**Interfaces:**
- Consumes: `AutomationRun`, `ScheduledJob`, `HISTORY_PAGE_SIZE` (Task 1).
- Produces: `GET /api/system-health/workspace/:workspaceId?page=<n>` → `{ workspaceId, schedules: [...], runs: [...], total, page, pageSize }`.

- [ ] **Step 1: Write the failing test**

Append to `Backend/test/integration/systemHealth.route.test.js`:

```js
describe('GET /api/system-health/workspace/:workspaceId', () => {
  let app;

  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    app = createApp();
  });

  async function seedRuns(count) {
    for (let i = 0; i < count; i += 1) {
      await AutomationRun.create({
        workspaceId: WS,
        boardId: `b${i}`,
        kind: 'invoice_automation',
        periodKey: `p${i}`,
        jobId: `j${i}`,
        status: RUN_SUCCEEDED,
        startedAt: new Date(Date.UTC(2026, 7, 1, 0, i)),
      });
    }
  }

  it('refuses an isoplus_user', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    expect((await agent.get(`/api/system-health/workspace/${WS}`)).status).toBe(403);
  });

  it('returns newest runs first with a total', async () => {
    await seedRuns(3);
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get(`/api/system-health/workspace/${WS}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.runs.map((r) => r.boardId)).toEqual(['b2', 'b1', 'b0']);
  });

  it('pages rather than truncating, so the history stays uncapped', async () => {
    await seedRuns(HISTORY_PAGE_SIZE + 5);
    const { agent } = await authenticatedAgent(app);

    const first = await agent.get(`/api/system-health/workspace/${WS}`);
    const second = await agent.get(`/api/system-health/workspace/${WS}?page=2`);

    expect(first.body.runs).toHaveLength(HISTORY_PAGE_SIZE);
    expect(second.body.runs).toHaveLength(5);
    expect(first.body.total).toBe(HISTORY_PAGE_SIZE + 5);
    // No overlap between pages.
    const ids = new Set(first.body.runs.map((r) => r.jobId));
    expect(second.body.runs.every((r) => !ids.has(r.jobId))).toBe(true);
  });

  it('does not leak another workspace\'s runs', async () => {
    await seedRuns(2);
    await AutomationRun.create({
      workspaceId: 'someone-else', boardId: 'x', kind: 'invoice_automation',
      periodKey: 'p', jobId: 'other', status: RUN_SUCCEEDED,
    });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get(`/api/system-health/workspace/${WS}`);

    expect(res.body.total).toBe(2);
  });

  it('returns an empty history rather than 404 for an unknown workspace', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/workspace/never-configured');

    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('rejects a non-numeric page instead of returning NaN results', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get(`/api/system-health/workspace/${WS}?page=abc`);
    expect(res.status).toBe(400);
  });
});
```

Add `HISTORY_PAGE_SIZE` to that file's constants import.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Backend && npx vitest run test/integration/systemHealth.route.test.js`
Expected: FAIL — the new describe block 404s.

- [ ] **Step 3: Write the route**

Add to `Backend/src/routes/systemHealth.js`, and add `import ScheduledJob from '../models/ScheduledJob.js';`, `import { mongoEq } from '../utils/securityHelpers.js';` and `HISTORY_PAGE_SIZE` to the constants import:

```js
/**
 * A 1-based page number, or null when the query string is unusable.
 *
 * Rejected rather than defaulted: `Number('abc')` is NaN, and NaN reaching
 * `.skip()` silently returns the first page, so a broken pager would look like
 * a working one.
 */
function parsePage(raw) {
  if (raw === undefined) return 1;
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1) return null;
  return page;
}

router.get('/workspace/:workspaceId', async (req, res) => {
  const page = parsePage(req.query.page);
  if (page === null) {
    res.status(400).json({ message: 'page must be a positive integer' });
    return;
  }

  try {
    const workspaceId = mongoEq(req.params.workspaceId);

    const [runs, total, schedules] = await Promise.all([
      AutomationRun.find({ workspaceId })
        .sort({ startedAt: -1 })
        .skip((page - 1) * HISTORY_PAGE_SIZE)
        .limit(HISTORY_PAGE_SIZE)
        .lean(),
      AutomationRun.countDocuments({ workspaceId }),
      ScheduledJob.find({ targetId: workspaceId })
        .select('kind enabled nextRunAt lastRunAt lastError missedRuns consecutiveFailures timezone')
        .lean(),
    ]);

    res.json({
      workspaceId: req.params.workspaceId,
      schedules,
      runs,
      total,
      page,
      pageSize: HISTORY_PAGE_SIZE,
    });
  } catch (err) {
    logError('SystemHealth', 'Drill-down failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not load client detail' });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Backend && npx vitest run test/integration/systemHealth.route.test.js`
Expected: PASS (17 tests)

- [ ] **Step 5: Commit**

```bash
git add Backend/src/routes/systemHealth.js Backend/test/integration/systemHealth.route.test.js
git commit -m "feat: per-client run history, paged rather than truncated"
```

---

### Task 9: Run now and Retry

**Files:**
- Modify: `Backend/src/routes/systemHealth.js`
- Modify: `Backend/src/services/automation/runs.js` (add `countRunsForPeriod`)
- Modify: `Backend/test/integration/systemHealth.route.test.js`

**Interfaces:**
- Consumes: `runAutomationKind` from `services/scheduler/handlers.js`, `buildFanOutSpecs`/`KIND_INVOICE`/`KIND_STATEMENT` from `services/automation/fanOut.js`, `recordQueuedRuns` (Task 2), `TRIGGER_MANUAL` (Task 1).
- Produces: `POST /api/system-health/workspace/:workspaceId/run`, `POST /api/system-health/workspace/:workspaceId/runs/:runId/retry`; `countRunsForPeriod({ workspaceId, kind, periodKey })` → `Promise<number>`.

Read spec decision 5 before starting. The 409 is the feature, not an error path.

- [ ] **Step 1: Write the failing test**

Append to `Backend/test/integration/systemHealth.route.test.js`:

```js
describe('POST /api/system-health/workspace/:workspaceId/run', () => {
  let app;

  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await AutomationSettings.deleteMany({});
    await Board.deleteMany({});
    await Board.collection.insertMany([{ boardId: 'b1', workspaceId: WS, name: 'b1' }]);
    await AutomationSettings.create({ workspaceId: WS, invoice: { enabled: true } });
    resetRecordedJobs();
    app = createApp();
  });

  it('refuses an isoplus_user', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    const res = await agent.post(`/api/system-health/workspace/${WS}/run`).send({ kind: 'invoice' });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown kind rather than guessing', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.post(`/api/system-health/workspace/${WS}/run`).send({ kind: 'payroll' });
    expect(res.status).toBe(400);
  });

  it('enqueues a manual run and records it as manual', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.post(`/api/system-health/workspace/${WS}/run`).send({ kind: 'invoice' });

    expect(res.status).toBe(202);
    expect(res.body.enqueued).toBe(1);
    const run = await AutomationRun.findOne({ workspaceId: WS }).lean();
    expect(run.trigger).toBe(TRIGGER_MANUAL);
  });

  it('refuses a second run for the same period, and says which', async () => {
    const { agent } = await authenticatedAgent(app);
    await agent.post(`/api/system-health/workspace/${WS}/run`).send({ kind: 'invoice' });

    const res = await agent.post(`/api/system-health/workspace/${WS}/run`).send({ kind: 'invoice' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_run');
    expect(res.body.periodKey).toBeTruthy();
    expect(res.body.runs.length).toBeGreaterThan(0);
  });

  it('runs anyway with ?force=1, under a distinct jobId', async () => {
    const { agent } = await authenticatedAgent(app);
    await agent.post(`/api/system-health/workspace/${WS}/run`).send({ kind: 'invoice' });

    const res = await agent
      .post(`/api/system-health/workspace/${WS}/run?force=1`)
      .send({ kind: 'invoice' });

    expect(res.status).toBe(202);
    const runs = await AutomationRun.find({ workspaceId: WS }).lean();
    expect(runs).toHaveLength(2);
    // The forced run must not collide with the original, or BullMQ drops it.
    expect(new Set(runs.map((r) => r.jobId)).size).toBe(2);
    expect(runs.some((r) => r.jobId.startsWith('manual:'))).toBe(true);
  });

  it('404s a workspace with no enabled block for that kind', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent
      .post(`/api/system-health/workspace/${WS}/run`)
      .send({ kind: 'statement' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/system-health/workspace/:workspaceId/runs/:runId/retry', () => {
  let app;

  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await Board.deleteMany({});
    await Board.collection.insertMany([{ boardId: 'b1', workspaceId: WS, name: 'b1' }]);
    resetRecordedJobs();
    app = createApp();
  });

  async function makeRun(status) {
    return AutomationRun.create({
      workspaceId: WS, boardId: 'b1', kind: 'invoice_automation',
      periodKey: '20260116-0900', jobId: `inv:b1:20260116-0900`, status,
    });
  }

  it('re-enqueues a failed run', async () => {
    const run = await makeRun(RUN_FAILED);
    const { agent } = await authenticatedAgent(app);

    const res = await agent.post(`/api/system-health/workspace/${WS}/runs/${run._id}/retry`);

    expect(res.status).toBe(202);
    expect(recordedJobIds().length).toBe(1);
  });

  it('refuses to retry a run that did not fail', async () => {
    const run = await makeRun(RUN_SUCCEEDED);
    const { agent } = await authenticatedAgent(app);

    const res = await agent.post(`/api/system-health/workspace/${WS}/runs/${run._id}/retry`);

    expect(res.status).toBe(409);
  });

  it('404s an unknown run id', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.post(
      `/api/system-health/workspace/${WS}/runs/64b7f9c2e4b0f5a3d2c1a000/retry`,
    );
    expect(res.status).toBe(404);
  });
});
```

Add these imports to that file:

```js
import Board from '../../src/models/Board.js';
import { TRIGGER_MANUAL, RUN_FAILED } from '../../src/constants/systemHealth.js';
import { recordedJobIds, resetRecordedJobs } from '../helpers/queue.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Backend && npx vitest run test/integration/systemHealth.route.test.js`
Expected: FAIL — the two new describe blocks 404.

- [ ] **Step 3: Add the period counter to the runs service**

```js
// append to Backend/src/services/automation/runs.js
import AutomationRunModel from '../../models/AutomationRun.js';

/** How many runs already exist for one workspace/kind/period. */
export function countRunsForPeriod({ workspaceId, kind, periodKey }) {
  return AutomationRunModel.countDocuments({ workspaceId, kind, periodKey });
}
```

Use the existing `AutomationRun` import in that file rather than adding a second alias — the line above shows the query, not a new import to duplicate.

- [ ] **Step 4: Write the routes**

Add to `Backend/src/routes/systemHealth.js`:

```js
const KIND_FOR_BODY = { invoice: KIND_INVOICE, statement: KIND_STATEMENT };

/**
 * Manual dispatch reuses the scheduled period key, so a stray click cannot
 * bill a period twice. `force` mints a distinct `manual:` jobId instead, which
 * is the only way to deliberately re-run a period — BullMQ would otherwise
 * collapse it into the job already recorded.
 */
function manualSpecs({ specs, force, existing }) {
  if (!force) return specs;
  return specs.map((spec) => ({
    ...spec,
    opts: { jobId: `manual:${spec.data.boardId}:${spec.data.periodKey}:${existing}` },
  }));
}

router.post('/workspace/:workspaceId/run', async (req, res) => {
  const kind = KIND_FOR_BODY[req.body?.kind];
  if (!kind) {
    res.status(400).json({ message: 'kind must be "invoice" or "statement"' });
    return;
  }

  try {
    const workspaceId = mongoEq(req.params.workspaceId);
    const settings = await AutomationSettings.findOne({ workspaceId }).lean();
    const block = kind === KIND_INVOICE ? settings?.invoice : settings?.statement;

    if (!block?.enabled) {
      res.status(404).json({ message: 'No enabled automation for that kind' });
      return;
    }

    const boards = await Board.find({ workspaceId }).select('boardId').lean();

    // The timezone comes from the ScheduledJob, NOT from AutomationSettings —
    // that model has no timezone field, so reading it there would silently
    // fall back to the default for every workspace not on Sydney time. The
    // period key is formatted in this zone, so the wrong one produces a key
    // that does not match the scheduled run's, and the duplicate check below
    // would compare against nothing.
    const schedule = await ScheduledJob.findOne({ kind, targetId: workspaceId })
      .select('timezone')
      .lean();

    const slot = new Date();
    const specs = buildFanOutSpecs({
      kind,
      workspaceId: req.params.workspaceId,
      boards,
      slot,
      timezone: schedule?.timezone ?? DEFAULT_TIMEZONE,
    });

    const periodKey = specs[0]?.data.periodKey ?? null;
    const existing = periodKey
      ? await countRunsForPeriod({ workspaceId: req.params.workspaceId, kind, periodKey })
      : 0;
    const force = req.query.force === '1';

    if (existing > 0 && !force) {
      const runs = await AutomationRun.find({ workspaceId, kind, periodKey }).lean();
      res.status(409).json({ error: 'already_run', periodKey, runs });
      return;
    }

    const toEnqueue = manualSpecs({ specs, force, existing });
    await getAutomationQueue().addBulk(toEnqueue);
    await recordQueuedRuns({ specs: toEnqueue, trigger: TRIGGER_MANUAL });

    res.status(202).json({ enqueued: toEnqueue.length, periodKey });
  } catch (err) {
    logError('SystemHealth', 'Manual run failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not start the run' });
  }
});

router.post('/workspace/:workspaceId/runs/:runId/retry', async (req, res) => {
  try {
    const run = await AutomationRun.findOne({
      _id: mongoEq(req.params.runId),
      workspaceId: mongoEq(req.params.workspaceId),
    }).lean();

    if (!run) {
      res.status(404).json({ message: 'No such run' });
      return;
    }

    // Retrying a success would bill twice; retrying a queued run would race
    // the worker already holding it.
    if (run.status !== RUN_FAILED) {
      res.status(409).json({ error: 'not_failed', status: run.status });
      return;
    }

    await getAutomationQueue().addBulk([
      {
        name: run.kind,
        data: {
          kind: run.kind,
          workspaceId: run.workspaceId,
          boardId: run.boardId,
          periodKey: run.periodKey,
        },
        opts: { jobId: `retry:${run.boardId}:${run.periodKey}:${run._id}` },
      },
    ]);

    res.status(202).json({ retried: String(run._id) });
  } catch (err) {
    logError('SystemHealth', 'Retry failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not retry the run' });
  }
});
```

Add the imports this needs:

```js
import Board from '../models/Board.js';
import { getAutomationQueue } from '../services/automation/queue.js';
import { buildFanOutSpecs, KIND_INVOICE, KIND_STATEMENT } from '../services/automation/fanOut.js';
import { recordQueuedRuns, countRunsForPeriod } from '../services/automation/runs.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';
```

and add `TRIGGER_MANUAL`, `RUN_FAILED` to the `constants/systemHealth.js` import.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd Backend && npx vitest run test/integration/systemHealth.route.test.js`
Expected: PASS (26 tests)

- [ ] **Step 6: Check the file against the complexity gate**

`routes/systemHealth.js` now holds five handlers. If it reads as more than one responsibility, extract the run/retry pair into `utils/systemHealthRunHelpers.js` — the repo splits at exactly this point, which is why `Backend/src/utils/` has 73 `*Helpers.js` files.

- [ ] **Step 7: Commit**

```bash
git add Backend/src/routes/systemHealth.js Backend/src/services/automation/runs.js Backend/test/integration/systemHealth.route.test.js
git commit -m "feat: Run now and Retry, refusing a duplicate period by default"
```

---

### Task 10: The client-facing status endpoint

**Files:**
- Modify: `Backend/src/routes/automation.js`
- Test: `Backend/test/integration/automation.status.route.test.js`

**Interfaces:**
- Consumes: `AutomationRun`, `ScheduledJob`, `CLIENT_PANEL_RUN_LIMIT` (Task 1).
- Produces: `GET /api/automation/:workspaceId/status` → `{ invoice: { enabled, nextRun, lastStatus }, statement: {...}, runs: [...], deliveryEnabled: false }`.

Deliberately a separate endpoint from the admin ones, so client scoping cannot leak the global view and the admin shapes can change without touching a client response.

- [ ] **Step 1: Write the failing test**

```js
// Backend/test/integration/automation.status.route.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import { createApp } from '../../src/app.js';
import AutomationRun from '../../src/models/AutomationRun.js';
import AutomationSettings from '../../src/models/AutomationSettings.js';
import { authenticatedAgent } from '../helpers/auth.js';
import { CLIENT_PANEL_RUN_LIMIT, RUN_SKIPPED } from '../../src/constants/systemHealth.js';

const WS = 'ws-status-1';

describe('GET /api/automation/:workspaceId/status', () => {
  let app;
  let agent;

  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await AutomationSettings.deleteMany({});
    app = createApp();
    ({ agent } = await authenticatedAgent(app));
  });

  it('requires authentication', async () => {
    expect((await request(app).get(`/api/automation/${WS}/status`)).status).toBe(401);
  });

  it('reports delivery as not yet enabled, so the panel can say so', async () => {
    const res = await agent.get(`/api/automation/${WS}/status`);
    expect(res.status).toBe(200);
    expect(res.body.deliveryEnabled).toBe(false);
  });

  it('returns an empty but valid shape for a workspace with no settings', async () => {
    const res = await agent.get(`/api/automation/${WS}/status`);

    expect(res.body.invoice).toMatchObject({ enabled: false, nextRun: null });
    expect(res.body.runs).toEqual([]);
  });

  it(`caps the history at ${CLIENT_PANEL_RUN_LIMIT} runs, newest first`, async () => {
    for (let i = 0; i < CLIENT_PANEL_RUN_LIMIT + 4; i += 1) {
      await AutomationRun.create({
        workspaceId: WS, boardId: `b${i}`, kind: 'invoice_automation',
        periodKey: `p${i}`, jobId: `j${i}`, status: RUN_SKIPPED,
        startedAt: new Date(Date.UTC(2026, 7, 1, 0, i)),
      });
    }

    const res = await agent.get(`/api/automation/${WS}/status`);

    expect(res.body.runs).toHaveLength(CLIENT_PANEL_RUN_LIMIT);
    expect(res.body.runs[0].boardId).toBe(`b${CLIENT_PANEL_RUN_LIMIT + 3}`);
  });

  it('does not return another workspace\'s runs', async () => {
    await AutomationRun.create({
      workspaceId: 'other', boardId: 'x', kind: 'invoice_automation',
      periodKey: 'p', jobId: 'other', status: RUN_SKIPPED,
    });

    const res = await agent.get(`/api/automation/${WS}/status`);
    expect(res.body.runs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Backend && npx vitest run test/integration/automation.status.route.test.js`
Expected: FAIL — 404, or the existing `/:workspaceId/:boardId` route matching `status` as a boardId. If the latter, **declare the status route before that one** — Express matches in order.

- [ ] **Step 3: Write the route**

Add to `Backend/src/routes/automation.js`, **above** the existing `/:workspaceId/:boardId` handlers so `status` is not read as a boardId:

```js
/**
 * The client-facing half of Visibility & Monitoring.
 *
 * Separate from /api/system-health deliberately: that router is admin-only and
 * returns every client, and one shared handler with a role branch is how a
 * scoping bug eventually ships.
 */
router.get('/:workspaceId/status', authenticateToken, async (req, res) => {
  try {
    const workspaceId = mongoEq(req.params.workspaceId);

    const [settings, schedules, runs] = await Promise.all([
      AutomationSettings.findOne({ workspaceId }).lean(),
      ScheduledJob.find({ targetId: workspaceId }).select('kind nextRunAt enabled').lean(),
      AutomationRun.find({ workspaceId })
        .sort({ startedAt: -1 })
        .limit(CLIENT_PANEL_RUN_LIMIT)
        .lean(),
    ]);

    const nextRunFor = (kind) =>
      schedules.find((s) => s.kind === kind && s.enabled)?.nextRunAt ?? null;
    const lastStatusFor = (kind) => runs.find((r) => r.kind === kind)?.status ?? null;

    res.json({
      invoice: {
        enabled: Boolean(settings?.invoice?.enabled),
        nextRun: nextRunFor(KIND_INVOICE),
        lastStatus: lastStatusFor(KIND_INVOICE),
      },
      statement: {
        enabled: Boolean(settings?.statement?.enabled),
        nextRun: nextRunFor(KIND_STATEMENT),
        lastStatus: lastStatusFor(KIND_STATEMENT),
      },
      runs,
      // Drives the panel's "Email delivery is not enabled yet" section. A
      // literal until Epic 5.6/5.7 lands, and then a real check.
      deliveryEnabled: false,
    });
  } catch (err) {
    logError('Automation', 'Status failed', { message: err.message, stack: err.stack }, req);
    res.status(500).json({ message: 'Could not load automation status' });
  }
});
```

with the imports it needs (`AutomationRun`, `AutomationSettings`, `ScheduledJob`, `mongoEq`, `CLIENT_PANEL_RUN_LIMIT`, `KIND_INVOICE`, `KIND_STATEMENT`, `logError`) added to that file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Backend && npx vitest run test/integration/automation.status.route.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the whole backend suite**

Run: `cd Backend && npm test`
Expected: every test passes. Record the file/test counts — the PR body needs them.

- [ ] **Step 6: Commit**

```bash
git add Backend/src/routes/automation.js Backend/test/integration/automation.status.route.test.js
git commit -m "feat: client-facing automation status endpoint"
```

---

### Task 11: Frontend constants, types and the data hook

**Files:**
- Create: `Frontend/constants/system-health.ts`
- Create: `Frontend/lib/system-health-types.ts`
- Create: `Frontend/lib/system-health-helpers.ts`
- Create: `Frontend/lib/use-system-health.ts`
- Test: `Frontend/test/unit/lib/system-health-helpers.test.ts`

**Interfaces:**
- Consumes: the `/api/system-health/overview` and `/clients` shapes (Tasks 7–8).
- Produces: `SYSTEM_HEALTH_POLL_MS`, `CONNECTION_LABELS`, `CONNECTION_ORDER`; types `Overview`, `ClientRow`, `RunRow`; `formatErrorRate`, `formatDuration`, `runStatusLabel`, `sortClientsBySeverity`; hook `useSystemHealth()`.

- [ ] **Step 1: Write the failing test**

```ts
// Frontend/test/unit/lib/system-health-helpers.test.ts
import { describe, it, expect } from "vitest";

import {
  formatErrorRate,
  formatDuration,
  runStatusLabel,
  sortClientsBySeverity,
} from "@/lib/system-health-helpers";

describe("formatErrorRate", () => {
  it("renders a rate as a percentage", () => {
    expect(formatErrorRate(0.333)).toBe("33.3%");
    expect(formatErrorRate(0)).toBe("0%");
    expect(formatErrorRate(1)).toBe("100%");
  });

  it("renders a missing rate as a dash, never NaN%", () => {
    expect(formatErrorRate(undefined)).toBe("—");
    expect(formatErrorRate(Number.NaN)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("renders milliseconds and seconds", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(1500)).toBe("1.5s");
  });

  it("renders an absent duration as a dash, not 0ms", () => {
    // A skipped run has no duration. "0ms" would read as an instant success.
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
  });
});

describe("runStatusLabel", () => {
  it("names a skipped run for what it is", () => {
    expect(runStatusLabel("skipped")).toBe("Pending setup");
  });

  it("passes through the ordinary states", () => {
    expect(runStatusLabel("succeeded")).toBe("Succeeded");
    expect(runStatusLabel("failed")).toBe("Failed");
    expect(runStatusLabel("queued")).toBe("Queued");
  });

  it("does not crash on an unknown status", () => {
    expect(runStatusLabel("wat" as never)).toBe("Unknown");
  });
});

describe("sortClientsBySeverity", () => {
  it("puts the clients needing attention first", () => {
    const rows = [
      { workspaceId: "a", connection: "connected" as const },
      { workspaceId: "b", connection: "disconnected" as const },
      { workspaceId: "c", connection: "needs_reauth" as const },
    ];

    expect(sortClientsBySeverity(rows).map((r) => r.workspaceId)).toEqual(["c", "b", "a"]);
  });

  it("does not mutate its input", () => {
    const rows = [
      { workspaceId: "a", connection: "connected" as const },
      { workspaceId: "c", connection: "needs_reauth" as const },
    ];
    const copy = [...rows];

    sortClientsBySeverity(rows);

    expect(rows).toEqual(copy);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Frontend && npx vitest run test/unit/lib/system-health-helpers.test.ts`
Expected: FAIL — cannot resolve `@/lib/system-health-helpers`.

- [ ] **Step 3: Write the constants**

```ts
// Frontend/constants/system-health.ts
/**
 * Fixed values for the System Health screens.
 *
 * Touchpoints are recorded per entry, matching the backend convention in
 * Backend/src/constants/. This file imports nothing.
 */

/**
 * How often the overview refetches. Slow on purpose: this is a troubleshooting
 * screen, not a dashboard anyone watches, and every poll runs three queries.
 *
 * Touchpoints: lib/use-system-health.ts.
 */
export const SYSTEM_HEALTH_POLL_MS = 30_000;

/**
 * Display text for each connection state. The keys match the strings
 * Backend/src/utils/automationConnectionStatus.js returns.
 *
 * Touchpoints: lib/system-health-connection-grid.tsx, lib/system-health-helpers.ts.
 */
export const CONNECTION_LABELS = {
  connected: "Connected",
  disconnected: "Disconnected",
  needs_reauth: "Needs re-auth",
} as const;

/**
 * Severity order, worst first — the grid sorts by this so the clients needing
 * attention are on screen without scrolling.
 *
 * Touchpoints: lib/system-health-helpers.ts (sortClientsBySeverity).
 */
export const CONNECTION_ORDER = ["needs_reauth", "disconnected", "connected"] as const;
```

- [ ] **Step 4: Write the types and helpers**

```ts
// Frontend/lib/system-health-types.ts
export type ConnectionStatus = "connected" | "disconnected" | "needs_reauth";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";

export type RunRow = {
  _id: string;
  workspaceId: string;
  boardId: string;
  kind: string;
  periodKey: string;
  jobId: string;
  status: RunStatus;
  skipReason: string | null;
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  recipient: string | null;
  error: string | null;
};

export type ClientRow = {
  workspaceId: string;
  invoiceEnabled: boolean;
  statementEnabled: boolean;
  provider: "xero";
  connection: ConnectionStatus;
};

export type Overview = {
  activeAutomations: number;
  runsToday: number;
  runsThisWeek: number;
  succeeded: number;
  failed: number;
  errorRate24h: number;
  trend: number[];
  errorRateWindowHours: number;
  queue: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    total: number;
    backlogged: boolean;
    available: boolean;
  };
};
```

```ts
// Frontend/lib/system-health-helpers.ts
import { CONNECTION_ORDER } from "@/constants/system-health";
import type { ConnectionStatus, RunStatus } from "@/lib/system-health-types";

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  // Not "Skipped": to a reader that implies the system chose to pass this one
  // over. The truth is that delivery is not built yet.
  skipped: "Pending setup",
};

/** A 0–1 rate as a percentage, or an em dash when there is no rate to show. */
export function formatErrorRate(rate: number | undefined | null): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return "—";
  const percent = rate * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/**
 * A duration, or an em dash when there is none.
 *
 * Absent is not zero: a skipped run never ran, and rendering "0ms" would read
 * as an instant success.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function runStatusLabel(status: RunStatus): string {
  return RUN_STATUS_LABELS[status] ?? "Unknown";
}

/** Worst-first, so what needs attention is on screen without scrolling. */
export function sortClientsBySeverity<T extends { connection: ConnectionStatus }>(
  rows: readonly T[],
): T[] {
  const rank = (status: ConnectionStatus) => {
    const index = CONNECTION_ORDER.indexOf(status);
    return index === -1 ? CONNECTION_ORDER.length : index;
  };
  // Copy first: sort mutates, and mutating props defeats React's change
  // detection.
  return [...rows].sort((a, b) => rank(a.connection) - rank(b.connection));
}
```

- [ ] **Step 5: Write the hook**

```ts
// Frontend/lib/use-system-health.ts
"use client";

import { useCallback, useEffect, useState } from "react";

import axios from "@/app/utils/axiosConfig";
import { SYSTEM_HEALTH_POLL_MS } from "@/constants/system-health";
import type { ClientRow, Overview } from "@/lib/system-health-types";

type State = {
  overview: Overview | null;
  clients: ClientRow[];
  loading: boolean;
  error: string | null;
};

/**
 * Polls the two admin endpoints together, so the tiles and the grid always
 * describe the same moment.
 */
export function useSystemHealth() {
  const [state, setState] = useState<State>({
    overview: null,
    clients: [],
    loading: true,
    error: null,
  });

  const load = useCallback(async () => {
    try {
      const [overview, clients] = await Promise.all([
        axios.get("/api/system-health/overview"),
        axios.get("/api/system-health/clients"),
      ]);
      setState({
        overview: overview.data,
        clients: clients.data.clients ?? [],
        loading: false,
        error: null,
      });
    } catch {
      // Keep whatever is on screen: a failed poll should not blank a screen
      // someone is reading.
      setState((prev) => ({ ...prev, loading: false, error: "Could not load system health" }));
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, SYSTEM_HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return { ...state, refresh: load };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd Frontend && npx vitest run test/unit/lib/system-health-helpers.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 7: Commit**

```bash
git add Frontend/constants/system-health.ts Frontend/lib/system-health-types.ts Frontend/lib/system-health-helpers.ts Frontend/lib/use-system-health.ts Frontend/test/unit/lib/system-health-helpers.test.ts
git commit -m "feat: system health types, constants, formatting and data hook"
```

---

### Task 12: The System Health tab

**Files:**
- Create: `Frontend/lib/system-health-connection-grid.tsx`
- Create: `Frontend/lib/system-health-page-view.tsx`
- Modify: `Frontend/app/dashboard/page.tsx`
- Test: `Frontend/test/unit/lib/system-health-page-view.test.tsx`

**Interfaces:**
- Consumes: `useSystemHealth` (Task 11), `isOwnerOrSupport` from `@/lib/access`.
- Produces: `<SystemHealthPageView />`, `<SystemHealthConnectionGrid clients onSelect />`.

- [ ] **Step 1: Write the failing test**

```tsx
// Frontend/test/unit/lib/system-health-page-view.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const mockState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@/lib/use-system-health", () => ({
  useSystemHealth: () => mockState.current,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { SystemHealthPageView } from "@/lib/system-health-page-view";

const OVERVIEW = {
  activeAutomations: 12,
  runsToday: 340,
  runsThisWeek: 900,
  succeeded: 332,
  failed: 8,
  errorRate24h: 0.023,
  trend: [0, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 5],
  errorRateWindowHours: 24,
  queue: {
    waiting: 3, active: 0, delayed: 0, failed: 0,
    total: 3, backlogged: false, available: true,
  },
};

describe("SystemHealthPageView", () => {
  beforeEach(() => {
    mockState.current = {
      overview: OVERVIEW, clients: [], loading: false, error: null, refresh: vi.fn(),
    };
  });

  it("shows the headline figures", () => {
    render(<SystemHealthPageView />);

    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("340")).toBeInTheDocument();
    expect(screen.getByText("2.3%")).toBeInTheDocument();
  });

  it("says delivery is not enabled yet rather than showing an empty bounce count", () => {
    render(<SystemHealthPageView />);
    expect(screen.getByText(/delivery is not enabled yet/i)).toBeInTheDocument();
  });

  it("flags a queue backlog", () => {
    mockState.current = {
      ...mockState.current,
      overview: { ...OVERVIEW, queue: { ...OVERVIEW.queue, total: 80, backlogged: true } },
    };

    render(<SystemHealthPageView />);
    expect(screen.getByText(/backlog/i)).toBeInTheDocument();
  });

  it("says so when the queue could not be read, rather than showing a false zero", () => {
    mockState.current = {
      ...mockState.current,
      overview: { ...OVERVIEW, queue: { ...OVERVIEW.queue, available: false } },
    };

    render(<SystemHealthPageView />);
    expect(screen.getByText(/queue unavailable/i)).toBeInTheDocument();
  });

  it("renders an error banner without blanking the page", () => {
    mockState.current = { ...mockState.current, error: "Could not load system health" };

    render(<SystemHealthPageView />);

    expect(screen.getByText(/could not load system health/i)).toBeInTheDocument();
    expect(screen.getByText("340")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Frontend && npx vitest run test/unit/lib/system-health-page-view.test.tsx`
Expected: FAIL — cannot resolve `@/lib/system-health-page-view`.

- [ ] **Step 3: Write the connection grid**

```tsx
// Frontend/lib/system-health-connection-grid.tsx
"use client";

import { Badge } from "@/components/ui/badge";
import { CONNECTION_LABELS } from "@/constants/system-health";
import { sortClientsBySeverity } from "@/lib/system-health-helpers";
import type { ClientRow } from "@/lib/system-health-types";

const VARIANT: Record<ClientRow["connection"], "default" | "secondary" | "destructive"> = {
  connected: "secondary",
  disconnected: "destructive",
  needs_reauth: "destructive",
};

type Props = Readonly<{
  clients: readonly ClientRow[];
  onSelect: (workspaceId: string) => void;
}>;

export function SystemHealthConnectionGrid({ clients, onSelect }: Props) {
  if (clients.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No workspace has Invoice &amp; Statement Automation enabled yet.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {sortClientsBySeverity(clients).map((client) => (
        <li key={client.workspaceId}>
          <button
            type="button"
            onClick={() => onSelect(client.workspaceId)}
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50"
          >
            <span className="text-sm font-medium">{client.workspaceId}</span>
            <span className="flex items-center gap-2">
              <span className="text-xs uppercase text-muted-foreground">{client.provider}</span>
              <Badge variant={VARIANT[client.connection]}>
                {CONNECTION_LABELS[client.connection]}
              </Badge>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Write the page view**

```tsx
// Frontend/lib/system-health-page-view.tsx
"use client";

import { useRouter } from "next/navigation";

import { Card } from "@/components/ui/card";
import Spinner from "@/components/ui/spin";
import { useSystemHealth } from "@/lib/use-system-health";
import { formatErrorRate } from "@/lib/system-health-helpers";
import { SystemHealthConnectionGrid } from "@/lib/system-health-connection-grid";

function Tile({ label, value, hint }: Readonly<{ label: string; value: string; hint?: string }>) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

export function SystemHealthPageView() {
  const router = useRouter();
  const { overview, clients, loading, error } = useSystemHealth();

  if (loading && !overview) return <Spinner />;

  const queue = overview?.queue;
  const queueValue = queue?.available === false ? "Queue unavailable" : String(queue?.total ?? 0);

  return (
    <div className="space-y-6">
      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Active automations" value={String(overview?.activeAutomations ?? 0)} />
        <Tile
          label="Runs today"
          value={String(overview?.runsToday ?? 0)}
          hint={`${overview?.failed ?? 0} failed`}
        />
        <Tile
          label={`Error rate (${overview?.errorRateWindowHours ?? 24}h)`}
          value={formatErrorRate(overview?.errorRate24h)}
        />
        <Tile
          label="Queue"
          value={queueValue}
          hint={queue?.backlogged ? "Backlog building up" : undefined}
        />
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Connections</h2>
        <SystemHealthConnectionGrid
          clients={clients}
          onSelect={(workspaceId) => router.push(`/workspace/${workspaceId}/system-health`)}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Bounces &amp; complaints</h2>
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
          Email delivery is not enabled yet, so there is nothing to report here.
        </p>
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Wire the tab**

In `Frontend/app/dashboard/page.tsx`, alongside the existing Application logs tab. Replace the inline role comparisons in the `TabsList` grid class and the two admin blocks with `isOwnerOrSupport(user)`, and add:

```tsx
            {isOwnerOrSupport(user) && (
              <TabsTrigger
                value="system-health"
                className="gap-2 rounded-lg py-2.5 text-left leading-tight data-[state=active]:bg-background data-[state=active]:shadow-sm sm:text-center"
              >
                <span className="inline-flex items-center gap-2">
                  <Activity className="h-4 w-4 shrink-0" />
                  <span>System Health</span>
                </span>
              </TabsTrigger>
            )}
```

and the matching content:

```tsx
          {isOwnerOrSupport(user) && (
            <TabsContent value="system-health">
              <SystemHealthPageView />
            </TabsContent>
          )}
```

Import `Activity` from `lucide-react`, `isOwnerOrSupport` from `@/lib/access`, and `SystemHealthPageView` from `@/lib/system-health-page-view`. The `TabsList` grid class must become three columns for admins — update `grid-cols-1 sm:grid-cols-2` to `sm:grid-cols-3` in the admin branch.

- [ ] **Step 6: Run the tests**

Run: `cd Frontend && npx vitest run test/unit/lib/system-health-page-view.test.tsx test/unit/lib/finance-settings-page.test.tsx`
Expected: PASS. Then `npx tsc --noEmit` and `npm run lint`.

- [ ] **Step 7: Commit**

```bash
git add Frontend/lib/system-health-page-view.tsx Frontend/lib/system-health-connection-grid.tsx Frontend/app/dashboard/page.tsx Frontend/test/unit/lib/system-health-page-view.test.tsx
git commit -m "feat: System Health dashboard tab"
```

---

### Task 13: The per-client drill-down page

**Files:**
- Create: `Frontend/app/workspace/[id]/system-health/page.tsx`
- Create: `Frontend/lib/system-health-drilldown-view.tsx`
- Test: `Frontend/test/unit/lib/system-health-drilldown-view.test.tsx`

**Interfaces:**
- Consumes: `GET /api/system-health/workspace/:id` (Task 8), the run/retry routes (Task 9), the helpers and types (Task 11).
- Produces: `<SystemHealthDrilldownView workspaceId />`.

- [ ] **Step 1: Write the failing test**

```tsx
// Frontend/test/unit/lib/system-health-drilldown-view.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());

vi.mock("@/app/utils/axiosConfig", () => ({ default: { get, post } }));

import { SystemHealthDrilldownView } from "@/lib/system-health-drilldown-view";

const RUN = {
  _id: "r1", workspaceId: "ws-1", boardId: "b1", kind: "invoice_automation",
  periodKey: "20260116-0900", jobId: "inv:b1:20260116-0900", status: "skipped",
  skipReason: "delivery_not_implemented", trigger: "schedule",
  startedAt: "2026-08-13T00:00:00.000Z", finishedAt: null,
  durationMs: null, recipient: null, error: null,
};

describe("SystemHealthDrilldownView", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({
      data: { workspaceId: "ws-1", schedules: [], runs: [RUN], total: 1, page: 1, pageSize: 50 },
    });
  });

  it("lists the run history", async () => {
    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    expect(await screen.findByText("b1")).toBeInTheDocument();
    // A skipped run reads as "Pending setup", and has no duration.
    expect(screen.getByText("Pending setup")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("explains a refused run instead of appearing to do nothing", async () => {
    post.mockRejectedValue({
      response: { status: 409, data: { error: "already_run", periodKey: "20260116-0900", runs: [RUN] } },
    });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /run invoices now/i }));

    expect(await screen.findByText(/already run/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /force re-run/i })).toBeInTheDocument();
  });

  it("forces a re-run only after the override is chosen", async () => {
    post.mockRejectedValueOnce({
      response: { status: 409, data: { error: "already_run", periodKey: "p", runs: [RUN] } },
    });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /run invoices now/i }));

    post.mockResolvedValueOnce({ data: { enqueued: 1 } });
    await userEvent.click(screen.getByRole("button", { name: /force re-run/i }));

    await waitFor(() => {
      expect(post).toHaveBeenLastCalledWith(
        expect.stringContaining("force=1"),
        expect.anything(),
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Frontend && npx vitest run test/unit/lib/system-health-drilldown-view.test.tsx`
Expected: FAIL — cannot resolve `@/lib/system-health-drilldown-view`.

- [ ] **Step 3: Write the view**

```tsx
// Frontend/lib/system-health-drilldown-view.tsx
"use client";

import { useCallback, useEffect, useState } from "react";

import axios from "@/app/utils/axiosConfig";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatDuration, runStatusLabel } from "@/lib/system-health-helpers";
import type { RunRow } from "@/lib/system-health-types";

type Refusal = { periodKey: string; runs: RunRow[] } | null;

type Props = Readonly<{ workspaceId: string }>;

export function SystemHealthDrilldownView({ workspaceId }: Props) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [refusal, setRefusal] = useState<Refusal>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await axios.get(`/api/system-health/workspace/${workspaceId}`);
    setRuns(res.data.runs ?? []);
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  const start = useCallback(
    async (force: boolean) => {
      setBusy(true);
      try {
        const query = force ? "?force=1" : "";
        await axios.post(`/api/system-health/workspace/${workspaceId}/run${query}`, {
          kind: "invoice",
        });
        setRefusal(null);
        await load();
      } catch (err) {
        const response = (err as { response?: { status?: number; data?: Refusal } }).response;
        // 409 is the designed answer, not a failure: say which period, and
        // offer the override rather than silently doing nothing.
        if (response?.status === 409 && response.data) setRefusal(response.data);
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, load],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button type="button" disabled={busy} onClick={() => start(false)}>
          Run invoices now
        </Button>
      </div>

      {refusal ? (
        <Card className="space-y-2 border-amber-500/40 p-4">
          <p className="text-sm">
            Already run for {refusal.periodKey} — {refusal.runs.length} run(s) recorded.
          </p>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => start(true)}>
            Force re-run
          </Button>
        </Card>
      ) : null}

      <ul className="divide-y divide-border rounded-lg border border-border">
        {runs.map((run) => (
          <li key={run._id} className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="font-medium">{run.boardId}</span>
            <span className="flex items-center gap-4 text-muted-foreground">
              <span>{runStatusLabel(run.status)}</span>
              <span>{formatDuration(run.durationMs)}</span>
              <span>{run.recipient ?? "—"}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Write the page**

```tsx
// Frontend/app/workspace/[id]/system-health/page.tsx
"use client";

import { useParams } from "next/navigation";

import { SystemHealthDrilldownView } from "@/lib/system-health-drilldown-view";

export default function WorkspaceSystemHealthPage() {
  const params = useParams<{ id: string }>();

  return (
    <div className="container mx-auto max-w-5xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">System Health</h1>
      <SystemHealthDrilldownView workspaceId={params.id} />
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd Frontend && npx vitest run test/unit/lib/system-health-drilldown-view.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add Frontend/app/workspace/\[id\]/system-health/page.tsx Frontend/lib/system-health-drilldown-view.tsx Frontend/test/unit/lib/system-health-drilldown-view.test.tsx
git commit -m "feat: per-client System Health drill-down"
```

---

### Task 14: The client-facing status panel

**Files:**
- Create: `Frontend/lib/automation-status-panel.tsx`
- Modify: `Frontend/lib/invoice-statement-automation-panel.tsx`
- Test: `Frontend/test/unit/lib/automation-status-panel.test.tsx`

**Interfaces:**
- Consumes: `GET /api/automation/:workspaceId/status` (Task 10), helpers from Task 11.
- Produces: `<AutomationStatusPanel workspaceId />`.

- [ ] **Step 1: Write the failing test**

```tsx
// Frontend/test/unit/lib/automation-status-panel.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const get = vi.hoisted(() => vi.fn());
vi.mock("@/app/utils/axiosConfig", () => ({ default: { get } }));

import { AutomationStatusPanel } from "@/lib/automation-status-panel";

const STATUS = {
  invoice: { enabled: true, nextRun: "2026-09-15T23:00:00.000Z", lastStatus: "skipped" },
  statement: { enabled: false, nextRun: null, lastStatus: null },
  runs: [
    {
      _id: "r1", workspaceId: "ws-1", boardId: "b1", kind: "invoice_automation",
      periodKey: "p", jobId: "j", status: "skipped", skipReason: "delivery_not_implemented",
      trigger: "schedule", startedAt: "2026-08-13T00:00:00.000Z", finishedAt: null,
      durationMs: null, recipient: null, error: null,
    },
  ],
  deliveryEnabled: false,
};

describe("AutomationStatusPanel", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: STATUS });
  });

  it("shows recent runs rather than an empty box", async () => {
    render(<AutomationStatusPanel workspaceId="ws-1" />);

    expect(await screen.findByText("b1")).toBeInTheDocument();
    expect(screen.getByText("Pending setup")).toBeInTheDocument();
  });

  it("tells the client delivery is not enabled yet", async () => {
    render(<AutomationStatusPanel workspaceId="ws-1" />);
    expect(await screen.findByText(/not enabled yet/i)).toBeInTheDocument();
  });

  it("says there is no history yet rather than rendering nothing", async () => {
    get.mockResolvedValue({ data: { ...STATUS, runs: [] } });

    render(<AutomationStatusPanel workspaceId="ws-1" />);

    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Frontend && npx vitest run test/unit/lib/automation-status-panel.test.tsx`
Expected: FAIL — cannot resolve `@/lib/automation-status-panel`.

- [ ] **Step 3: Write the panel**

```tsx
// Frontend/lib/automation-status-panel.tsx
"use client";

import { useEffect, useState } from "react";

import axios from "@/app/utils/axiosConfig";
import { Card } from "@/components/ui/card";
import { formatDuration, runStatusLabel } from "@/lib/system-health-helpers";
import type { RunRow } from "@/lib/system-health-types";

type Status = {
  runs: RunRow[];
  deliveryEnabled: boolean;
};

type Props = Readonly<{ workspaceId: string }>;

/**
 * The client-facing half of Visibility & Monitoring: the last few runs of this
 * workspace's automation, on the Invoice & Statement Automation tab.
 *
 * Skipped runs are shown rather than hidden. They are truthful — nothing was
 * sent, because delivery is unbuilt — and a silently empty history looks like
 * a broken feature rather than an unfinished one.
 */
export function AutomationStatusPanel({ workspaceId }: Props) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let cancelled = false;
    axios
      .get(`/api/automation/${workspaceId}/status`)
      .then((res) => {
        if (!cancelled) setStatus(res.data);
      })
      .catch(() => {
        if (!cancelled) setStatus({ runs: [], deliveryEnabled: false });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (!status) return null;

  return (
    <Card className="space-y-4 p-5">
      <h3 className="text-sm font-semibold">Recent activity</h3>

      {status.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {status.runs.map((run) => (
            <li key={run._id} className="flex items-center justify-between py-2 text-sm">
              <span className="font-medium">{run.boardId}</span>
              <span className="flex items-center gap-4 text-muted-foreground">
                <span>{runStatusLabel(run.status)}</span>
                <span>{formatDuration(run.durationMs)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {status.deliveryEnabled ? null : (
        <p className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          Email delivery is not enabled yet. Runs are recorded, but no invoices or statements are
          sent.
        </p>
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Render it in the automation panel**

In `Frontend/lib/invoice-statement-automation-panel.tsx`, render `<AutomationStatusPanel workspaceId={workspaceId} />` below the existing invoice and statement blocks. Import it from `@/lib/automation-status-panel`.

- [ ] **Step 5: Run the tests**

Run: `cd Frontend && npx vitest run test/unit/lib/automation-status-panel.test.tsx test/unit/lib/invoice-statement-automation-panel.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add Frontend/lib/automation-status-panel.tsx Frontend/lib/invoice-statement-automation-panel.tsx Frontend/test/unit/lib/automation-status-panel.test.tsx
git commit -m "feat: client-facing automation status panel"
```

---

### Task 15: End-to-end coverage and the full verification run

**Files:**
- Create: `Frontend/e2e/system-health.spec.ts`
- Test: the whole suite, both apps

**Interfaces:**
- Consumes: everything above.
- Produces: nothing — this task proves the feature works and produces the numbers the PR body needs.

- [ ] **Step 1: Write the e2e spec**

`Frontend/e2e/invoice-statement-automation.spec.ts` has a local (non-exported) `signIn(page)` that authenticates through `POST {BACKEND}/api/auth/login` using `page.request`, so the session cookie lands in the browser context's jar. Credentials come from `E2E_EMAIL` / `E2E_PASSWORD`, never from source, and `npm run dev:user` prints a local `support_admin` login.

Copy that same `signIn` shape here rather than importing it — the existing one is not exported, and exporting it is a change to an Epic 5 file this task has no reason to touch.

```ts
// Frontend/e2e/system-health.spec.ts
import { test, expect, type Page } from "@playwright/test";

/**
 * Epic 6 — the System Health tab and its role gate.
 *
 * The gate is the half worth an e2e test: a unit test can assert the tab
 * renders, but only a real session proves the role that reaches the browser is
 * the one the server issued.
 */

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

// A non-admin login. `npm run dev:user -- --role isoplus_user` does not exist;
// seed one, or point these at an existing isoplus_user account.
const USER_EMAIL = process.env.E2E_USER_EMAIL;
const USER_PASSWORD = process.env.E2E_USER_PASSWORD;

const BACKEND =
  process.env.E2E_BACKEND_URL ??
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  "http://localhost:4001";

/**
 * Authenticate through the API rather than the login form — page.request
 * shares the browser context's cookie jar, so the session it sets is the one
 * the page will send. Mirrors invoice-statement-automation.spec.ts.
 */
async function signIn(page: Page, email?: string, password?: string) {
  const response = await page.request.post(`${BACKEND}/api/auth/login`, {
    data: { email, password },
  });
  expect(response.ok(), `login failed: ${response.status()}`).toBe(true);
}

test.describe("System Health", () => {
  test.skip(!EMAIL || !PASSWORD, "set E2E_EMAIL and E2E_PASSWORD — see npm run dev:user");

  test("an admin sees the tab, the tiles, and the delivery notice", async ({ page }) => {
    await signIn(page, EMAIL, PASSWORD);
    await page.goto("/dashboard");

    const tab = page.getByRole("tab", { name: /system health/i });
    await expect(tab).toBeVisible();
    await tab.click();

    await expect(page.getByText(/active automations/i)).toBeVisible();
    await expect(page.getByText(/error rate/i)).toBeVisible();
    await expect(page.getByText(/email delivery is not enabled yet/i)).toBeVisible();
  });

  test("a non-admin never sees the tab", async ({ page }) => {
    test.skip(!USER_EMAIL || !USER_PASSWORD, "set E2E_USER_EMAIL and E2E_USER_PASSWORD");

    await signIn(page, USER_EMAIL, USER_PASSWORD);
    await page.goto("/dashboard");

    await expect(page.getByRole("tab", { name: /workspaces/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /system health/i })).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Run the e2e spec**

Run: `cd Frontend && E2E_EMAIL=... E2E_PASSWORD=... npx playwright test e2e/system-health.spec.ts`
Expected: PASS. The second test skips unless `E2E_USER_EMAIL`/`E2E_USER_PASSWORD` name a real `isoplus_user` — seed one rather than leaving the role gate unproven, and say in the PR if you could not.

- [ ] **Step 3: Run everything**

```bash
cd Backend && npm test
cd ../Frontend && npx vitest run && npx tsc --noEmit && npm run lint
cd .. && npm run test:scripts
```

Record the actual counts from each. The PR body needs the real output, not "tested locally".

- [ ] **Step 4: Confirm the indexes exist**

Run: `npm run schema -- automationruns`
Expected: the three declared indexes are listed. This is the check the deleted KAN-15 migration was replaced by.

- [ ] **Step 5: Commit and open the PR**

```bash
git add Frontend/e2e/system-health.spec.ts
git commit -m "test: end-to-end coverage for System Health"
git push -u origin feature/KAN-11_visibility_and_monitoring
```

PR targets `feature/KAN-10_invoice_statement_automation_full`. Follow the structure in `CLAUDE.md` — Summary, Ticket, What's included, Blast radius, New dependencies, Migrations (state that there are none and why), Verification with real output, Follow-ups. No AI attribution.

---

## Verification checklist

- [ ] Ticking a due schedule writes one `AutomationRun` per board, and a redispatch of the same slot does not duplicate them.
- [ ] The worker closes each run as `skipped` with reason `delivery_not_implemented`.
- [ ] `/api/system-health/*` returns 403 for `isoplus_user` and 200 for `owner` and `support_admin`.
- [ ] The overview does not divide by zero on an empty system.
- [ ] A client with no stored `refreshTokenExpiresAt` reads as `connected`, not `needs_reauth`.
- [ ] Run now refuses a second run for the same period with 409, and `?force=1` succeeds under a distinct `manual:` jobId.
- [ ] The System Health tab is absent for a non-admin.
- [ ] Skipped runs render as "Pending setup" with an em dash for duration, never "0ms".
- [ ] `npm run schema -- automationruns` lists all three indexes.
- [ ] Backend, Frontend, scripts suites all green, with the counts recorded.
