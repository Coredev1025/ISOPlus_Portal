# Scheduled job trigger — EventBridge to the existing queue

**Date:** 2026-08-11
**Status:** Implemented — see "Changes since approval" below.
**Ticket:** KAN-15
**Blocked on:** Arnold's invoice/statement toggle merging to `develop`. The
branch for this work is cut from `origin/develop` after that lands.

## Changes since approval

Recorded rather than silently rewritten, per the convention in
[`CLAUDE.md`](../../../CLAUDE.md). The implementation plan carries the full list
in its errata table; these are the ones that change what this document says.

| Designed | Shipped | Why |
|---|---|---|
| The router is mounted in `src/app.js`. | Mounted in **both** `src/app.js` and `src/index.js`, with `registerSchedulerHandlers()` called at boot in `index.js`. | `index.js` is the production entry point and does not use `createApp()`; they are parallel express apps. Mounting only in `app.js` gave an endpoint that existed in tests and 404'd in production while the entire suite passed. |
| `recordFailure` stores `String(err?.message ǀǀ err)`. | A `describeError` helper handling `Error`, string and other values, with a `try/catch` around `JSON.stringify` for circular structures. | The original stored `"[object Object]"` for a non-`Error` throw, making `lastError` useless to the operator it exists for. |
| **No auto-disable** (see "Failure" below) — `enabled` is never flipped off by the scheduler itself. | Still true for a **failing handler**, which is what that rule is about. One narrower case does disable: a schedule whose own next slot cannot be computed, because its `cron`/`timezone` will not parse. | Raised in review on PR #855. That row is not "failing loudly forever", it is unselectable — advancing it requires parsing the very expression that does not parse, so it can never run again and is re-read and re-failed on every tick indefinitely. Disabling is non-destructive (`lastError`, `lastRunAt`, `missedRuns`, `consecutiveFailures` all survive) and `upsertSchedule` re-enables, so the loudness is preserved without the loop. Only reachable by writing to the collection directly, past both the model validators and `upsertSchedule`. |
| "No migration and no backfill" — the collection is new, so Mongoose builds its indexes on connect. | Still no backfill, but a migration **is** included: `Backend/migrations/1786439847318-add-scheduled-job-indexes.js`. | Index creation was a side effect of application boot via `autoIndex`, which defaults to true. The unique constraint on `{ kind, targetId }` is what stops a toggle flipped twice creating two schedules for one board; leaving it dependent on a setting someone may disable for performance made it silently droppable. The migration is idempotent — `createIndex` no-ops when the index already matches. |

Two claims in this document need qualifying:

- **"there is no `node-cron`, no `agenda`"** — true, but `node-schedule` **is** a
  declared dependency in `Backend/package.json`. It is unused in `src/`. It was
  not adopted because an in-process timer fires once per Elastic Beanstalk
  instance, which is exactly the double-dispatch this design avoids.
- **`missedRuns` is described as the general signal for a skipped slot.** It is
  incremented only on the `AT_MOST_ONCE` claim path, so it is permanently zero
  for `AT_LEAST_ONCE` schedules such as `board_sync`. `lastRunAt` staleness is
  the signal for those. Documented in `docs/scheduling.md`; counting missed
  slots for at-least-once schedules is left as a follow-up.

## Problem

Two features need work to start on a schedule rather than on a click:

- automated issuance of NDIS invoices and monthly statements, and
- background board sync, which today runs only from a user action or a webhook.

The proposal on the table was
`EventBridge → Lambda → SQS → Lambda → DB`. It was rejected after reading what
the backend already has, and the reason is the whole justification for this
design:

**We already own the worker half.** `board-sync` is a BullMQ queue on
ElastiCache Serverless (`Backend/src/services/sync/queue.js`) with
`attempts: 3`, exponential backoff, completed jobs retained 24h and failed 7d,
a worker at `concurrency: 2` started on boot, and Bull Board at `/api/queues`.
SQS plus a worker Lambda would re-implement that, not add to it.

What is genuinely missing is a clock. Nothing in the codebase fires on a
schedule: there is no `node-cron`, no `agenda`, and no repeatable-job usage
anywhere in `Backend/src`.

The cost of the full Lambda route, for the record, is that the work is not
portable. Invoice and statement generation runs through `@pdfme` with JSON
templates in `src/assets/`, then Xero, then S3; sync is a 749-line worker plus
the ISO+ client. Moving either into Lambda means duplicating that code or
extracting a shared package, adding a service-auth path because the current flow
expects a session, and extending CI/CD beyond Elastic Beanstalk. That is a
backend restructure, and it is the right shape only if we outgrow the EB app.

## Goal

Add the clock, and nothing else. One HTTP endpoint that any external scheduler
can call, a per-record schedule in Mongo, and a registry so each feature plugs
in a handler without touching the other's code.

**Success criterion:** Arnold can register `board_sync` and Allan can register
`invoice_issuance` independently, and neither needs to modify the scheduler.

## Architecture

The scheduler decides *when*, and nothing else. It never calls ISO+, never
generates a PDF, never touches Xero. It claims a due record and enqueues into
the queue that already exists. Every tick is milliseconds of Mongo and Redis
writes.

```
EventBridge (rate: 1 minute)
      │
      ▼
POST /api/scheduler/tick            validateApiKey (Admin_API_Key)
      │
      ├─ claim due ScheduledJob docs, atomically
      ├─ dispatch each to its registered handler
      └─ handler enqueues into BullMQ ─────► existing syncWorker
```

| File | Responsibility |
|---|---|
| `src/routes/scheduler.js` | Thin. Parse, call the service, respond. |
| `src/services/scheduler/tick.js` | Claim → dispatch → summarise. |
| `src/services/scheduler/outcome.js` | Recording success and failure per policy. Split out to keep `tick.js` under the complexity gate. |
| `src/services/scheduler/handlers.js` | Where features register. Imported for its side effects at boot. |
| `src/services/scheduler/registry.js` | `kind` → `{ handler, policy }` map. |
| `src/services/scheduler/schedules.js` | `upsertSchedule` / `disableSchedule` — the only sanctioned writers of `ScheduledJob`. What Arnold's toggle and the invoice config call. |
| `src/services/scheduler/nextRun.js` | Cron + timezone → next slot; missed-slot count. Pure. |
| `src/services/scheduler/auth.js` | `getSchedulerAuthorization()`. |
| `src/models/ScheduledJob.js` | Mongoose schema. |
| `scripts/dev.mjs tick` | Local stand-in for EventBridge. Not application code — see below. |

Four files rather than one because the cognitive-complexity gate (SonarJS
S3776, < 15) will not survive claim plus cron arithmetic plus dispatch plus
error accounting in a single function. `nextRun.js` is pure — no I/O, no module
state — which is what makes the DST cases cheap to test.

## Data model

New collection, `ScheduledJob`:

```js
{
  kind:        String,   // registry key: 'board_sync' | 'invoice_issuance'
  targetId:    String,   // boardId, workspaceId — the handler interprets it
  workspaceId: String,   // scoping and logging
  cron:        String,   // '*/30 * * * *'
  timezone:    String,   // IANA, default 'Australia/Sydney'
  enabled:     Boolean,
  nextRunAt:   Date,     // the claim key
  lastRunAt:   Date,
  lastError:   String,
  missedRuns:  Number,
  consecutiveFailures: Number,
}
```

Indexes:

- `{ enabled: 1, nextRunAt: 1 }` — the only query the tick makes.
- `{ kind: 1, targetId: 1 }`, unique — a toggle flipped twice cannot create two
  schedules for the same board.

**No migration and no backfill.** The collection is new; nothing exists to
migrate. Callers create and remove documents through `upsertSchedule` and
`disableSchedule` service functions, never by writing the model directly.

Deliberately absent: per-job priority (BullMQ has it downstream) and a run
history collection (`SyncExecution` and Bull Board already record what
happened).

## The tick

### Claiming

One candidate at a time, claimed with a compare-and-swap on the value just
read:

```js
const candidate = await ScheduledJob
  .findOne({ enabled: true, nextRunAt: { $lte: now } })
  .sort({ nextRunAt: 1 }).lean()

const claimed = await ScheduledJob.findOneAndUpdate(
  { _id: candidate._id, nextRunAt: candidate.nextRunAt },   // ← CAS
  { $set: { nextRunAt: computeNextRun(candidate.cron, candidate.timezone, now),
            lastRunAt: now },
    $inc: { missedRuns: countMissedSlots(candidate, now) } },
  { new: true }
)
```

If another Elastic Beanstalk instance claimed it first, `nextRunAt` no longer
matches, `claimed` is `null`, and the loop moves to the next candidate. The
claimed document's `nextRunAt` is now in the future, so it drops out of the
query. No lock to expire, no Redis involved, and duplicate EventBridge
deliveries are harmless.

The loop is bounded by the batch cap and by a hard iteration ceiling, so a
pathological CAS-miss sequence cannot spin.

### Delivery policy is per kind, declared on the handler

The claim above is the **`at_most_once`** path: `nextRunAt` advances as part of
the claim, before the handler runs, so a crash between claim and enqueue loses
that slot rather than repeating it. `missedRuns` makes the loss visible.

Which side of that trade is right depends on the job, so the policy is declared
at handler registration — not stored on the schedule record, where an operator
could set it to something the handler cannot survive.

| Policy | Advance | Used by | Why |
|---|---|---|---|
| `at_most_once` | At claim, before dispatch | `invoice_issuance` | A duplicated invoice to an NDIS participant is a client-facing incident. A lost run is visible in `missedRuns` and recoverable by hand. |
| `at_least_once` | After a successful enqueue | `board_sync` | Idempotent and cheap. A repeat is harmless; a silent skip just makes data staler. |

**`at_least_once` does not take a lease.** Advancing after the enqueue means the
advance is no longer part of the claim, so two instances can read the same due
record and both enqueue. That is what at-least-once means, and board sync is
already safe against it: `SyncExecution.hasRunningSync` and
`checkActiveQueueJob` refuse a second concurrent sync on a board. A lease would
buy fewer duplicates at the cost of a lease-expiry constant and a worse failure
mode — a slot blocked by a lease held by a dead process.

**Runaway guard.** An `at_least_once` job whose enqueue fails permanently never
advances, so it would be retried every tick forever and occupy a slot in the
batch cap. After `MAX_CONSECUTIVE_FAILURES` (5) it advances anyway — degrading
to `at_most_once` for that slot — and logs at `error`. Bounded, without
disabling a schedule that may only be wrong temporarily.

### Missed slots

When the app is down across several slots, the job runs **once** and
`nextRunAt` jumps to the next future slot. The number of skipped slots is added
to `missedRuns` and logged at `warn`, so a missed monthly statement is visible
rather than silent, and ops can alert on `missedRuns > 0`.

Backfill was rejected: enqueuing one job per missed slot means a burst against
the ISO+ API at exactly the moment we are recovering, and a week of downtime
becomes a flood.

### Batch cap

100 dispatches per tick. When the cap is hit, the response and the log say so —
no silent truncation. At a one-minute rate that is 6000 dispatches an hour,
far beyond anything realistic here.

### Failure

A handler that throws gets `lastError` and `consecutiveFailures` recorded. That
is all.

- **No auto-disable.** On a monthly statement, five consecutive failures is five
  months of silence. Failing loudly forever beats disabling quietly. (One
  narrower case does disable — a schedule whose next slot cannot be computed at
  all. See "Changes since approval" above.)
- **No immediate retry.** Retries belong to BullMQ, which already has
  `attempts: 3` with exponential backoff. A scheduler failure means "could not
  enqueue", which is a different and rarer problem than "the work failed".

## The handler contract

```js
// services/scheduler/registry.js
register('board_sync', {
  policy: AT_LEAST_ONCE,
  handler: ({ targetId, workspaceId }) =>
    triggerManualSync(getSchedulerAuthorization(), workspaceId, targetId),
})

register('invoice_issuance', {
  policy: AT_MOST_ONCE,
  handler: ({ targetId, workspaceId }) => /* … */,
})
```

Five rules, and they are the whole interface a feature codes against:

1. **Declare a policy.** `AT_MOST_ONCE` or `AT_LEAST_ONCE`. There is no default
   — registering without one throws at boot, because silently guessing wrong
   means either a duplicated invoice or a silently skipped sync.
2. **Enqueue and return.** Never await the work itself. This is what keeps a
   tick bounded regardless of how many boards exist.
3. **Be idempotent for the period.** Mandatory under `AT_LEAST_ONCE`, which will
   double-dispatch by design. Board sync already satisfies it —
   `SyncExecution.hasRunningSync` and `checkActiveQueueJob` refuse a second
   concurrent sync on a board. Still expected under `AT_MOST_ONCE`, since
   nothing downstream stops a retry arriving from elsewhere: invoice issuance
   must key on the billing period, not on the time of call.
4. **Throw on failure.** Do not swallow; the tick records it, and under
   `AT_LEAST_ONCE` throwing is what causes the retry.
5. **Take plain arguments.** No `req`, no session. That is what makes it
   callable from a cron.

An unregistered `kind` throws rather than silently no-oping.

### Credentials

`getSchedulerAuthorization()` returns `Bearer ${PERSONAL_ACCESS_TOKEN}` and
throws if it is unset, so a misconfigured environment fails at dispatch instead
of making an unauthenticated call to ISO+.

This is not a new trust boundary. `applyPrivilegedSessionAuth`
(`src/middleware/authHelpers.js:37`) already hands the same credential to every
`support_admin` and `owner` session. The scheduler reuses the existing server
identity rather than introducing one.

## HTTP surface

`POST /api/scheduler/tick`, guarded by the existing `validateApiKey`
(`src/middleware/auth.js:12`), mounted in `index.js` alongside the other
routers. No GET and no admin list — support can read the collection directly
until someone needs a screen.

Response:

```json
{ "claimed": 3, "dispatched": 3, "failed": 0, "capped": false }
```

The application knows nothing about AWS. Anything that can send an HTTP request
with the right header can drive it, which is what makes it testable locally:

```bash
curl -X POST -H "Authorization: $Admin_API_Key" \
  localhost:4001/api/scheduler/tick
```

## Testing

Failing test first, in this order.

**`nextRun.js` unit tests** carry the real risk and get the most coverage:

- `'0 2 1 * *'` in `Australia/Sydney` resolving to the correct UTC instant
  across a month boundary.
- Both Sydney DST transitions (early April, early October), where a naive
  `+24h` gives the wrong hour.
- Missed-slot counting across a multi-slot gap.

**`tick.js` unit tests**, model mocked:

- A CAS returning `null` skips to the next candidate rather than stalling.
- The 100 cap reports `capped: true`.
- **`AT_MOST_ONCE`**: a throwing handler records `lastError` and leaves
  `nextRunAt` advanced — the slot is lost, not retried.
- **`AT_LEAST_ONCE`**: a throwing handler leaves `nextRunAt` *unchanged*, so the
  next tick retries the same slot.
- **`AT_LEAST_ONCE` runaway guard**: after `MAX_CONSECUTIVE_FAILURES` the slot
  advances anyway and logs at `error`, rather than retrying forever.
- A successful `AT_LEAST_ONCE` dispatch advances and resets
  `consecutiveFailures` to 0.

**Registry**: an unknown `kind` throws; a registration with no `policy` throws.

**Integration** via supertest against `createApp()`: 401 with no key, 401 with
a wrong key, 200 dispatching a fake registered handler. `test/setup.js` already
provides `mongodb-memory-server` and a mocked `ioredis`, so this needs no new
infrastructure. ISO+ stays mocked throughout; nothing in this suite touches the
network.

**No Playwright test in this slice, deliberately.** The scheduler has no UI. It
becomes user-visible through the invoice/statement toggle and the invoice
configuration screen, and the end-to-end test belongs with whichever of those
ships the screen. Recorded here rather than quietly skipped, because
`CLAUDE.md` requires an e2e test for user-visible change.

## Operations

### Local scheduling — `npm run tick`

Because the application knows nothing about AWS, the clock is replaceable. A
small subcommand in `scripts/` drives the same endpoint on an interval, so the
whole feature is developable and demonstrable with no AWS account involved:

```bash
npm run tick              # every 60s until interrupted, printing each summary
npm run tick -- --once    # a single tick; what verification steps use
npm run tick -- --every 5 # tighter loop while developing
```

It reads the API port from the root `.env` and `Admin_API_Key` from
`Backend/.env` through the existing `parseEnv`/`readEnv` in
`scripts/lib/env.mjs`, so there is nothing to configure. Consistent with the
rest of `scripts/`, it is Node rather than shell, uses global `fetch`, and adds
**no dependency** — that directory has none by design and must keep having none.

This is **not** the in-process fallback timer that this design rejected. It is a
developer tool in a directory that is never deployed; the application still has
no timer in it, and production scheduling is still external. The distinction
matters because an in-process timer would fire once per Elastic Beanstalk
instance.

### AWS

One EventBridge rule per environment in `ap-southeast-2`:

| Setting | Value |
|---|---|
| Rule type | Schedule, `rate(1 minute)` |
| Target | API Destination |
| Endpoint | `https://<env-host>/api/scheduler/tick` |
| Method | `POST` |
| Connection auth | API key |
| Header name | `Authorization` |
| Header value | the environment's `Admin_API_Key`, verbatim |

The header value must be the key **exactly** — no `Bearer ` prefix.
`validateApiKey` (`src/middleware/auth.js:12`) compares the raw header against
`process.env.Admin_API_Key` with `!==`, so any prefix or whitespace fails as a
401.

Dev and prod need separate rules pointing at separate hosts with separate keys.
A rule aimed at the wrong environment is not detectable from inside the
application — both would answer 200.

This is the one part that merging cannot verify. Nothing breaks if the rule is
missing; schedules simply never fire, silently. The implementation plan
therefore carries rule creation as an explicit step with a verification
(`lastRunAt` advancing and `missedRuns` staying at 0 on a test schedule, with
nobody calling the endpoint by hand), and it is written down in
`docs/scheduling.md` rather than living in someone's memory.

## Risks

| Risk | Assessment |
|---|---|
| `Admin_API_Key` is a single shared secret already guarding other routes | Rotating it breaks those routes and the scheduler at once. Note in the PR; do not add a second secret for this alone. |
| The endpoint is publicly reachable through the ALB | A leaked key buys an attacker the ability to trigger work the system already does on its own. It cannot exfiltrate data — the response is four counters. |
| EventBridge delivers at least once | Under `AT_MOST_ONCE` the CAS claim makes duplicate delivery a no-op. Under `AT_LEAST_ONCE` it may cause a second dispatch, which is what the policy accepts and what handler idempotency covers. |
| A handler is registered under the wrong policy | Registration without a policy throws at boot. Choosing the wrong one is a review question, and the table above exists so the reasoning is on the record. |
| The AWS rule is never created | Silent non-firing. Mitigated by the explicit ops step and by `lastRunAt` being observable. |

## New dependencies

- **`cron-parser`** — computes the next slot for a cron expression in a given
  IANA timezone. One package, no transitive dependencies. The alternative is
  hand-rolled DST arithmetic, which is where this design would otherwise be
  most likely to be wrong.

## Out of scope

No UI for editing cron expressions, no run-history collection, no backfill of
missed slots, no auto-disable after repeated failure, and no in-process fallback
timer. Each is a real thing someone might eventually want; none is needed to
unblock the two features waiting on this.

## Sequencing

From the 2026-08-11 discussion, agreed with Masoud:

1. Arnold — invoice/statement toggle. **In progress.**
2. Allan — this scheduler, then automated issuance.
3. Arnold — automated board sync, registering a `board_sync` handler.

The trigger is shared, which is why the order works: whatever fires
invoice/statement issuance is the same mechanism board sync hooks onto. Arnold
waits on this design shipping, not on the issuance feature being finished.
