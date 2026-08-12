# Scheduled Job Trigger (KAN-15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the backend a clock — an API-key-protected endpoint that claims due schedules from Mongo and enqueues them into the BullMQ queue that already exists.

**Architecture:** The scheduler decides *when* and nothing else. An external caller (EventBridge in AWS, `npm run tick` locally) POSTs to `/api/scheduler/tick`. The tick claims due `ScheduledJob` documents atomically, dispatches each to a handler registered against its `kind`, and the handler enqueues into the existing `board-sync` queue and returns immediately. No work happens inside the tick.

**Tech Stack:** Node 22, Express, Mongoose, Vitest + supertest, `cron-parser@5`.

**Spec:** [`docs/superpowers/specs/2026-08-11-scheduled-job-trigger-design.md`](../superpowers/specs/2026-08-11-scheduled-job-trigger-design.md)

**Branch:** `feature/KAN-15_scheduled_job_trigger` (already created from `origin/develop`; the spec is committed on it)

## Global Constraints

- **Cognitive complexity < 15 per function** (SonarJS S3776, `.eslintrc.complexity.cjs`). This is why the tick is split across `tick.js`, `outcome.js` and `nextRun.js` rather than living in one function. Do not recombine them.
- **All backend npm commands run from `Backend/`.** There is no root-level build tooling for app code.
- **`scripts/` must stay dependency-free.** It runs on a fresh clone before any `npm install`, and there is no root `node_modules`. Node only — no `.sh`, no `ss`, no `readlink -f`. It must run unmodified on Linux, macOS and Windows.
- **Tests are Vitest and must be named `*.test.js`.** `vitest.config.js` includes `test/**/*.test.js` only; a `.mjs` suffix is silently not collected.
- **Never let a test reach a real external API.** ISO+, Xero, AWS and Sentry are mocked. `test/setup.js` already provides `mongodb-memory-server` and a mocked `ioredis`.
- **Timezone default is `Australia/Sydney`.** Every date computation is timezone-explicit; nothing relies on the server's local zone (the developer machine here is UTC+08, which is neither Sydney nor UTC — a bug that assumes local time will not reproduce on the server).
- **Commit format:** `feat:` / `fix:` / `refactor:` / `docs:`, ticket `KAN-15` in the PR title or body. **No AI attribution** — no `Co-Authored-By` trailer, no "Generated with" line.
- **Do not modify** `src/services/sync.js`, `src/workers/syncWorker.js`, `src/services/sync/queue.js`, or any existing route. This change is additive.

## Errata — corrections found while executing this plan

**Status: executed and merged.** This plan is kept as the record of how the
scheduler was built. Rather than silently rewriting it, the defects found during
execution are listed here, following the same convention the specs use. Where an
erratum contradicts a task's text below, **the erratum wins**.

| # | Where | Defect | Correction |
|---|---|---|---|
| 1 | File structure, Task 7 | **Critical.** The plan named only `app.js` as needing the route mounted. `Backend/src/index.js` is the production entry point and does **not** use `createApp()` — they are parallel express apps. As first written, the endpoint existed in tests and returned 404 in production, with the whole suite passing. | The route is mounted in **both** (`app.js:127`, `index.js:155`), and `registerSchedulerHandlers()` is called at `index.js:48`. Any new route in this repo must be mounted twice. |
| 2 | Task 7 | `registerSchedulerHandlers()` was defined but never called anywhere, so `board_sync` was absent from the registry. | Called once at boot in `index.js`, deliberately not inside `createApp()` — the integration tests call `clearRegistry()` and register their own fake handler. |
| 3 | Task 5, `outcome.js` | `String(err?.message || err)` stores `"[object Object]"` when a handler throws a non-`Error`, leaving `lastError` undiagnosable. | Replaced with a `describeError` helper handling `Error`, string, and other values via `JSON.stringify` with a `try/catch` fallback for circular structures. |
| 4 | Task 4, test code | `PERSONAL_ACCESS_TOKEN` was set in a `beforeEach` with no restore, and `vitest.config.js` sets `maxWorkers: 1`, so the value leaks into every later test file. | Both describe blocks restore it, using `delete process.env.X` when the original was `undefined` — assigning `undefined` back would store the literal string `"undefined"`. |
| 5 | Task 6, test suite | No test distinguished "a lost compare-and-swap continues to the next candidate" from "returns null and stops" — the bug this design already had once. The single-row contention test cannot tell them apart. | Added a deterministic test stubbing `findOneAndUpdate` to resolve `null` once, verified to fail against deliberately broken code. A two-row *concurrent* test does **not** work: the winner claims both rows under the bug, so the totals match either way. |
| 6 | Task 4 Step 5, Task 5 Step 4 | Stated "PASS, 10 tests" and "PASS, 6 tests"; the briefs' own test code defines **9** and **5**. | Corrected below. The other five per-task counts were audited against the shipped files and are correct. |
| 7 | Task 6, `tick.js` | Raised in review on PR #855. An `AT_MOST_ONCE` row whose `cron`/`timezone` will not parse was recorded as failed and skipped for the rest of that tick — but `nextRunAt` is advanced *by the claim*, and advancing is exactly what cannot be done for such a row. It stayed due, was re-selected on every subsequent tick forever, and never appeared in `claimed` or `failed`, so the summary showed nothing wrong. | A schedule whose own next slot cannot be computed can never run again, so it is now disabled (`quarantineSchedule`, `outcome.js`) rather than left in the claim query, and counted in the tick's `failed` total. The same rule is applied to the symmetric `AT_LEAST_ONCE` case — the give-up advance past `MAX_CONSECUTIVE_FAILURES` — which had the same defect and was recorded as follow-up 4 on the PR. Disabling is non-destructive: `lastError`, `lastRunAt`, `missedRuns` and `consecutiveFailures` survive, and `upsertSchedule` re-enables. |
| 8 | Task 5, `outcome.js` | Raised in review on PR #855. `recordFailure` wrote an unconditional `updateOne` with a `consecutiveFailures` derived from the copy read before dispatch. Under `AT_LEAST_ONCE` two instances may dispatch the same slot by design; if one succeeded and the other failed, the late failure overwrote the success — resurrecting `lastError` and a stale count on a schedule that had already advanced. Two concurrent failures also both wrote the same number, losing one. | The failure update is a compare-and-swap on the slot it was made for (`{ _id, nextRunAt }`), so a failure for a slot that has already moved on is discarded and logged. `consecutiveFailures` is `$inc`'d against the stored value rather than computed in memory. The give-up advance is guarded the same way. |
| 9 | Task 3, `schedules.js` | Raised in review on PR #855. `upsertSchedule`'s `findOneAndUpdate(..., { upsert: true })` is not atomic against the unique `{ kind, targetId }` index: two concurrent callers can both miss on the read, both attempt the insert, and the loser gets `E11000` instead of converging on the winner's row. Reachable from a toggle double-clicked or a retried request. | Retried once on `code === 11000`, which is Mongo's documented remedy — by then the row exists and the retry updates it. Once only; a duplicate that survives the retry is not this race and surfaces. |

**Also learned, not a plan defect:** adding `cron-parser` requires `npm run dev:build`. A container built before the change has BullMQ's `cron-parser` 4.9.0 hoisted at top level, which lacks `CronExpressionParser`, and the backend crash-loops with a "CommonJS module" error that reads like a code bug. The lockfile is correct and `npm ci` is unaffected. See `docs/scheduling.md`.

## Verified facts (spike results — do not re-derive)

These were measured against `cron-parser@5.8.1`, not assumed. Use them as test expectations verbatim.

| Input | Result |
|---|---|
| `'0 2 1 * *'`, Sydney, from `2026-08-15T00:00:00Z` | `2026-08-31T16:00:00.000Z` — note the **UTC instant is in August** while the local date is 1 September |
| `'30 2 * * *'`, Sydney, from `2026-10-03T14:00:00Z` (local time 02:30 does not exist — clocks jump 02:00→03:00 on 4 Oct 2026) | `2026-10-03T16:30:00.000Z` = 03:30 local. Rolls forward; does **not** skip the day |
| `'30 2 * * *'`, Sydney, from `2026-04-04T14:00:00Z` (local time 02:30 happens twice — clocks fall back on 5 Apr 2026) | `2026-04-04T15:30:00.000Z` = the **first** of the two occurrences |
| `'*/30 * * * *'`, Sydney, from `2026-08-11T04:05:00Z` | `2026-08-11T04:30:00.000Z` |
| `countMissedSlots('*/30 * * * *', Sydney, 00:00Z, 03:00Z)` | `5` |

**Two traps found during the spike:**

1. `CronExpressionParser.parse()` **accepts an unknown timezone** and only fails later inside `next()`, with the opaque message `CronDate: unhandled timestamp: ...`. Validation must therefore go through `Intl.DateTimeFormat`, which throws a `RangeError` immediately.
2. `Intl.DateTimeFormat` accepts `timeZone: undefined` (it falls back to the system zone), so validation also needs an explicit non-empty-string check.

## File structure

| File | Responsibility |
|---|---|
| `Backend/src/services/scheduler/nextRun.js` | **Pure.** Cron + timezone → next slot; missed-slot counting; schedule validation. No I/O. |
| `Backend/src/services/scheduler/registry.js` | `kind` → `{ handler, policy }`. Registration and lookup. |
| `Backend/src/services/scheduler/auth.js` | `getSchedulerAuthorization()`. |
| `Backend/src/services/scheduler/schedules.js` | `upsertSchedule` / `disableSchedule` — the only sanctioned writers of `ScheduledJob`. |
| `Backend/src/services/scheduler/outcome.js` | Recording success and failure per policy. Split out to keep `tick.js` under the complexity gate. |
| `Backend/src/services/scheduler/tick.js` | Claim → dispatch → summarise. |
| `Backend/src/services/scheduler/handlers.js` | Where features register. Imported for side effects at boot. |
| `Backend/src/models/ScheduledJob.js` | Mongoose schema and indexes. |
| `Backend/src/routes/scheduler.js` | Thin route. Parse, call `runTick`, respond. |
| `Backend/src/app.js` | **Modify** — mount the router. |
| `Backend/src/index.js` | **Modify** — mount the router *again*, and call `registerSchedulerHandlers()` at boot. See erratum 1: this is the production entry point and it does **not** use `createApp()`. |
| `scripts/lib/tick.mjs` | Local ticker: config resolution and the loop. Pure-ish, no dependencies. |
| `scripts/dev.mjs` | **Modify** — add the `tick` subcommand. |
| `package.json` (root) | **Modify** — add the `tick` npm script. |
| `docs/scheduling.md` | Ops reference: the EventBridge rule, and how to run it locally. |

---

### Task 1: `nextRun.js` — cron arithmetic

This is where the work is most likely to be quietly wrong, so it goes first and gets the most tests.

**Files:**
- Create: `Backend/src/services/scheduler/nextRun.js`
- Test: `Backend/test/unit/services/scheduler.nextRun.test.js`
- Modify: `Backend/package.json` (add `cron-parser`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `computeNextRun(cron: string, timezone: string, from: Date) => Date`
  - `countMissedSlots(cron: string, timezone: string, scheduledFor: Date, now: Date, max?: number) => number`
  - `isValidSchedule(cron: string, timezone: string) => boolean`

- [ ] **Step 1: Install the dependency**

```bash
cd Backend && npm install cron-parser@5.8.1
```

- [ ] **Step 2: Write the failing test**

Create `Backend/test/unit/services/scheduler.nextRun.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  computeNextRun,
  countMissedSlots,
  isValidSchedule,
} from '../../../src/services/scheduler/nextRun.js';

const TZ = 'Australia/Sydney';

describe('computeNextRun', () => {
  it('resolves a monthly slot to the correct UTC instant across a month boundary', () => {
    // 1 Sep 2026 02:00 in Sydney is 31 Aug 2026 16:00 UTC. The local date and
    // the UTC date are in different months, which is what breaks naive handling.
    const next = computeNextRun('0 2 1 * *', TZ, new Date('2026-08-15T00:00:00Z'));
    expect(next.toISOString()).toBe('2026-08-31T16:00:00.000Z');
  });

  it('rolls forward when the local time does not exist (DST starts)', () => {
    // Sydney clocks jump 02:00 -> 03:00 on 4 Oct 2026, so 02:30 never happens.
    const next = computeNextRun('30 2 * * *', TZ, new Date('2026-10-03T14:00:00Z'));
    expect(next.toISOString()).toBe('2026-10-03T16:30:00.000Z');
  });

  it('takes the first occurrence when the local time happens twice (DST ends)', () => {
    // Sydney clocks fall back on 5 Apr 2026, so 02:30 happens twice.
    const next = computeNextRun('30 2 * * *', TZ, new Date('2026-04-04T14:00:00Z'));
    expect(next.toISOString()).toBe('2026-04-04T15:30:00.000Z');
  });

  it('handles a simple interval expression', () => {
    const next = computeNextRun('*/30 * * * *', TZ, new Date('2026-08-11T04:05:00Z'));
    expect(next.toISOString()).toBe('2026-08-11T04:30:00.000Z');
  });
});

describe('countMissedSlots', () => {
  it('counts the slots skipped between the due time and now', () => {
    const missed = countMissedSlots(
      '*/30 * * * *',
      TZ,
      new Date('2026-08-11T00:00:00Z'),
      new Date('2026-08-11T03:00:00Z'),
    );
    expect(missed).toBe(5);
  });

  it('is zero when the schedule is not yet due', () => {
    const missed = countMissedSlots(
      '*/30 * * * *',
      TZ,
      new Date('2026-08-11T03:00:00Z'),
      new Date('2026-08-11T00:00:00Z'),
    );
    expect(missed).toBe(0);
  });

  it('is zero when only the due slot itself has passed', () => {
    const missed = countMissedSlots(
      '*/30 * * * *',
      TZ,
      new Date('2026-08-11T00:00:00Z'),
      new Date('2026-08-11T00:29:00Z'),
    );
    expect(missed).toBe(0);
  });

  it('stops at the cap rather than looping forever', () => {
    const missed = countMissedSlots(
      '*/30 * * * *',
      TZ,
      new Date('2020-01-01T00:00:00Z'),
      new Date('2026-01-01T00:00:00Z'),
      10,
    );
    expect(missed).toBe(10);
  });
});

describe('isValidSchedule', () => {
  it('accepts a valid expression and timezone', () => {
    expect(isValidSchedule('*/30 * * * *', TZ)).toBe(true);
  });

  it('rejects an invalid cron expression', () => {
    expect(isValidSchedule('not-a-cron', TZ)).toBe(false);
  });

  it('rejects an unknown timezone', () => {
    // cron-parser accepts this at parse time and only fails inside next(),
    // so validation has to go through Intl.
    expect(isValidSchedule('*/30 * * * *', 'Mars/Olympus')).toBe(false);
  });

  it('rejects a missing timezone rather than falling back to the system zone', () => {
    expect(isValidSchedule('*/30 * * * *', undefined)).toBe(false);
    expect(isValidSchedule('*/30 * * * *', '')).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `cd Backend && npx vitest run test/unit/services/scheduler.nextRun.test.js`
Expected: FAIL — `Failed to resolve import ".../scheduler/nextRun.js"`

- [ ] **Step 4: Write the implementation**

Create `Backend/src/services/scheduler/nextRun.js`:

```js
import { CronExpressionParser } from 'cron-parser';

/** The next instant `cron` fires at in `timezone`, strictly after `from`. */
export function computeNextRun(cron, timezone, from) {
  return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone })
    .next()
    .toDate();
}

/**
 * How many slots were skipped between `scheduledFor` and `now`, excluding
 * `scheduledFor` itself — that one is about to run. `max` bounds the walk so a
 * schedule left disabled for years cannot stall a tick.
 */
export function countMissedSlots(cron, timezone, scheduledFor, now, max = 1000) {
  if (scheduledFor >= now) return 0;

  const iterator = CronExpressionParser.parse(cron, {
    currentDate: scheduledFor,
    tz: timezone,
  });

  let missed = 0;
  while (missed < max) {
    if (iterator.next().toDate() >= now) break;
    missed += 1;
  }
  return missed;
}

/** Whether this pair can be scheduled at all. Used before writing a record. */
export function isValidSchedule(cron, timezone) {
  if (typeof timezone !== 'string' || timezone.length === 0) return false;

  try {
    // cron-parser accepts an unknown timezone here and only fails later inside
    // next(), with an opaque "CronDate: unhandled timestamp". Intl rejects it
    // now, with a RangeError.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    CronExpressionParser.parse(cron, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd Backend && npx vitest run test/unit/services/scheduler.nextRun.test.js`
Expected: PASS, 12 tests

- [ ] **Step 6: Commit**

```bash
git add Backend/package.json Backend/package-lock.json \
        Backend/src/services/scheduler/nextRun.js \
        Backend/test/unit/services/scheduler.nextRun.test.js
git commit -m "feat: cron and timezone arithmetic for the scheduler"
```

---

### Task 2: `ScheduledJob` model

**Files:**
- Create: `Backend/src/models/ScheduledJob.js`
- Test: `Backend/test/unit/models/scheduledJob.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: default export `ScheduledJob` (Mongoose model) with fields `kind, targetId, workspaceId, cron, timezone, enabled, nextRunAt, lastRunAt, lastError, missedRuns, consecutiveFailures` plus timestamps.

- [ ] **Step 1: Write the failing test**

Create `Backend/test/unit/models/scheduledJob.test.js`:

```js
import { describe, it, expect } from 'vitest';
import ScheduledJob from '../../../src/models/ScheduledJob.js';

describe('ScheduledJob model', () => {
  it('applies defaults for a minimally specified schedule', async () => {
    const job = await ScheduledJob.create({
      kind: 'board_sync',
      targetId: 'board-1',
      cron: '*/30 * * * *',
      nextRunAt: new Date('2026-08-11T00:00:00Z'),
    });

    expect(job.timezone).toBe('Australia/Sydney');
    expect(job.enabled).toBe(true);
    expect(job.missedRuns).toBe(0);
    expect(job.consecutiveFailures).toBe(0);
    expect(job.lastRunAt).toBeNull();
    expect(job.lastError).toBeNull();
  });

  it('refuses a second schedule for the same kind and target', async () => {
    await ScheduledJob.create({
      kind: 'board_sync',
      targetId: 'board-dupe',
      cron: '*/30 * * * *',
      nextRunAt: new Date('2026-08-11T00:00:00Z'),
    });
    await ScheduledJob.syncIndexes();

    await expect(
      ScheduledJob.create({
        kind: 'board_sync',
        targetId: 'board-dupe',
        cron: '0 * * * *',
        nextRunAt: new Date('2026-08-11T01:00:00Z'),
      }),
    ).rejects.toThrow();
  });

  it('allows the same target under a different kind', async () => {
    await ScheduledJob.create({
      kind: 'board_sync',
      targetId: 'shared-target',
      cron: '*/30 * * * *',
      nextRunAt: new Date('2026-08-11T00:00:00Z'),
    });
    await ScheduledJob.syncIndexes();

    const other = await ScheduledJob.create({
      kind: 'invoice_issuance',
      targetId: 'shared-target',
      cron: '0 2 1 * *',
      nextRunAt: new Date('2026-09-01T00:00:00Z'),
    });

    expect(other.kind).toBe('invoice_issuance');
  });

  it('requires a cron expression and a next run time', async () => {
    await expect(
      ScheduledJob.create({ kind: 'board_sync', targetId: 'board-2' }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd Backend && npx vitest run test/unit/models/scheduledJob.test.js`
Expected: FAIL — cannot resolve `../../../src/models/ScheduledJob.js`

- [ ] **Step 3: Write the implementation**

Create `Backend/src/models/ScheduledJob.js`:

```js
import mongoose from 'mongoose';

const scheduledJobSchema = new mongoose.Schema(
  {
    // Registry key. Not an enum: kinds are registered in code, and a schema
    // enum here would mean a migration every time a feature adds one.
    kind: {
      type: String,
      required: true,
    },
    // Whatever the handler needs to identify its work — a boardId for
    // board_sync, a workspaceId for invoice_issuance. The handler interprets it.
    targetId: {
      type: String,
      required: true,
    },
    workspaceId: {
      type: String,
      default: null,
    },
    cron: {
      type: String,
      required: true,
    },
    timezone: {
      type: String,
      required: true,
      default: 'Australia/Sydney',
    },
    enabled: {
      type: Boolean,
      required: true,
      default: true,
    },
    // The claim key. Indexed with `enabled` because that pair is the only
    // query the tick makes.
    nextRunAt: {
      type: Date,
      required: true,
    },
    lastRunAt: {
      type: Date,
      default: null,
    },
    lastError: {
      type: String,
      default: null,
    },
    // Slots skipped on recovery. Alert on this being non-zero.
    missedRuns: {
      type: Number,
      default: 0,
    },
    consecutiveFailures: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

scheduledJobSchema.index({ enabled: 1, nextRunAt: 1 });
scheduledJobSchema.index({ kind: 1, targetId: 1 }, { unique: true });

export default mongoose.model('ScheduledJob', scheduledJobSchema);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd Backend && npx vitest run test/unit/models/scheduledJob.test.js`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add Backend/src/models/ScheduledJob.js Backend/test/unit/models/scheduledJob.test.js
git commit -m "feat: ScheduledJob model for the scheduler"
```

---

### Task 3: `registry.js` — kinds, handlers and delivery policy

**Files:**
- Create: `Backend/src/services/scheduler/registry.js`
- Test: `Backend/test/unit/services/scheduler.registry.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `AT_MOST_ONCE = 'at_most_once'`, `AT_LEAST_ONCE = 'at_least_once'`
  - `register(kind: string, { handler: Function, policy: string }) => void`
  - `resolve(kind: string) => { handler, policy }` — throws on unknown kind
  - `clearRegistry() => void` — test seam only
  - `registeredKinds() => string[]`

- [ ] **Step 1: Write the failing test**

Create `Backend/test/unit/services/scheduler.registry.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import {
  register,
  resolve,
  clearRegistry,
  registeredKinds,
  AT_MOST_ONCE,
  AT_LEAST_ONCE,
} from '../../../src/services/scheduler/registry.js';

describe('scheduler registry', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('resolves a registered handler and its policy', () => {
    const handler = () => 'ok';
    register('demo', { handler, policy: AT_MOST_ONCE });

    const entry = resolve('demo');
    expect(entry.handler).toBe(handler);
    expect(entry.policy).toBe(AT_MOST_ONCE);
  });

  it('throws for an unregistered kind rather than silently doing nothing', () => {
    expect(() => resolve('nope')).toThrow(/not registered/i);
  });

  it('refuses a registration with no policy', () => {
    expect(() => register('demo', { handler: () => {} })).toThrow(/policy/i);
  });

  it('refuses a registration with an unknown policy', () => {
    expect(() =>
      register('demo', { handler: () => {}, policy: 'whenever' }),
    ).toThrow(/policy/i);
  });

  it('refuses a registration with no handler', () => {
    expect(() => register('demo', { policy: AT_MOST_ONCE })).toThrow(/handler/i);
  });

  it('refuses to register the same kind twice', () => {
    register('demo', { handler: () => {}, policy: AT_LEAST_ONCE });
    expect(() =>
      register('demo', { handler: () => {}, policy: AT_LEAST_ONCE }),
    ).toThrow(/already registered/i);
  });

  it('lists what is registered', () => {
    register('a', { handler: () => {}, policy: AT_MOST_ONCE });
    register('b', { handler: () => {}, policy: AT_LEAST_ONCE });
    expect(registeredKinds().sort()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd Backend && npx vitest run test/unit/services/scheduler.registry.test.js`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Write the implementation**

Create `Backend/src/services/scheduler/registry.js`:

```js
/**
 * Delivery policy is declared here, at registration, rather than stored on the
 * schedule record — an operator editing a record must not be able to put a
 * handler under a guarantee it cannot survive.
 *
 * AT_MOST_ONCE  the schedule advances as part of the claim, before dispatch.
 *               A crash loses the slot. Correct where a duplicate is worse
 *               than a miss: issuing an invoice.
 * AT_LEAST_ONCE the schedule advances only after a successful enqueue. A crash
 *               retries the slot, and two instances may both dispatch.
 *               Correct where the handler is idempotent and a miss is worse
 *               than a repeat: board sync.
 */
export const AT_MOST_ONCE = 'at_most_once';
export const AT_LEAST_ONCE = 'at_least_once';

const POLICIES = new Set([AT_MOST_ONCE, AT_LEAST_ONCE]);

const handlers = new Map();

export function register(kind, { handler, policy } = {}) {
  if (typeof handler !== 'function') {
    throw new Error(`Scheduler: handler for "${kind}" must be a function`);
  }
  if (!POLICIES.has(policy)) {
    throw new Error(
      `Scheduler: handler for "${kind}" must declare a policy of ` +
        `"${AT_MOST_ONCE}" or "${AT_LEAST_ONCE}"`,
    );
  }
  if (handlers.has(kind)) {
    throw new Error(`Scheduler: kind "${kind}" is already registered`);
  }

  handlers.set(kind, { handler, policy });
}

export function resolve(kind) {
  const entry = handlers.get(kind);
  if (!entry) {
    throw new Error(`Scheduler: kind "${kind}" is not registered`);
  }
  return entry;
}

export function registeredKinds() {
  return [...handlers.keys()];
}

/** Test seam. Never call this from application code. */
export function clearRegistry() {
  handlers.clear();
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd Backend && npx vitest run test/unit/services/scheduler.registry.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add Backend/src/services/scheduler/registry.js \
        Backend/test/unit/services/scheduler.registry.test.js
git commit -m "feat: scheduler handler registry with per-kind delivery policy"
```

---

### Task 4: `auth.js` and `schedules.js` — credentials and the write API

**Files:**
- Create: `Backend/src/services/scheduler/auth.js`
- Create: `Backend/src/services/scheduler/schedules.js`
- Test: `Backend/test/unit/services/scheduler.schedules.test.js`

**Interfaces:**
- Consumes: `isValidSchedule`, `computeNextRun` (Task 1); `ScheduledJob` (Task 2).
- Produces:
  - `getSchedulerAuthorization() => string` — `Bearer <PERSONAL_ACCESS_TOKEN>`; throws if unset
  - `upsertSchedule({ kind, targetId, workspaceId, cron, timezone, now }) => Promise<ScheduledJob>`
  - `disableSchedule({ kind, targetId }) => Promise<ScheduledJob|null>`

- [ ] **Step 1: Write the failing test**

Create `Backend/test/unit/services/scheduler.schedules.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ScheduledJob from '../../../src/models/ScheduledJob.js';
import {
  upsertSchedule,
  disableSchedule,
} from '../../../src/services/scheduler/schedules.js';
import { getSchedulerAuthorization } from '../../../src/services/scheduler/auth.js';

const NOW = new Date('2026-08-11T04:05:00Z');

describe('getSchedulerAuthorization', () => {
  const original = process.env.PERSONAL_ACCESS_TOKEN;
  afterEach(() => {
    process.env.PERSONAL_ACCESS_TOKEN = original;
  });

  it('builds a bearer header from the personal access token', () => {
    process.env.PERSONAL_ACCESS_TOKEN = 'pat-123';
    expect(getSchedulerAuthorization()).toBe('Bearer pat-123');
  });

  it('throws when the token is missing, rather than calling ISO+ unauthenticated', () => {
    delete process.env.PERSONAL_ACCESS_TOKEN;
    expect(() => getSchedulerAuthorization()).toThrow(/PERSONAL_ACCESS_TOKEN/);
  });
});

describe('upsertSchedule', () => {
  beforeEach(() => {
    process.env.PERSONAL_ACCESS_TOKEN = 'pat-123';
  });

  it('creates a schedule with the next run computed from the cron', async () => {
    const job = await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-1',
      workspaceId: 'ws-1',
      cron: '*/30 * * * *',
      timezone: 'Australia/Sydney',
      now: NOW,
    });

    expect(job.nextRunAt.toISOString()).toBe('2026-08-11T04:30:00.000Z');
    expect(job.enabled).toBe(true);
  });

  it('updates an existing schedule instead of creating a second one', async () => {
    await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-2',
      cron: '*/30 * * * *',
      now: NOW,
    });
    const updated = await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-2',
      cron: '0 2 1 * *',
      now: NOW,
    });

    expect(updated.cron).toBe('0 2 1 * *');
    expect(await ScheduledJob.countDocuments({ targetId: 'board-2' })).toBe(1);
  });

  it('re-enables and resets failure state when a disabled schedule is upserted', async () => {
    await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-3',
      cron: '*/30 * * * *',
      now: NOW,
    });
    await ScheduledJob.updateOne(
      { kind: 'board_sync', targetId: 'board-3' },
      { $set: { enabled: false, consecutiveFailures: 4, lastError: 'boom' } },
    );

    const job = await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-3',
      cron: '*/30 * * * *',
      now: NOW,
    });

    expect(job.enabled).toBe(true);
    expect(job.consecutiveFailures).toBe(0);
    expect(job.lastError).toBeNull();
  });

  it('rejects an invalid cron expression before writing anything', async () => {
    await expect(
      upsertSchedule({
        kind: 'board_sync',
        targetId: 'board-bad',
        cron: 'not-a-cron',
        now: NOW,
      }),
    ).rejects.toThrow(/invalid schedule/i);

    expect(await ScheduledJob.countDocuments({ targetId: 'board-bad' })).toBe(0);
  });

  it('rejects an unknown timezone before writing anything', async () => {
    await expect(
      upsertSchedule({
        kind: 'board_sync',
        targetId: 'board-tz',
        cron: '*/30 * * * *',
        timezone: 'Mars/Olympus',
        now: NOW,
      }),
    ).rejects.toThrow(/invalid schedule/i);

    expect(await ScheduledJob.countDocuments({ targetId: 'board-tz' })).toBe(0);
  });
});

describe('disableSchedule', () => {
  it('disables without deleting, so history survives', async () => {
    await upsertSchedule({
      kind: 'board_sync',
      targetId: 'board-4',
      cron: '*/30 * * * *',
      now: NOW,
    });

    const job = await disableSchedule({ kind: 'board_sync', targetId: 'board-4' });
    expect(job.enabled).toBe(false);
    expect(await ScheduledJob.countDocuments({ targetId: 'board-4' })).toBe(1);
  });

  it('returns null for a schedule that does not exist', async () => {
    const job = await disableSchedule({ kind: 'board_sync', targetId: 'missing' });
    expect(job).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd Backend && npx vitest run test/unit/services/scheduler.schedules.test.js`
Expected: FAIL — cannot resolve `scheduler/schedules.js`

- [ ] **Step 3: Write `auth.js`**

Create `Backend/src/services/scheduler/auth.js`:

```js
/**
 * The scheduler has no session, so it uses the same server identity that
 * applyPrivilegedSessionAuth (src/middleware/authHelpers.js:37) already hands
 * to support_admin and owner sessions. This introduces no new credential.
 *
 * It throws rather than returning "Bearer undefined", so a misconfigured
 * environment fails at dispatch instead of making an unauthenticated call to
 * ISO+ and getting a confusing 401 back.
 */
export function getSchedulerAuthorization() {
  const token = (process.env.PERSONAL_ACCESS_TOKEN || '').trim();
  if (!token) {
    throw new Error(
      'Scheduler: PERSONAL_ACCESS_TOKEN is not set, so no job can be dispatched',
    );
  }
  return `Bearer ${token}`;
}
```

- [ ] **Step 4: Write `schedules.js`**

Create `Backend/src/services/scheduler/schedules.js`:

```js
import ScheduledJob from '../../models/ScheduledJob.js';
import { info } from '../../utils/logger.js';
import { computeNextRun, isValidSchedule } from './nextRun.js';

const DEFAULT_TIMEZONE = 'Australia/Sydney';

/**
 * The only sanctioned way to create or change a schedule. Features call this
 * from their toggle; nothing writes ScheduledJob directly.
 *
 * `now` is a parameter rather than a Date.now() call so the behaviour is
 * testable without freezing the clock.
 */
export async function upsertSchedule({
  kind,
  targetId,
  workspaceId = null,
  cron,
  timezone = DEFAULT_TIMEZONE,
  now = new Date(),
}) {
  if (!isValidSchedule(cron, timezone)) {
    throw new Error(
      `Scheduler: invalid schedule for "${kind}" — cron "${cron}", timezone "${timezone}"`,
    );
  }

  const job = await ScheduledJob.findOneAndUpdate(
    { kind, targetId },
    {
      $set: {
        workspaceId,
        cron,
        timezone,
        enabled: true,
        nextRunAt: computeNextRun(cron, timezone, now),
        lastError: null,
        consecutiveFailures: 0,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  info('Scheduler', 'Schedule upserted', {
    kind,
    targetId,
    cron,
    timezone,
    nextRunAt: job.nextRunAt,
  });

  return job;
}

/** Disable rather than delete, so lastRunAt and missedRuns survive. */
export async function disableSchedule({ kind, targetId }) {
  const job = await ScheduledJob.findOneAndUpdate(
    { kind, targetId },
    { $set: { enabled: false } },
    { new: true },
  );

  if (job) {
    info('Scheduler', 'Schedule disabled', { kind, targetId });
  }

  return job;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd Backend && npx vitest run test/unit/services/scheduler.schedules.test.js`
Expected: PASS, 9 tests (erratum 6: the plan originally said 10)

- [ ] **Step 6: Commit**

```bash
git add Backend/src/services/scheduler/auth.js \
        Backend/src/services/scheduler/schedules.js \
        Backend/test/unit/services/scheduler.schedules.test.js
git commit -m "feat: scheduler credentials and schedule write API"
```

---

### Task 5: `outcome.js` — recording what happened, per policy

Split from `tick.js` so neither function approaches the complexity gate.

**Files:**
- Create: `Backend/src/services/scheduler/outcome.js`
- Test: `Backend/test/unit/services/scheduler.outcome.test.js`

**Interfaces:**
- Consumes: `computeNextRun`, `countMissedSlots` (Task 1); `ScheduledJob` (Task 2); `AT_LEAST_ONCE` (Task 3).
- Produces:
  - `MAX_CONSECUTIVE_FAILURES = 5`
  - `recordSuccess(job, policy, now) => Promise<void>`
  - `recordFailure(job, policy, err, now) => Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `Backend/test/unit/services/scheduler.outcome.test.js`:

```js
import { describe, it, expect } from 'vitest';
import ScheduledJob from '../../../src/models/ScheduledJob.js';
import {
  recordSuccess,
  recordFailure,
  MAX_CONSECUTIVE_FAILURES,
} from '../../../src/services/scheduler/outcome.js';
import {
  AT_MOST_ONCE,
  AT_LEAST_ONCE,
} from '../../../src/services/scheduler/registry.js';

const NOW = new Date('2026-08-11T04:05:00Z');

async function makeJob(overrides = {}) {
  return ScheduledJob.create({
    kind: 'demo',
    targetId: `t-${Math.random().toString(16).slice(2)}`,
    cron: '*/30 * * * *',
    timezone: 'Australia/Sydney',
    nextRunAt: new Date('2026-08-11T04:00:00Z'),
    ...overrides,
  });
}

describe('recordSuccess', () => {
  it('clears failure state under at-most-once without touching nextRunAt', async () => {
    // The claim already advanced it; recording success must not advance twice.
    const job = await makeJob({ consecutiveFailures: 3, lastError: 'old' });
    const claimedNextRunAt = job.nextRunAt;

    await recordSuccess(job, AT_MOST_ONCE, NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.consecutiveFailures).toBe(0);
    expect(fresh.lastError).toBeNull();
    expect(fresh.nextRunAt.toISOString()).toBe(claimedNextRunAt.toISOString());
  });

  it('advances nextRunAt under at-least-once, because the claim did not', async () => {
    const job = await makeJob();

    await recordSuccess(job, AT_LEAST_ONCE, NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.nextRunAt.toISOString()).toBe('2026-08-11T04:30:00.000Z');
    expect(fresh.lastRunAt.toISOString()).toBe(NOW.toISOString());
  });
});

describe('recordFailure', () => {
  it('records the error and counts it under at-most-once, losing the slot', async () => {
    const job = await makeJob();
    const claimedNextRunAt = job.nextRunAt;

    await recordFailure(job, AT_MOST_ONCE, new Error('enqueue failed'), NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.lastError).toContain('enqueue failed');
    expect(fresh.consecutiveFailures).toBe(1);
    expect(fresh.nextRunAt.toISOString()).toBe(claimedNextRunAt.toISOString());
    expect(fresh.enabled).toBe(true);
  });

  it('leaves nextRunAt alone under at-least-once so the next tick retries', async () => {
    const job = await makeJob();
    const dueAt = job.nextRunAt;

    await recordFailure(job, AT_LEAST_ONCE, new Error('boom'), NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.nextRunAt.toISOString()).toBe(dueAt.toISOString());
    expect(fresh.consecutiveFailures).toBe(1);
  });

  it('advances anyway once at-least-once has failed too many times in a row', async () => {
    // Without this the slot would be retried on every tick forever, occupying
    // a place in the batch cap.
    const job = await makeJob({
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1,
    });

    await recordFailure(job, AT_LEAST_ONCE, new Error('still broken'), NOW);

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(fresh.nextRunAt.toISOString()).toBe('2026-08-11T04:30:00.000Z');
    expect(fresh.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd Backend && npx vitest run test/unit/services/scheduler.outcome.test.js`
Expected: FAIL — cannot resolve `scheduler/outcome.js`

- [ ] **Step 3: Write the implementation**

Create `Backend/src/services/scheduler/outcome.js`:

```js
import ScheduledJob from '../../models/ScheduledJob.js';
import { error as logError } from '../../utils/logger.js';
import { computeNextRun } from './nextRun.js';
import { AT_LEAST_ONCE } from './registry.js';

/**
 * How many consecutive failures an at-least-once schedule may accumulate
 * before it stops being retried on every tick and is advanced to its next slot
 * instead. Bounds a permanently broken handler without disabling a schedule
 * that may only be temporarily wrong.
 */
export const MAX_CONSECUTIVE_FAILURES = 5;

export async function recordSuccess(job, policy, now) {
  const update = {
    $set: { lastError: null, consecutiveFailures: 0, lastRunAt: now },
  };

  // Under at-most-once the claim already advanced nextRunAt. Advancing again
  // here would skip a slot.
  if (policy === AT_LEAST_ONCE) {
    update.$set.nextRunAt = computeNextRun(job.cron, job.timezone, now);
  }

  await ScheduledJob.updateOne({ _id: job._id }, update);
}

export async function recordFailure(job, policy, err, now) {
  const failures = (job.consecutiveFailures || 0) + 1;
  const update = {
    $set: { lastError: String(err?.message || err), consecutiveFailures: failures },
  };

  // At-least-once normally leaves nextRunAt alone so the next tick retries the
  // same slot. Once it has failed this many times running, give up on the slot
  // rather than retrying it every minute indefinitely.
  if (policy === AT_LEAST_ONCE && failures >= MAX_CONSECUTIVE_FAILURES) {
    update.$set.nextRunAt = computeNextRun(job.cron, job.timezone, now);
  }

  await ScheduledJob.updateOne({ _id: job._id }, update);

  logError('Scheduler', 'Dispatch failed', {
    kind: job.kind,
    targetId: job.targetId,
    policy,
    consecutiveFailures: failures,
    advanced: Boolean(update.$set.nextRunAt),
    error: String(err?.message || err),
  });
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd Backend && npx vitest run test/unit/services/scheduler.outcome.test.js`
Expected: PASS, 5 tests (erratum 6: the plan originally said 6)

- [ ] **Step 5: Commit**

```bash
git add Backend/src/services/scheduler/outcome.js \
        Backend/test/unit/services/scheduler.outcome.test.js
git commit -m "feat: per-policy outcome recording for the scheduler"
```

---

### Task 6: `tick.js` — claim and dispatch

**Files:**
- Create: `Backend/src/services/scheduler/tick.js`
- Test: `Backend/test/unit/services/scheduler.tick.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces:
  - `BATCH_LIMIT = 100`
  - `runTick({ now?: Date, limit?: number }) => Promise<{ claimed, dispatched, failed, capped }>`

**Note on the claim loop:** under `AT_LEAST_ONCE` the claim does *not* advance `nextRunAt`, so the same document would be returned by the next `findOne` and the loop would spin. The loop therefore excludes ids it has already processed in this tick via `$nin`. Across separate ticks or instances a duplicate is still possible — that is what at-least-once means.

- [ ] **Step 1: Write the failing test**

Create `Backend/test/unit/services/scheduler.tick.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ScheduledJob from '../../../src/models/ScheduledJob.js';
import { runTick } from '../../../src/services/scheduler/tick.js';
import {
  register,
  clearRegistry,
  AT_MOST_ONCE,
  AT_LEAST_ONCE,
} from '../../../src/services/scheduler/registry.js';

const NOW = new Date('2026-08-11T04:05:00Z');

async function due(kind, overrides = {}) {
  return ScheduledJob.create({
    kind,
    targetId: `t-${Math.random().toString(16).slice(2)}`,
    cron: '*/30 * * * *',
    timezone: 'Australia/Sydney',
    nextRunAt: new Date('2026-08-11T04:00:00Z'),
    ...overrides,
  });
}

describe('runTick', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('dispatches a due schedule and reports it', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    register('demo', { handler, policy: AT_MOST_ONCE });
    const job = await due('demo', { workspaceId: 'ws-1' });

    const summary = await runTick({ now: NOW });

    expect(summary).toEqual({
      claimed: 1,
      dispatched: 1,
      failed: 0,
      capped: false,
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: job.targetId, workspaceId: 'ws-1' }),
    );
  });

  it('ignores schedules that are not yet due', async () => {
    register('demo', { handler: vi.fn(), policy: AT_MOST_ONCE });
    await due('demo', { nextRunAt: new Date('2026-08-11T09:00:00Z') });

    const summary = await runTick({ now: NOW });
    expect(summary.claimed).toBe(0);
  });

  it('ignores disabled schedules', async () => {
    register('demo', { handler: vi.fn(), policy: AT_MOST_ONCE });
    await due('demo', { enabled: false });

    const summary = await runTick({ now: NOW });
    expect(summary.claimed).toBe(0);
  });

  it('advances an at-most-once schedule before dispatching, so a crash loses the slot', async () => {
    let nextRunAtDuringDispatch;
    register('demo', {
      policy: AT_MOST_ONCE,
      handler: async ({ targetId }) => {
        const row = await ScheduledJob.findOne({ targetId });
        nextRunAtDuringDispatch = row.nextRunAt;
      },
    });
    await due('demo');

    await runTick({ now: NOW });

    expect(nextRunAtDuringDispatch.toISOString()).toBe('2026-08-11T04:30:00.000Z');
  });

  it('does not advance an at-least-once schedule until the handler succeeds', async () => {
    let nextRunAtDuringDispatch;
    register('demo', {
      policy: AT_LEAST_ONCE,
      handler: async ({ targetId }) => {
        const row = await ScheduledJob.findOne({ targetId });
        nextRunAtDuringDispatch = row.nextRunAt;
      },
    });
    const job = await due('demo');

    await runTick({ now: NOW });

    expect(nextRunAtDuringDispatch.toISOString()).toBe(job.nextRunAt.toISOString());
    const after = await ScheduledJob.findById(job._id);
    expect(after.nextRunAt.toISOString()).toBe('2026-08-11T04:30:00.000Z');
  });

  it('records missed slots when the schedule was due long ago', async () => {
    register('demo', { handler: vi.fn(), policy: AT_MOST_ONCE });
    const job = await due('demo', { nextRunAt: new Date('2026-08-11T01:00:00Z') });

    await runTick({ now: NOW });

    const fresh = await ScheduledJob.findById(job._id);
    expect(fresh.missedRuns).toBe(6);
  });

  it('counts a throwing handler as failed without stopping the tick', async () => {
    register('bad', {
      handler: vi.fn().mockRejectedValue(new Error('nope')),
      policy: AT_MOST_ONCE,
    });
    register('good', { handler: vi.fn(), policy: AT_MOST_ONCE });
    await due('bad');
    await due('good');

    const summary = await runTick({ now: NOW });

    expect(summary.claimed).toBe(2);
    expect(summary.dispatched).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it('counts an unregistered kind as failed rather than throwing out of the tick', async () => {
    await due('never_registered');

    const summary = await runTick({ now: NOW });

    expect(summary.failed).toBe(1);
  });

  it('reports when it hits the batch cap instead of truncating silently', async () => {
    register('demo', { handler: vi.fn(), policy: AT_MOST_ONCE });
    await Promise.all([due('demo'), due('demo'), due('demo')]);

    const summary = await runTick({ now: NOW, limit: 2 });

    expect(summary.claimed).toBe(2);
    expect(summary.capped).toBe(true);
  });

  it('does not re-process an at-least-once schedule within the same tick', async () => {
    // It is not advanced at claim time, so without exclusion the loop would
    // pick the same document up again and spin.
    const handler = vi.fn();
    register('demo', { handler, policy: AT_LEAST_ONCE });
    await due('demo');

    const summary = await runTick({ now: NOW });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(summary.claimed).toBe(1);
  });

  it('lets only one caller claim an at-most-once schedule', async () => {
    register('demo', { handler: vi.fn(), policy: AT_MOST_ONCE });
    await due('demo');

    const [a, b] = await Promise.all([
      runTick({ now: NOW }),
      runTick({ now: NOW }),
    ]);

    expect(a.claimed + b.claimed).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd Backend && npx vitest run test/unit/services/scheduler.tick.test.js`
Expected: FAIL — cannot resolve `scheduler/tick.js`

- [ ] **Step 3: Write the implementation**

Create `Backend/src/services/scheduler/tick.js`:

```js
import ScheduledJob from '../../models/ScheduledJob.js';
import { info, warn } from '../../utils/logger.js';
import { computeNextRun, countMissedSlots } from './nextRun.js';
import { resolve, AT_MOST_ONCE } from './registry.js';
import { recordSuccess, recordFailure } from './outcome.js';

export const BATCH_LIMIT = 100;

/**
 * Take the next due schedule, if any.
 *
 * Under at-most-once the claim is a compare-and-swap on the nextRunAt we just
 * read: if another instance got there first the value has changed, the update
 * matches nothing, and we move on. The claimed row's nextRunAt is now in the
 * future so it drops out of the query.
 *
 * Under at-least-once nextRunAt is deliberately left alone until the handler
 * succeeds, so the caller must exclude what it has already seen.
 */
async function claimNext(now, excludeIds) {
  for (;;) {
    const candidate = await ScheduledJob.findOne({
      enabled: true,
      nextRunAt: { $lte: now },
      _id: { $nin: excludeIds },
    })
      .sort({ nextRunAt: 1 })
      .lean();

    if (!candidate) return null;

    let policy = AT_MOST_ONCE;
    try {
      ({ policy } = resolve(candidate.kind));
    } catch {
      // Unknown kind: claim it anyway so it is counted and recorded, rather
      // than being selected again on every iteration of this loop.
    }

    if (policy !== AT_MOST_ONCE) return candidate;

    const claimed = await ScheduledJob.findOneAndUpdate(
      { _id: candidate._id, nextRunAt: candidate.nextRunAt },
      {
        $set: {
          nextRunAt: computeNextRun(candidate.cron, candidate.timezone, now),
          lastRunAt: now,
        },
        $inc: {
          missedRuns: countMissedSlots(
            candidate.cron,
            candidate.timezone,
            candidate.nextRunAt,
            now,
          ),
        },
      },
      { new: true, lean: true },
    );

    if (claimed) return claimed;

    // Another caller claimed it between the read and the update. Skip it for
    // the rest of this tick and try the next candidate — do NOT stop here, or
    // one lost race would abandon every remaining due schedule.
    excludeIds.push(candidate._id);
  }
}

async function dispatch(job, now) {
  const { handler, policy } = resolve(job.kind);
  await handler({
    kind: job.kind,
    targetId: job.targetId,
    workspaceId: job.workspaceId,
    scheduledFor: job.nextRunAt,
  });
  await recordSuccess(job, policy, now);
}

/** Claim every due schedule, up to `limit`, and dispatch each one. */
export async function runTick({ now = new Date(), limit = BATCH_LIMIT } = {}) {
  // Two lists, deliberately. `excludeIds` also collects rows we lost a race
  // for, which must not count towards the batch cap or the claimed total.
  const excludeIds = [];
  const claimedIds = [];
  let dispatched = 0;
  let failed = 0;

  while (claimedIds.length < limit) {
    const job = await claimNext(now, excludeIds);
    if (!job) break;

    claimedIds.push(job._id);
    excludeIds.push(job._id);

    try {
      await dispatch(job, now);
      dispatched += 1;
    } catch (err) {
      failed += 1;
      let policy = AT_MOST_ONCE;
      try {
        ({ policy } = resolve(job.kind));
      } catch {
        // Unknown kind — recorded against the row below with the default policy.
      }
      await recordFailure(job, policy, err, now);
    }
  }

  // Conservative: this is true when the cap was reached, even if nothing was
  // actually left over. Over-reporting a cap is safe; under-reporting one is
  // the silent truncation this design forbids.
  const capped = claimedIds.length >= limit;
  if (capped) {
    warn('Scheduler', 'Batch cap reached; remaining schedules wait for the next tick', {
      limit,
    });
  }

  const summary = { claimed: claimedIds.length, dispatched, failed, capped };
  info('Scheduler', 'Tick complete', summary);
  return summary;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd Backend && npx vitest run test/unit/services/scheduler.tick.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add Backend/src/services/scheduler/tick.js \
        Backend/test/unit/services/scheduler.tick.test.js
git commit -m "feat: scheduler tick with atomic claim and per-policy dispatch"
```

---

### Task 7: The route, the mount, and the `board_sync` handler

**Files:**
- Create: `Backend/src/routes/scheduler.js`
- Create: `Backend/src/services/scheduler/handlers.js`
- Modify: `Backend/src/app.js` (imports near line 24; mount near line 125)
- Test: `Backend/test/integration/scheduler.route.test.js`

**Interfaces:**
- Consumes: `runTick` (Task 6), `register`/`AT_LEAST_ONCE` (Task 3), `getSchedulerAuthorization` (Task 4), `triggerManualSync` from `src/services/sync.js` (existing, unchanged).
- Produces: `POST /api/scheduler/tick`.

**Scope note:** registering `board_sync` here is the minimum needed to prove the mechanism end to end and is ~8 lines calling the existing manual-sync path. Everything beyond that registration — deciding which boards get schedules, and the UI for it — remains Arnold's board-sync automation work. **Confirm with Arnold before starting this task** so the registration is not written twice.

- [ ] **Step 1: Write the failing test**

Create `Backend/test/integration/scheduler.route.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import ScheduledJob from '../../src/models/ScheduledJob.js';
import {
  register,
  clearRegistry,
  AT_MOST_ONCE,
} from '../../src/services/scheduler/registry.js';

const app = createApp();

describe('POST /api/scheduler/tick', () => {
  beforeEach(() => {
    clearRegistry();
    process.env.Admin_API_Key = 'test-admin-key';
  });

  it('rejects a request with no credential', async () => {
    const res = await request(app).post('/api/scheduler/tick');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong credential', async () => {
    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('rejects the key with a Bearer prefix, which is the likely misconfiguration', async () => {
    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'Bearer test-admin-key');
    expect(res.status).toBe(401);
  });

  it('dispatches due schedules and returns a summary', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    register('demo', { handler, policy: AT_MOST_ONCE });
    await ScheduledJob.create({
      kind: 'demo',
      targetId: 'target-1',
      cron: '*/30 * * * *',
      timezone: 'Australia/Sydney',
      nextRunAt: new Date('2000-01-01T00:00:00Z'),
    });

    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ claimed: 1, dispatched: 1, failed: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('returns a zero summary when nothing is due', async () => {
    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd Backend && npx vitest run test/integration/scheduler.route.test.js`
Expected: FAIL — 404 rather than 401/200, because nothing is mounted yet

- [ ] **Step 3: Write the route**

Create `Backend/src/routes/scheduler.js`:

```js
import express from 'express';

import { validateApiKey } from '../middleware/auth.js';
import { error as logError } from '../utils/logger.js';
import { runTick } from '../services/scheduler/tick.js';

const router = express.Router();

/**
 * Driven by an EventBridge rule in AWS and by `npm run tick` locally. Thin by
 * design: everything it does is in services/scheduler/tick.js.
 */
router.post('/tick', validateApiKey, async (req, res) => {
  try {
    const summary = await runTick({ now: new Date() });
    res.json(summary);
  } catch (err) {
    logError(
      'Scheduler',
      'Tick failed',
      { message: err.message, stack: err.stack },
      req ?? null,
    );
    res.status(500).json({ error: 'Scheduler tick failed' });
  }
});

export default router;
```

- [ ] **Step 4: Write the handler registration**

Create `Backend/src/services/scheduler/handlers.js`:

```js
import { triggerManualSync } from '../sync.js';
import { getSchedulerAuthorization } from './auth.js';
import { register, AT_LEAST_ONCE } from './registry.js';

/**
 * Imported for its side effects at boot. Each feature registers one handler.
 *
 * A handler enqueues and returns — it must never await the work itself, or a
 * tick stops being bounded.
 */
export function registerSchedulerHandlers() {
  // At-least-once: triggerManualSync is idempotent (SyncExecution.hasRunningSync
  // and checkActiveQueueJob both refuse a second concurrent sync on a board),
  // so a repeat is harmless while a silent skip only makes data staler.
  register('board_sync', {
    policy: AT_LEAST_ONCE,
    handler: ({ targetId, workspaceId }) =>
      triggerManualSync(getSchedulerAuthorization(), workspaceId, targetId),
  });
}
```

- [ ] **Step 5: Mount the router**

In `Backend/src/app.js`, add the import beside the other route imports (after the `subscriptionRoutes` import, around line 24):

```js
import schedulerRoutes from './routes/scheduler.js';
```

and the mount beside the others (after the `/api/subscriptions` mount, around line 125):

```js
  app.use('/api/scheduler', schedulerRoutes);
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `cd Backend && npx vitest run test/integration/scheduler.route.test.js`
Expected: PASS, 5 tests

- [ ] **Step 7: Run the whole suite to check nothing regressed**

Run: `cd Backend && npm test`
Expected: PASS. Compare the total against the count before this branch; only the new tests should be added.

- [ ] **Step 8: Commit**

```bash
git add Backend/src/routes/scheduler.js \
        Backend/src/services/scheduler/handlers.js \
        Backend/src/app.js \
        Backend/test/integration/scheduler.route.test.js
git commit -m "feat: scheduler tick endpoint and board_sync handler registration"
```

---

### Task 8: `npm run tick` — the local EventBridge stand-in

Masoud asked for this specifically so the feature can be driven without AWS.

**Files:**
- Create: `scripts/lib/tick.mjs`
- Modify: `scripts/dev.mjs` (command dispatch near line 726; usage text near line 744)
- Modify: `package.json` (root, `scripts` block)

**Interfaces:**
- Consumes: `readEnv`, `parseEnv` from `scripts/lib/env.mjs` (existing).
- Produces: `npm run tick`, `npm run tick -- --once`, `npm run tick -- --every <seconds>`, `npm run tick -- --url <url>`.

**Constraint:** no dependencies, Node only, cross-platform. Uses global `fetch` (Node 18+; this repo runs Node 22).

- [ ] **Step 1: Write the config resolver and loop**

Create `scripts/lib/tick.mjs`:

```js
// A local stand-in for the EventBridge rule. Calls the same endpoint on an
// interval so the scheduler is developable with no AWS account.
//
// This is a developer tool, not a fallback inside the application: the app
// deliberately has no timer in it, because one would fire once per Elastic
// Beanstalk instance.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseEnv, readEnv } from './env.mjs'

/** Where to tick, and with what credential. Pure apart from reading the files. */
export function tickConfig(root, overrides = {}) {
  const env = readEnv(root)
  const backendEnvPath = join(root, 'Backend', '.env')
  const backendEnv = existsSync(backendEnvPath)
    ? parseEnv(readFileSync(backendEnvPath, 'utf8'))
    : {}

  return {
    url:
      overrides.url ||
      `http://localhost:${env.BACKEND_PORT}/api/scheduler/tick`,
    key: overrides.key || backendEnv.Admin_API_Key || '',
  }
}

/** One call. Returns a line to print. */
export async function tickOnce({ url, key }) {
  const started = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: key },
  })
  const ms = Date.now() - started

  if (!res.ok) {
    const body = await res.text()
    return `${res.status} ${res.statusText} (${ms}ms) ${body.slice(0, 200)}`
  }

  const summary = await res.json()
  return (
    `claimed=${summary.claimed} dispatched=${summary.dispatched} ` +
    `failed=${summary.failed}${summary.capped ? ' CAPPED' : ''} (${ms}ms)`
  )
}
```

- [ ] **Step 2: Wire the subcommand**

In `scripts/dev.mjs`, add a `tick` command alongside the others. Add the import at the top with the other `./lib/` imports:

```js
import { tickConfig, tickOnce } from './lib/tick.mjs'
```

Add the command function:

```js
async function tick(args) {
  const { flags } = parseArgs(args)

  if (flags['--help']) {
    console.log(`usage: node scripts/dev.mjs tick [options]

Calls the scheduler endpoint on an interval — a local stand-in for the
EventBridge rule. Reads the port from .env and Admin_API_Key from Backend/.env.

  --once            call once and exit
  --every <secs>    interval between calls (default 60)
  --url <url>       override the endpoint
`)
    return
  }

  const config = tickConfig(process.cwd(), { url: flags['--url'] })

  if (!config.key) {
    console.error('Admin_API_Key is not set in Backend/.env — the endpoint will answer 401')
  }

  const run = async () => {
    try {
      console.log(`[${new Date().toISOString()}] ${await tickOnce(config)}`)
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ${err.message}`)
    }
  }

  await run()
  if (flags['--once']) return

  const seconds = Number(flags['--every'] || 60)
  console.log(`ticking ${config.url} every ${seconds}s — Ctrl-C to stop`)
  setInterval(run, seconds * 1000)
}
```

Add `'--every'` and `'--url'` to the `VALUE_FLAGS` set near line 342, register `tick` in the command dispatch near line 726, and add a usage line near line 744:

```
  tick [--once] [--every 60]                          drive the scheduler locally
```

- [ ] **Step 3: Add the npm script**

In the root `package.json`, inside `scripts`:

```json
    "tick": "node scripts/dev.mjs tick",
```

- [ ] **Step 4: Verify it runs and reports a clear failure with nothing listening**

Run: `npm run tick -- --once`
Expected: a single line. With the stack down, an error mentioning `ECONNREFUSED`. With the stack up (`npm run dev:up`), `claimed=0 dispatched=0 failed=0`.

- [ ] **Step 5: Verify against the running stack**

```bash
npm run dev:up
npm run tick -- --once
```
Expected: `claimed=0 dispatched=0 failed=0 (Nms)`

Then confirm the interval form starts and prints repeatedly, and Ctrl-C stops it:

```bash
npm run tick -- --every 5
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/tick.mjs scripts/dev.mjs package.json
git commit -m "feat: npm run tick, a local stand-in for the EventBridge rule"
```

---

### Task 9: `docs/scheduling.md` — the ops reference

The AWS rule cannot be verified by merging, so it must be written down rather than remembered. Masoud is setting it up.

**Files:**
- Create: `docs/scheduling.md`
- Modify: `CLAUDE.md` (add to the reference-material list in "Documentation layout")

- [ ] **Step 1: Write the document**

Create `docs/scheduling.md` covering, at minimum:

- What the scheduler does and, explicitly, what it does not do (it never performs work).
- The endpoint, its auth, and its response shape.
- **The EventBridge rule**, as a table of exact values: `rate(1 minute)`; target API Destination; `POST https://<env-host>/api/scheduler/tick`; Connection auth type API key; header name `Authorization`; header value the environment's `Admin_API_Key` **verbatim, with no `Bearer ` prefix** — `validateApiKey` compares the raw header with `!==`, so a prefix or stray whitespace is a 401.
- That dev and prod need separate rules, hosts and keys, and that a rule pointed at the wrong environment is undetectable from inside the application because both answer 200.
- Running it locally: `npm run tick`, `--once`, `--every`.
- How a feature registers a handler, with the `board_sync` registration as the worked example, and the four handler rules (declare a policy, enqueue and return, be idempotent for the period, throw on failure).
- The two policies and when to choose each.
- What to alert on: `missedRuns > 0`, `consecutiveFailures > 0`, and `lastRunAt` not advancing.

- [ ] **Step 2: Add it to the CLAUDE.md reference list**

In `CLAUDE.md`, in the "Documentation layout" section, add `docs/scheduling.md` to the sentence listing reference material that stays current.

- [ ] **Step 3: Commit**

```bash
git add docs/scheduling.md CLAUDE.md
git commit -m "docs: scheduling reference for the EventBridge rule and handlers"
```

---

### Task 10: Full verification before the PR

- [ ] **Step 1: Run the whole backend suite**

Run: `cd Backend && npm test`
Expected: PASS. Capture the real output — the PR description needs it, and "tested locally" is not acceptable evidence in this repo.

- [ ] **Step 2: Check the complexity gate**

Run: `cd Backend && npx eslint --no-eslintrc -c .eslintrc.complexity.cjs src/services/scheduler/ src/routes/scheduler.js`
Expected: no S3776 violations. If one appears, extract a helper rather than nesting further.

- [ ] **Step 3: Verify end to end against the running stack**

```bash
npm run dev:up
curl -s localhost:4001/api/healthcheck            # {"status":"OK"}
npm run tick -- --once                            # claimed=0 dispatched=0 failed=0
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4001/api/scheduler/tick   # 401
```

The third command is the one worth keeping in the PR: it proves the endpoint is not open.

- [ ] **Step 4: Confirm the branch is current**

```bash
git fetch origin
git tag -f backup/pre-rebase-KAN-15 HEAD
git rebase origin/develop
git diff backup/pre-rebase-KAN-15 HEAD    # MUST be empty
cd Backend && npm test
git push --force-with-lease
```

Step 4's diff check is the one people skip and the one that makes the force-push safe.

- [ ] **Step 5: Open the PR**

Target `develop`. Include, in this order: Summary; Ticket KAN-15; What's included; **Blast radius** (additive only — one new collection, one new route, one new script; no existing route, response shape or stored data changes; no change to the queue, the worker, auth, PDF generation or Xero); New dependencies (`cron-parser`, and why); Migrations (none — the collection is new, nothing to backfill); Verification (the actual command output from Steps 1–3); Follow-ups.

**Follow-ups to list:** the EventBridge rule is a manual step in each environment and is not created by this PR; `Admin_API_Key` is shared with other routes, so rotating it affects both; no UI for editing schedules; `invoice_issuance` has no handler yet.

---

## Notes for the reviewer

**Where this is most likely to be wrong:** the cron arithmetic. That is why Task 1 is first, is pure, and carries the DST and month-boundary cases as verified constants rather than computed expectations.

**Two behaviours that look like bugs and are not:**

1. Under `AT_MOST_ONCE`, `nextRunAt` is advanced *before* the handler runs. A crash between claim and enqueue loses that slot. This is deliberate — a duplicated NDIS invoice is a client-facing incident, a lost run is visible in `missedRuns` and recoverable by hand.
2. Under `AT_LEAST_ONCE`, two instances can dispatch the same slot. Also deliberate, and why the handler contract requires idempotency.

**The one thing merging cannot verify** is the EventBridge rule. If schedules never fire in an environment, check that first — nothing in the application will report an error, because from its side nothing is happening.
