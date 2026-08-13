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
- A handler's job is to **enqueue and return**. For `board_sync` that means a
  BullMQ job on the existing `board-sync` queue
  (`Backend/src/services/sync/queue.js`); the sync worker
  (`Backend/src/workers/syncWorker.js`) does the actual work, on its own
  existing retry and concurrency settings.
- The scheduler holds no business logic for any feature. It does not know what
  a board sync or an invoice is — only that a `kind` has a handler and a
  policy.
- One HTTP endpoint, driven externally. The application has no in-process
  timer — see "Why not `node-schedule`" below for why that matters.

## The endpoint

`POST /api/scheduler/tick`

- **Auth**: `validateSchedulerApiKey` (`Backend/src/middleware/auth.js`) — the
  raw `Authorization` header must equal `process.env.SCHEDULER_API_KEY`
  exactly. No session, no JWT. Missing header → 401. Wrong value → 401.
- **Body**: none required.
- **Response** (200):

  ```json
  { "claimed": 3, "dispatched": 3, "failed": 0, "capped": false }
  ```

  `claimed` is how many due schedules this tick took, and `dispatched` and
  `failed` split that by outcome; `capped` is `true` only when the 100-per-tick
  batch limit was hit, so remaining due schedules waited for the next tick
  rather than being silently dropped.

  `dispatched + failed` normally equals `claimed`, but is not guaranteed to.
  A schedule whose next slot cannot be computed is never claimed at all —
  there is nothing to advance it to — so it counts in `failed` without
  counting in `claimed`, and the totals come out one apart per such row. That
  is deliberate: the alternative is a schedule that can never run being absent
  from the summary entirely. See "`enabled: false` on a schedule nobody
  disabled" below.

Verified against the local stack:

```
$ curl -s localhost:4001/api/healthcheck
{"status":"OK"}

$ npm run tick -- --once
[2026-08-11T08:14:40.871Z] claimed=0 dispatched=0 failed=0 (81ms)

$ curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4001/api/scheduler/tick
401
```

The 401 above is `curl` sending no `Authorization` header at all — the point
being that the route is live and the auth gate is doing its job, not that
this particular call was a misconfiguration.

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

**The header value must be the key exactly — no `Bearer ` prefix, no leading
or trailing whitespace.** `validateSchedulerApiKey` compares the raw header
against `process.env.SCHEDULER_API_KEY` with `!==`:

```js
if (authHeader !== process.env.SCHEDULER_API_KEY) {
  // ... 401 Invalid API key
}
```

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

1. Create or leave enabled a test schedule (or wait for a real `board_sync` /
   `invoice_issuance` one already registered).
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

`node-schedule` is a declared dependency in `Backend/package.json` and is
**not used anywhere in `src/`.** It was evaluated and rejected for this
feature, deliberately, not overlooked:

An in-process timer (`node-schedule`, `node-cron`, or anything similar) fires
once **per running instance** of the app. Elastic Beanstalk can and does run
more than one instance. The moment it scales past one, an in-process timer
double-dispatches every scheduled job — every board sync would run twice,
every invoice would be issued twice. External triggering (EventBridge calling
one HTTP endpoint) avoids that entirely: however many instances are running,
exactly one of them handles a given tick request, and the claim logic in
`Backend/src/services/scheduler/tick.js` makes concurrent ticks from multiple
instances safe regardless.

Do not add a `node-schedule` call to wire this up "just for now." If the
unused dependency is ever removed, that is a separate, deliberate cleanup —
not something to route around here.

## Trap: a route in this repo must be mounted twice

`Backend/src/index.js` is the production entry point. It does **not** call
`createApp()` from `Backend/src/app.js` — they are two parallel Express apps
that happen to wire up nearly the same routes. `Backend/test/` builds its app
via `createApp()` (see `Backend/test/integration/scheduler.route.test.js:11`),
so a route mounted only in `app.js` is fully covered by the test suite and
**404s in production**, because `index.js` never mounted it.

The scheduler route is correctly mounted in both places:

- `Backend/src/app.js:127` — `app.use('/api/scheduler', schedulerRoutes);`
- `Backend/src/index.js:155` — `app.use('/api/scheduler', schedulerRoutes);`

During this work the route was initially added only to `app.js`. Every test
passed — the integration suite exercises `createApp()` — and the endpoint
would have 404'd in the deployed API. Nothing in the test run would have
caught it.

**If you add a new route to this backend, mount it in both `app.js` and
`index.js`, and manually check the deployed environment answers it** — a
green test suite does not prove `index.js` was touched. This is the single
most important thing to remember from this document if you are adding routes
rather than working with the scheduler specifically.

Also note `index.js` calls `registerSchedulerHandlers()` once at module load
(`Backend/src/index.js:48`) so the registry is populated before the first
tick can arrive. `createApp()` in `app.js` does not call it — tests register
their own handlers per-case via `register()` /
`clearRegistry()` (see `scheduler.route.test.js`).

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

**If `dev:build` did not fix it, check you have this branch's `scripts/dev.mjs`.**
The discard step used to be skipped whenever the project had no *running*
containers — and volumes outlive containers, so rebuilding a stopped stack
remounted the stale volume over the newly built image. The giveaway is a
`dev:build` whose output has no `==> discarding this project's
node_modules/.next volumes` line. That is fixed here; on an older commit, run
`docker compose down -v` first.

## Registering a handler

Handlers live in `Backend/src/services/scheduler/handlers.js`, imported for
its side effects at boot (`registerSchedulerHandlers()`, called once from
`Backend/src/index.js:48`, before any tick can arrive). The registered
example, `board_sync`:

```js
// Backend/src/services/scheduler/handlers.js
register('board_sync', {
  policy: AT_LEAST_ONCE,
  handler: ({ targetId, workspaceId }) =>
    triggerManualSync(getSchedulerAuthorization(), workspaceId, targetId),
});
```

Five rules apply to every handler. Only the first is enforced in code
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
  `models/AutomationSettings.js`), and `runOn` changes shape with it:

  | `unit` | `runOn` |
  |---|---|
  | `day` | ignored |
  | `week` | a weekday name, `'monday'` … `'sunday'` |
  | `month` | an integer day-of-month, **1–28** |
  | `quarter` | `{ month, day }` — `month` selects the month within the quarter cycle |
  | `year` | `{ month, day }` — month-of-year and day-of-month |

  The API validates these shapes in `utils/automationSettingsHelpers.js`
  (`validateRunOn`), and the arithmetic in `automationScheduleHelpers.js`
  reads exactly the same ones. They have to agree: a shape one accepts and the
  other cannot read is a save that throws, or a run at the wrong time.

**`runOn` is restricted to 1–28 for `month` — the single most valuable check
in the validator.** A monthly schedule on the 29th, 30th or 31st silently
skips whichever months are too short for it: every February for 29 or 30, most
of the year for 31. For invoice issuance that is not a cosmetic gap, it means a
client simply does not get billed that month, discovered only when someone
notices the missing invoice. The arithmetic clamps rather than rolling over if
such a value reaches it anyway (a `{month, day}` of 31 in February becomes the
28th, never 3 March), because rolling over shifts every subsequent run and can
fire twice in one calendar month.

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
| `AT_MOST_ONCE` | At claim, before the handler runs | `invoice_issuance` | A duplicated invoice sent to an NDIS participant is a client-facing incident. A lost run is a different kind of problem: it shows up in `missedRuns` and is recoverable by hand. |
| `AT_LEAST_ONCE` | Only after the handler's enqueue succeeds | `board_sync` | Board sync is idempotent and cheap to repeat. A silent skip just makes data staler — worse than an occasional duplicate that the idempotency guard absorbs anyway. |

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
  (see "Verifying a rule after creating it" above). It used to be the only
  option for an `AT_LEAST_ONCE` schedule, since `missedRuns` could not count
  for one; that is no longer true, and the two are now complementary —
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
