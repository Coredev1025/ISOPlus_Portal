# Scheduling

The scheduler is a clock, not a worker. It decides *when* a piece of recurring
work is due and hands it to the queue that already exists — it never performs
the work itself. It never calls ISO+, never generates a PDF, never touches
Xero. See
[`docs/superpowers/specs/2026-08-11-scheduled-job-trigger-design.md`](./superpowers/specs/2026-08-11-scheduled-job-trigger-design.md)
for the full design rationale; this file is the operational reference —
what to configure in AWS, what the endpoint does, how to run it locally, and
how a feature registers into it.

Ticket: KAN-15.

## What it does, and what it does not

- It claims due `ScheduledJob` documents from Mongo and dispatches each one to
  a handler registered for its `kind`.
- A handler's job is to **enqueue and return**. For invoice/statement
  automation that means fan-out onto the automation queue. Portal board
  catch-up uses the same enqueue-and-return pattern from the in-process
  board-sync clock (`runBoardSyncSweep` → `scheduled_sync` on `board-sync`),
  not from the tick.
- The scheduler holds no business logic for any feature. It does not know what
  a board sync or an invoice is — only that a `kind` has a handler and a
  policy.
- One HTTP endpoint for invoice/statement automation, driven externally.
  Portal board catch-up uses a separate in-process timer (see below) — see
  "Why not `node-schedule`" for why the shared tick stays external.

## The endpoint

`POST /api/scheduler/tick`

- **Auth**: `validateSchedulerApiKey` (`Backend/src/middleware/auth.js`) — the
  raw `Authorization` header must equal one of the configured scheduler keys
  exactly: the master `SCHEDULER_API_KEY`, or either optional per-kind key,
  which scopes the tick to its own kind. See
  ["One rule per kind, optionally"](#one-rule-per-kind-optionally) for the
  scope table. No session, no JWT. Missing header → 401. Wrong value → 401.
  `SCHEDULER_API_KEY` unset → 500, whatever else is configured.
- **Body**: none required.
- **Response** (200):

  ```json
  { "claimed": 3, "dispatched": 3, "failed": 0, "heldBack": 0, "capped": false }
  ```

  `claimed` is how many due schedules this tick took, and `dispatched` and
  `failed` split that by outcome; `capped` is `true` only when the 100-per-tick
  batch limit was hit, so remaining due schedules waited for the next tick
  rather than being silently dropped.

  `heldBack` counts due schedules this tick deliberately did **not** claim
  because `AUTOMATION_ENABLED` is off. Those slots stay due and are billed when
  the switch comes on — they are held, not skipped. A non-zero value on a
  deployment that is meant to be running automation means the switch is off.

  `dispatched + failed` normally equals `claimed`, but is not guaranteed to.
  A schedule whose next slot cannot be computed is never claimed at all —
  there is nothing to advance it to — so it counts in `failed` without
  counting in `claimed`, and the totals come out one apart per such row. That
  is deliberate: the alternative is a schedule that can never run being absent
  from the summary entirely. See "`enabled: false` on a schedule nobody
  disabled" below.

Verified against the local stack — the route is live and the gate is closed to
a call with no `Authorization` header at all:

```
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4001/api/scheduler/tick
401
```

## Deploying: the indexes

No migration. The two indexes on `scheduledjobs` are declared on the schema —
`{ enabled: 1, nextRunAt: 1 }` (the only query the tick makes) and a **unique**
`{ kind: 1, targetId: 1 }` — and Mongoose builds them on connect, which is how
every other model in this codebase gets its indexes.

The unique constraint is load-bearing: it is what stops a toggle flipped twice
from creating two schedules for the same board, which would double-dispatch.
Confirm it actually exists in an environment with:

```bash
npm run schema -- scheduledjobs
```

If `autoIndex` is ever disabled for performance, that check is what will catch
the constraint going missing — and the fix at that point is a migration for
every collection, not just this one.

## Deploying: set `SCHEDULER_API_KEY` on the environment

**Do this before creating the EventBridge rule.** The rule and the key are
useless without each other, and neither is created by merging.

Nothing in this repository sets Elastic Beanstalk environment variables. The
deploy workflow (`.github/workflows/cicd.yml`) only builds a bundle, uploads it
to S3, and calls `update-environment --version-label` — it passes no
`--option-settings`, and the single file in `Backend/.ebextensions/` configures
load balancer timeouts and nothing else. Environment properties live in the EB
environment's own saved configuration, which is exactly why they survive every
deploy: the workflow swaps the application version and leaves them alone.

So this is a manual step, once per environment, the same way `Admin_API_Key`
and `JWT_SECRET` got there. Either the console — Configuration → Updates,
monitoring, and logging → Environment properties — or:

```bash
aws elasticbeanstalk update-environment \
  --environment-name isoplus-be-dev-blue \
  --option-settings \
    Namespace=aws:elasticbeanstalk:application:environment,OptionName=SCHEDULER_API_KEY,Value=<secret>
```

Environments are `isoplus-be-dev-blue` and `isoplus-be-prod-blue`, region
`ap-southeast-2`. **This triggers an environment update and a rolling restart**,
so it is not a free operation against production — treat it as a deployment.

**Forgetting it fails silently, which is the whole problem.** `SCHEDULER_API_KEY`
is deliberately *not* in `index.js`'s `requiredEnvVars` — a scheduler credential
must not be able to stop the entire API booting. The consequence is that without
it the app boots healthy, every other route works, and only
`POST /api/scheduler/tick` answers `500 Server configuration error`, on every
EventBridge invocation, forever. No schedule ever runs and nothing says why.

Two things catch it:

- **At boot**, the app logs `Bootstrap: SCHEDULER_API_KEY is not set...` at warn
  level. Check the deployment logs after the first deploy to a new environment.
- **Afterwards**, `SchedulerHealth.lastTickAt` stops advancing — the same signal
  as a missing EventBridge rule, so a stale `lastTickAt` means one of the two,
  and the boot log tells you which. See "What to alert on".

## The AWS EventBridge rule

One rule per environment, in `ap-southeast-2`. This is the one part of this
feature that merging cannot verify — nothing breaks if the rule is missing or
misconfigured, schedules simply never fire, silently. Set it up from this
table, then confirm with the verification steps below.

| Setting | Value |
|---|---|
| Rule type | Schedule, `rate(1 minute)` |
| Target | API Destination |
| Endpoint | `https://<env-host>/api/scheduler/tick` |
| Method | `POST` |
| Connection auth type | API key |
| Header name | `Authorization` |
| Header value | the environment's `SCHEDULER_API_KEY`, **verbatim** |

### One rule per kind, optionally

The automation kinds can each get their own rule and their own credential:
set `SCHEDULER_API_KEY_INVOICE` and/or `SCHEDULER_API_KEY_STATEMENT` on the
environment and point one rule at each, same table as above but with the
per-kind key as the header value. **The presented key is the scope** — a tick
authenticated with the invoice key claims only `invoice_automation`
schedules, the statement key only `statement_automation`, and the master
`SCHEDULER_API_KEY` claims everything (including `board_sync`), so the two
rules cannot fire each other's schedules however they are misconfigured. The
master key remains required configuration either way: it is what
`npm run tick` sends, and the boot warning keys on it. An unset — or blank —
per-kind variable simply makes that credential unavailable. Configuring only
the per-kind keys gets every tick a **500**, not a 401; the log line names
`SCHEDULER_API_KEY` explicitly for exactly that case.

**Do not paste the same secret into two of these variables.** If a per-kind
key is set to the master key's value, the narrowest matching scope wins — the
tick claims only that kind — and `validateSchedulerApiKey` logs
`API key matches more than one configured credential`. It is deliberately not
the master scope: a credential that leaked a narrow capability must not
silently acquire a wide one. Give each rule its own secret.

`validateSchedulerApiKey` and `validateApiKey` are both built by the one
`apiKeyValidator({ scopes, requiredEnvVar, requiredMessage, onMatch })` factory
in `Backend/src/middleware/auth.js` — add a gate by calling it, not by copying
it. A gate that accepts several credentials passes several `scopes` and reads
the matched one in `onMatch`, which is how the tick learns its scope.

**The header value must be the key exactly — no `Bearer ` prefix, no leading
or trailing whitespace.** The factory compares the raw header against each
configured key with strict equality (see `SCHEDULER_KEY_SCOPES` in the same
file); a non-empty match is required, so a blank env var can never authorize
anything.

Anything other than the bare key value — a `Bearer ` prefix, a stray space
from copy-paste — fails that comparison and produces a 401. This is not a
hypothetical: `Backend/test/integration/scheduler.route.test.js` has a test
named exactly for this, "rejects the key with a Bearer prefix, which is the
likely misconfiguration", asserting a 401 when the header is
`Bearer <key>` instead of `<key>`.

### Dev and prod are separate rules, separate hosts, separate keys

Each environment needs its own EventBridge rule pointing at its own host with
its own `SCHEDULER_API_KEY`. There is no shared or default rule to fall back on.

**A rule pointed at the wrong environment is undetectable from inside the
application** — both dev and prod answer `200 {"claimed":...}` regardless of
which one you meant to hit. The only way to catch a misrouted rule is to check
which environment's `ScheduledJob` documents actually have `lastRunAt`
advancing (see "What to alert on" below). Verify each rule against its own
environment, not by assuming the pattern transferred correctly from the one
you set up first.

### Verifying a rule after creating it

Once the rule exists, confirm on the target environment (not locally):

1. Create or leave enabled a test schedule (or wait for a real `board_sync`,
   `invoice_automation` or `statement_automation` one already registered).
2. Watch that record's `lastRunAt` advance on its own, with nobody calling the
   endpoint by hand, and `missedRuns` staying at `0`.
3. If `lastRunAt` is not moving, the rule is either missing, disabled, pointed
   at the wrong host, or sending a malformed `Authorization` header — check
   CloudWatch metrics on the API Destination for 401s before assuming the
   application is broken.

## Running it locally — `npm run tick`

The application has no scheduling of its own, so locally you drive the same
endpoint yourself. `scripts/dev.mjs tick` (via `scripts/lib/tick.mjs`) is a
small Node script — no shell, no new dependency — that reads the API port from
the root `.env` and `SCHEDULER_API_KEY` from `Backend/.env`:

```bash
npm run tick              # every 60s until interrupted, printing each summary
npm run tick -- --once    # a single tick; what verification steps use
npm run tick -- --every 5 # tighter loop while developing
npm run tick -- --url <url>   # override the endpoint
```

Each line printed looks like:

```
[2026-08-11T08:14:40.871Z] claimed=0 dispatched=0 failed=0 (81ms)
```

This is a developer convenience, not a fallback timer inside the app — the
distinction matters, see the next section.

## Why not `node-schedule`

An in-process timer (`node-schedule`, `node-cron`, or anything similar) fires
once **per running instance** of the app. Elastic Beanstalk can and does run
more than one instance. The moment it scales past one, an in-process timer
double-dispatches every scheduled job — every board sync would run twice,
every invoice would be issued twice. External triggering (EventBridge calling
one HTTP endpoint) avoids that entirely: however many instances are running,
exactly one of them handles a given tick request, and the claim logic in
`Backend/src/services/scheduler/tick.js` makes concurrent ticks from multiple
instances safe regardless.

Do not add a `node-schedule` (or `node-cron`) call to wire the **shared** tick
up "just for now." Portal board catch-up (Epic 12) is an intentional exception:
it uses in-process `setTimeout` + `cron-parser` (`startBoardSyncCron`) and
relies on BullMQ jobId collapse when multiple instances fire.
Invoice/statement automation stay on EventBridge.

## Trap: a route in this repo must be mounted twice

`Backend/src/index.js` is the production entry point. It does **not** call
`createApp()` from `Backend/src/app.js` — they are two parallel Express apps
that happen to wire up nearly the same routes. `Backend/test/` builds its app
via `createApp()` (`Backend/test/integration/scheduler.route.test.js`), so a
route mounted only in `app.js` is fully covered by the test suite and
**404s in production**, because `index.js` never mounted it.

The scheduler route is correctly mounted in both places — search each file for
`app.use('/api/scheduler', schedulerRoutes)`.

During this work the route was initially added only to `app.js`. Every test
passed — the integration suite exercises `createApp()` — and the endpoint
would have 404'd in the deployed API. Nothing in the test run would have
caught it.

**If you add a new route to this backend, mount it in both `app.js` and
`index.js`, and manually check the deployed environment answers it** — a
green test suite does not prove `index.js` was touched. This is the single
most important thing to remember from this document if you are adding routes
rather than working with the scheduler specifically.

Also note `index.js` calls `registerSchedulerHandlers()` once at module load,
so the registry is populated before the first tick can arrive. `createApp()`
in `app.js` does not call it — tests register their own handlers per-case via
`register()` / `clearRegistry()` (see `scheduler.route.test.js`).

## Trap: adding `cron-parser` needs a container rebuild, not just a restart

`cron-parser` (`Backend/src/services/scheduler/nextRun.js`) is a new direct
dependency, pinned to `5.8.1` in `Backend/package.json`. BullMQ and
`node-schedule` already depend on their own, older copy of the same package
(`cron-parser@4.9.0`, nested under each in `Backend/package-lock.json`).

A dev container image built **before** this dependency was added has only the
nested `4.9.0` copies on disk, hoisted to the top-level `node_modules/cron-parser`
because nothing else was requesting the package at the top level. Version
`4.9.0` has no `CronExpressionParser` named export — that's a `5.x` API — so
`import { CronExpressionParser } from 'cron-parser'` in `nextRun.js` resolves
to `undefined`, and the backend crash-loops with an error that reads like a
CommonJS/ESM interop bug in the code. It is not: it is a stale image with the
wrong version hoisted.

```bash
npm run dev:build
```

fixes it, same as any other `package.json` change (see
[`local-development.md`](./local-development.md)). `npm ci` in CI and on
Elastic Beanstalk always resolves the lockfile fresh, so the deployed
environments are never affected — this is purely a stale local Docker image
issue.

The giveaway that the discard did not happen is a `dev:build` whose output has
no `==> discarding this project's node_modules/.next volumes` line. It is now
unconditional in `scripts/dev.mjs`; it used to be gated on the project having
*running* containers, which skipped it for a stopped stack and remounted the
stale volume over the newly built image, because volumes outlive containers.

## Registering a handler

Handlers live in `Backend/src/services/scheduler/handlers.js`, imported for
its side effects at boot (`registerSchedulerHandlers()`, called once from
`Backend/src/index.js`, before any tick can arrive). Invoice and statement
automation register here under `AT_LEAST_ONCE`. Portal board catch-up does
**not** — it is driven by `startBoardSyncCron` (see below).

## Portal board catch-up (`board_sync`)

An in-process `setTimeout` + `cron-parser` timer (`startBoardSyncCron` in
`portalSchedule.js`) fires on `BOARD_SYNC_CRON` (default `0 2 * * *`) in
`DEFAULT_TIMEZONE` and calls `runBoardSyncSweep`. That fans out
`scheduled_sync` jobs for every `syncData: true` board onto `board-sync`.
The worker runs them at concurrency 1. Enable-time backlog and ISO+
webhooks are unchanged. Board Configuration reads previous / current /
next from the workspace sync status poll (next run is computed from the
cron, not from a `ScheduledJob` row).

Leftover portal `ScheduledJob` rows (`kind: board_sync`, `targetId: portal`)
are disabled by migration so EventBridge ticks cannot claim them.
Invoice/statement automation remain on the tick.

Multi-instance duplicate fires are accepted: BullMQ jobIds
`sched:{boardId}:{periodKey}` collapse them.

Five rules apply to every **tick** handler. Only the first is enforced in code
(`register()` in `Backend/src/services/scheduler/registry.js` throws at boot
if no policy is declared); the rest are conventions from the design and from
the comments in `handlers.js` and `tick.js` — nothing stops a handler from
violating them, so review for these deliberately:

1. **Declare a policy.** `AT_MOST_ONCE` or `AT_LEAST_ONCE` — there is no
   default. `register()` throws at boot if the policy is missing or not one
   of the two, because guessing wrong silently means either a duplicated
   invoice or a silently skipped sync.
2. **Enqueue and return.** Never `await` the actual work — only the enqueue.
   This is what keeps a tick's duration bounded no matter how many boards or
   workspaces exist.
3. **Be idempotent for the period.** Mandatory under `AT_LEAST_ONCE`, which
   double-dispatches by design when two instances race. `board_sync` already
   satisfies this: `SyncExecution.hasRunningSync` and `checkActiveQueueJob`
   refuse a second concurrent sync on the same board. Still expected under
   `AT_MOST_ONCE`, since nothing downstream stops a retry arriving from
   elsewhere — key on the billing period, not on the time of the call.
4. **Throw on failure.** Do not swallow errors — the tick records
   `lastError`/`consecutiveFailures` on the schedule, and under
   `AT_LEAST_ONCE` throwing is what causes the next tick to retry the slot.
5. **Take plain arguments.** `{ kind, targetId, workspaceId, scheduledFor }` —
   no `req`, no session. That is what makes a handler callable from a cron
   tick with no HTTP request behind it.

An unregistered `kind` throws when the tick tries to resolve it, rather than
silently no-oping.

Schedules themselves are only ever written through
`Backend/src/services/scheduler/schedules.js` — `upsertSchedule` /
`disableSchedule`. Nothing should write `ScheduledJob` documents directly.

**`upsertSchedule` recomputes `nextRunAt` only when the cadence actually
changed.** If the stored `cron`/`schedule`/`timezone` are identical and the row
is already enabled, the existing `nextRunAt` is kept. That matters because
`routes/workspace.js` calls `upsertSchedule` on every automation-settings PUT,
including a save that only edits an email address: recomputing there would push
a slot that was already due into the next cycle, and that cycle would never be
billed — with `missedRuns` still reading zero, because nothing was skipped as
far as the tick could tell. A disabled row is excluded deliberately, so
re-enabling a paused schedule moves it forward rather than firing it
immediately.

**Do not write a monthly cron on the 29th, 30th or 31st.** Cron does not clamp
to the end of a short month — it simply does not fire. A `0 9 31 * *` schedule
skips every month with fewer than 31 days, and `29`/`30` skip most Februaries.
For invoice issuance that is not cosmetic: the client does not get billed that
month, and nobody finds out until someone notices the missing invoice. Use 1–28,
or an explicit last-day expression, and check `lastRunAt` after the first month.

## The picker schedule — a second representation, not a cron string

The Epic 5 UI exposes user-facing schedule fields — *Generate Invoices Every /
Run On / Run At / Start Date / Next Run* — not a cron expression. An end user
picks an interval, and where relevant a day, from a constrained set; they never
type cron syntax.

**Cron cannot express what that picker offers.** "Every 2 weeks" and "every 3
months from a start date" both need an anchor date and an interval count, and
cron has neither — `*/2` on the day-of-month field restarts at the 1st of every
month, and there is no week-of-year field at all. So a `ScheduledJob` carries
**exactly one** of two representations, enforced in `upsertSchedule` and by the
model's `pre('validate')` hook:

- `cron` — a traditional expression, evaluated by `nextRun.js`.
- `schedule` — the picker shape, evaluated by
  `Backend/src/utils/automationScheduleHelpers.js`:

  ```js
  { every: { n, unit }, runOn, runAt: 'HH:MM', startDate }
  ```

  `unit` is one of `day | week | month | quarter | year` (`AUTOMATION_UNITS` in
  `constants/automation.js`), and `runOn` changes shape with it:

  | `unit` | `runOn` |
  |---|---|
  | `day` | ignored |
  | `week` | a weekday name, `'monday'` … `'sunday'` |
  | `month` | an integer day-of-month, **1–31** (29–31 clamp in short months) |
  | `quarter` | `{ month, day }` — `month` selects the month within the quarter cycle |
  | `year` | `{ month, day }` — month-of-year and day-of-month |

  The API validates these shapes in `utils/automationSettingsHelpers.js`
  (`validateRunOn`), and the arithmetic in `automationScheduleHelpers.js`
  reads exactly the same ones. They have to agree: a shape one accepts and the
  other cannot read is a save that throws, or a run at the wrong time.

**The clamp is what makes 29–31 safe for `month`, and it is the guarantee to
rely on.** A picker schedule on the 31st fires on 30 April and on 28 or 29
February — `addMonthsClamped` in `automationScheduleHelpers.js` shortens the
day to the target month's length. It never rolls over into the next month,
because rolling over shifts every subsequent run and can fire twice in one
calendar month. `validateRunOn` therefore accepts the full 1–31 range; it was
narrowed to 1–28 at one point and widened again deliberately (commit
`ceaefe3`) once the clamp existed, so a client who wants the last few days of
the month can have them.

This is the picker's advantage over cron, not a shared weakness — see "Do not
write a monthly cron on the 29th, 30th or 31st" above for what raw cron does
with the same day.

**All picker arithmetic is wall-clock in the job's timezone**, so "09:00" stays
09:00 across a daylight-saving transition. That makes `startDate` a *calendar
date*, not an instant — and `ScheduledJob.schedule.startDate` is a Mongoose
`Date`. `services/scheduler/advance.js` owns both halves of that conversion:
`canonicalStartDate` normalises the value once on the way in (anchoring on
local midnight in the job's timezone), and `normaliseStartDate` reads it back
the same way. They only stay correct as a pair — anchoring the write on the raw
client string and the read on the timezone-formatted Date puts the series a
calendar day, and therefore a whole cadence, off phase for any zone west of
Greenwich.

**`computeNextRun` guarantees an instant strictly after the `from` it was
given, and asserts it.** A candidate at or before `from` is the one failure
nothing downstream catches: `upsertSchedule` stores it, every tick claims it,
`advanceSchedule` returns the same instant so the claim's compare-and-swap
succeeds, and `missedSlotsFor` reports `0` because its own "did not move
forward" guard fires — a schedule that re-runs every minute forever with
`missedRuns` still at zero. If the arithmetic ever produces one, it throws with
a `Scheduler: ` prefix instead, which `isScheduleClientError` turns into a 400
on the save path and `claimAtMostOnce` turns into a quarantined row on the tick
path.

**Raw cron remains a fully-supported escape hatch.** The `cron` field accepts
anything `isValidSchedule` (`nextRun.js`) accepts, not only what the picker can
produce — "last business day of the month" and similar shapes the picker was
never meant to express are configured by hand-editing the schedule record, no
UI work required.

> An earlier iteration of this work shipped `cadence.js`, a picker→cron
> translator over a `daily | weekly | monthly` vocabulary. It was deleted once
> the picker above existed: cron cannot express what Epic 5 actually
> specified, the module had no production callers, and a second incompatible
> encoding of the same domain knowledge is exactly how someone later wires the
> wrong one.

## The two delivery policies

Declared at registration, not stored on the schedule record — an operator
editing a document must not be able to put a handler under a guarantee it
cannot survive.

| Policy | `nextRunAt` advances | Used by | Why |
|---|---|---|---|
| `AT_MOST_ONCE` | At claim, before the handler runs | Nothing registered today | For work where a duplicate is the worse failure — a duplicated invoice sent to an NDIS participant is a client-facing incident, while a lost run shows up in `missedRuns` and is recoverable by hand. |
| `AT_LEAST_ONCE` | Only after the handler's enqueue succeeds | `invoice_automation`, `statement_automation` | The automation kinds fan out per board; their safety comes from the per-board `jobId` (`buildFanOutSpecs`), so missing a month is the failure left worth designing against. See the comment in `registerAutomationHandlers`. Portal board catch-up is not on the tick — see "Portal board catch-up" above. |

Choose `AT_MOST_ONCE` when a duplicate is the worse failure mode. Choose
`AT_LEAST_ONCE` only when the handler is genuinely idempotent — if it is not,
a race between two Elastic Beanstalk instances will double-dispatch it.

## What to alert on

- **`lastTickAt` staleness — the primary signal for a missing or
  misconfigured EventBridge rule.** `runTick`
  (`Backend/src/services/scheduler/tick.js`) upserts a single document in the
  `schedulerhealths` collection
  (`Backend/src/models/SchedulerHealth.js`, `key: "scheduler"`) on **every**
  tick, including one that claims nothing — a `claimed: 0` heartbeat is the
  normal, healthy state, not an absence of signal. That document's
  `lastTickAt` field is the only signal in this section that distinguishes
  "the clock stopped" from "nothing was due": every other alert below lives
  on a `ScheduledJob` document and cannot fire at all if no schedule exists
  yet, or degrades to a slow per-schedule staleness check at best. `lastTickAt`
  needs neither.

  **Alert when `lastTickAt` is older than 2× the expected tick interval.**
  With the documented EventBridge rule of `rate(1 minute)` (see "The AWS
  EventBridge rule" above), that means alerting once `lastTickAt` is more than
  roughly **two minutes** old. The 2× margin absorbs a single slow or
  overlapping tick without false-alarming; a rule that is missing, disabled,
  or pointed at the wrong host will blow well past that threshold and stay
  there, since nothing else advances the field.

  Epic 6 (System Health screen) should read `lastTickAt` — along with
  `claimed`/`dispatched`/`failed`/`capped` from the same document, recorded
  from the same tick summary, for context beyond the bare timestamp — from
  the `schedulerhealths` collection's single `{ key: "scheduler" }` document.

  A heartbeat write failure is logged at `warn` and does not fail the tick
  itself (`Backend/src/services/scheduler/heartbeat.js`) — losing a heartbeat
  is a monitoring gap, not an outage, so the tick's own summary is still
  returned and any due schedules are still dispatched.

Per `ScheduledJob` document (`Backend/src/models/ScheduledJob.js`), for the
schedule-level detail `lastTickAt` cannot provide on its own:

- **`missedRuns > 0`, for every policy and both schedule shapes.** A slot that
  came and went while the app was down increments it, whether the schedule is
  `AT_MOST_ONCE` or `AT_LEAST_ONCE` and whether it is expressed as cron or as
  an "every {n, unit}" picker cadence. Alert on it for any `kind`.

  Counted in two places, because the two policies skip slots at different
  moments: `AT_MOST_ONCE` counts on the claim
  (`Backend/src/services/scheduler/tick.js`), which is where its `nextRunAt`
  advances, and `AT_LEAST_ONCE` counts in `recordSuccess`
  (`Backend/src/services/scheduler/outcome.js`), which is where its advance
  actually happens. Both call the same `missedSlotsFor`
  (`Backend/src/services/scheduler/missedSlots.js`), so the count cannot
  disagree between them.

  A picker cadence is counted in **its own steps**: an "every 3 months"
  schedule that missed nine calendar months reports 3, not 9. The walk is
  capped at 1000 slots — it is a health signal, not an accounting record, so
  a very stale row reports "at least this many".

  > **Changed 2026-08-13.** This field used to be permanently zero for every
  > `AT_LEAST_ONCE` schedule — which is both automation kinds and
  > `board_sync` — because only the at-most-once claim path incremented it.
  > Any alert written against it before that date could never fire, and
  > `lastRunAt` staleness was the documented substitute. Both now work.
- **`consecutiveFailures > 0`** — the handler is throwing. Reaching this count
  never disables a schedule, so it is the main signal that one is failing every
  time it fires. For `AT_LEAST_ONCE` schedules it does not mean "still retrying
  the same slot forever": once it reaches `MAX_CONSECUTIVE_FAILURES` (5, in
  `Backend/src/constants/scheduler.js`), `advancePastFailureLimit` in
  `outcome.js` moves `nextRunAt` on to the following slot rather than retrying
  the failed one — that slot is abandoned and the schedule degrades to
  at-most-once behaviour from then on.

  A schedule *is* disabled in one other case, which is not this one: when its
  own next slot cannot be computed at all, `disableUnrunnable` flips `enabled`
  off. Such a row can never run again, so leaving it enabled would mean
  re-reading and re-failing it on every tick forever. `lastRunAt`, `missedRuns`
  and `lastError` all survive the disable for whoever investigates.

  `consecutiveFailures` is never reset except by success, so once it passes 5
  it keeps climbing on every subsequent slot the handler still fails on. It is
  incremented with `$inc` against the stored value rather than from the copy
  read before dispatch, so two `AT_LEAST_ONCE` instances that both fail the
  same slot count twice rather than writing the same number twice.

- **`enabled: false` on a schedule nobody disabled** — there is exactly one
  thing that flips `enabled` off by itself, and it is not a failing handler.
  A schedule whose **own next slot cannot be computed** is disabled, because
  the `cron`/`timezone` that has to be parsed in order to advance it is the
  thing that will not parse: it can never run again, and left enabled it is
  re-read and re-failed on every tick, forever. Both paths that hit this do
  the same thing:

  - the `AT_MOST_ONCE` claim, which advances `nextRunAt` before dispatching
    (`tick.js`, `quarantineSchedule`) — the row is also counted in the tick's
    `failed` total, so a schedule that can never run is visible in the summary
    rather than absent from it;
  - the `AT_LEAST_ONCE` give-up advance past `MAX_CONSECUTIVE_FAILURES`
    (`outcome.js`, `advancePastFailureLimit`).

  `lastError`, `lastRunAt`, `missedRuns` and `consecutiveFailures` are all left
  intact — the row is taken out of the claim query, not cleaned up — and
  `upsertSchedule` sets `enabled: true`, so correcting the schedule through the
  sanctioned path brings it back.

  Reaching this state requires a document written straight against the
  `scheduledjobs` collection (e.g. `collection.insertOne`), bypassing both
  the Mongoose validators on `cron` and `timezone` (`ScheduledJob.js`) and
  `upsertSchedule`'s own validation before it writes anything
  (`schedules.js`). The sanctioned write path cannot produce a schedule whose
  `cron`/`timezone` fails to parse, so if you find one disabled with a parse
  error in `lastError`, something wrote to the collection directly.
- **`lastRunAt` not advancing** — the most direct way to catch a schedule that
  is not firing at all: a misconfigured or missing EventBridge rule, a
  disabled schedule, or a `kind` whose handler throws before recording
  anything. This is also the check to run after creating a new AWS rule
  (see "Verifying a rule after creating it" above). It complements `missedRuns`
  rather than substituting for it, as it had to before 2026-08-13 —
  `missedRuns` says how many slots were skipped, `lastRunAt` says whether the
  schedule is firing at all. Note this still requires at least one `ScheduledJob`
  document to exist and be due before it says anything; `lastTickAt` above is
  what to watch when there may be none.

Support can read the `scheduledjobs` and `schedulerhealths` collections
directly for now; there is no admin screen for either.

## Related

- Design: [`docs/superpowers/specs/2026-08-11-scheduled-job-trigger-design.md`](./superpowers/specs/2026-08-11-scheduled-job-trigger-design.md)
- Code: `Backend/src/services/scheduler/` (`tick.js`, `registry.js`,
  `handlers.js`, `nextRun.js`, `advance.js`, `outcome.js`, `schedules.js`,
  `auth.js`, `heartbeat.js`), `Backend/src/utils/automationScheduleHelpers.js`,
  `Backend/src/routes/scheduler.js`,
  `Backend/src/models/ScheduledJob.js`, `Backend/src/models/SchedulerHealth.js`.
- Conventions for branching, commits, migrations and the complexity gate live
  in [`CLAUDE.md`](../CLAUDE.md) — not restated here.
