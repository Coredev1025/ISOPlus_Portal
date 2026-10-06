# Invoice & Statement Automation Implementation Plan

> **Status: shipped.** This is the record of how KAN-10 was built, kept per
> [`CLAUDE.md`](../../CLAUDE.md)'s documentation layout. The implementation
> files it names all exist in the repo and have moved on since; read them for
> the code. What is kept here is the *ordering*, the constraint behind each
> step, and the assertions each test had to make — the parts a later reader
> cannot recover by opening the file. Where the shipped code departed from this
> plan, see "Departures, as shipped" at the end.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client configure invoice and statement automation on the Finance Settings tab, and have a scheduler tick claim that schedule and enqueue one job per board — generating and sending nothing.

**Architecture:** Settings live in a new `AutomationSettings` document per workspace. `ScheduledJob` (from PR #855) gains an optional picker-shaped `schedule` alongside its cron, because cron cannot express "every 2 weeks" or "every 3 months from a start date". A tick claims the job, a handler fans out to every board in the workspace, and each enqueued job carries a dedupe key derived from the claimed slot so a retry cannot double-bill.

**Tech Stack:** Node 20+ ESM, Express, Mongoose/MongoDB, BullMQ + Redis, Next.js 15 App Router, shadcn/ui, **Vitest** + `supertest` + `mongodb-memory-server`, Playwright.

**Spec:** [`docs/superpowers/specs/2026-08-12-invoice-statement-automation-design.md`](../superpowers/specs/2026-08-12-invoice-statement-automation-design.md)
**Ticket:** KAN-10
**Branch:** `feature/KAN-10_invoice_statement_automation`

## Constraints specific to this work

The repo-wide rules — complexity gate, ESM, test-first, commit format, no AI
attribution, `logger.js` over `console.log` — are in
[`CLAUDE.md`](../../CLAUDE.md) and [`docs/full-stack-engineering.md`](../full-stack-engineering.md).
They are not restated here. What is specific to this plan:

- **No new runtime dependencies.** Everything here uses what is already installed.
- **PHASE 2 MUST NOT START until PR #855 is merged to `develop` and this branch is rebased onto it.**
- **This branch must not merge before #855.** Phase 1 alone ships a UI that configures automation which provably cannot fire.

---

## Erratum against the spec

The spec says we call #855's `upsertSchedule` rather than writing `ScheduledJob`
directly. That remains true, **but `upsertSchedule` had to be extended first** —
it was cron-internal throughout: `isValidSchedule(cron, tz)`,
`assertMinimumInterval({ cron, ... })` and `computeNextRun(cron, tz, now)` all
took a cron expression as their first argument, with no branch for anything
else. Task 8 covers this. The spec's component table understates it as "call",
where the work is "extend, then call".

**Second, smaller erratum:** `assertMinimumInterval` computes the floor from a
cron expression. A picker schedule cannot violate it — the coarsest picker
cadence is `{n: 1, unit: 'day'}` = 1440 minutes, against floors of 60
(`AT_MOST_ONCE`) and 5 (`AT_LEAST_ONCE`). Task 8 therefore skips the floor check
for picker schedules, with that reasoning in a comment rather than silently.

---

## File Structure

### Phase 1 — settings layer (no dependency on #855)

| File | Responsibility |
|---|---|
| `Backend/src/models/AutomationSettings.js` | one document per workspace, two blocks |
| `Backend/src/utils/automationSettingsHelpers.js` | pure: parse, validate, defaults, response shaping |
| `Backend/src/routes/workspace.js` *(modify)* | `GET`/`PUT /:workspaceId/automation-settings` |
| `Frontend/lib/automation-settings.ts` | types, fetch, save |
| `Frontend/lib/automation-run-on-options.ts` | pure: `Run On` options per unit |
| `Frontend/lib/automation-schedule-block.tsx` | the five schedule fields |
| `Frontend/lib/automation-email-block.tsx` | recipient + email fields |
| `Frontend/lib/invoice-statement-automation-panel.tsx` | composes both blocks, twice |
| `Frontend/lib/finance-settings-page.tsx` *(modify)* | swap `PlaceholderPanel` for the real panel |

### Phase 2 — scheduler wiring (after #855 merges)

| File | Responsibility |
|---|---|
| `Backend/src/models/ScheduledJob.js` *(modify)* | optional `cron`, new `schedule`, XOR validator |
| `Backend/src/services/scheduler/schedules.js` *(modify)* | `upsertSchedule` accepts `schedule` |
| `Backend/src/services/scheduler/advance.js` | route cron vs picker to the right arithmetic |
| `Backend/src/utils/automationPeriodKey.js` | pure: stable key from the claimed slot |
| `Backend/src/services/redisConnection.js` | `buildRedisConnection()` for the new modules only |
| `Backend/src/services/automation/queue.js` | `automationQueue` |
| `Backend/src/services/automation/fanOut.js` | workspaceId → job specs |
| `Backend/src/services/scheduler/handlers.js` *(modify)* | register both kinds |
| `Backend/src/workers/automationWorker.js` | drains the queue and completes each job |
| `Backend/vitest.config.js` *(modify)* | coverage include |

### Locked names

Referenced across tasks; do not rename:

```
parseAutomationSettingsBody(body)        -> { error } | { value }
buildAutomationSettingsPayload(settings, jobs) -> object
DEFAULT_AUTOMATION_BLOCK                 -> object
automationPeriodKey({ slot, timezone })  -> string   e.g. "20260812-0900"
advanceSchedule(job, now)                -> Date
buildFanOutSpecs({ kind, workspaceId, boards, slot, timezone }) -> array
AUTOMATION_QUEUE_NAME = 'automation'
KIND_INVOICE   = 'invoice_automation'
KIND_STATEMENT = 'statement_automation'
runOnOptionsForUnit(unit)                -> array   (Frontend)
```

---

# PHASE 1 — settings layer

## Task 1: `AutomationSettings` model

**Files:**
- Create: `Backend/src/models/AutomationSettings.js`
- Test: `Backend/test/unit/models/automationSettings.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: default export `AutomationSettings` (Mongoose model), plus the
  `AUTOMATION_UNITS` / `SEND_METHODS` / `RECIPIENTS` enums the helpers reuse.
  Document shape: `{ workspaceId: String (unique), invoice: Block, statement: Block }`.

**The constraint the schema cannot state:** `runOn` is `Mixed` because its type
changes with the unit — a weekday name for `week`, a day number for `month`,
`{month, day}` for `quarter`/`year`. No Mongoose type expresses that
dependency, so the unit-appropriate shape is enforced on the write path in
`automationSettingsHelpers` instead. A reader who sees `Mixed` and adds a type
there will break three of the five units.

- [ ] **Step 1: Write the failing test.** Assertions:
  - a bare `new AutomationSettings({ workspaceId })` defaults both blocks to
    `enabled: false` and `every: { n: 1, unit: 'month' }`
  - `every.unit: 'fortnight'` rejects with a message naming `unit`
  - a document with no `workspaceId` rejects
- [ ] **Step 2: Run it and watch it fail** — `npx vitest run test/unit/models/automationSettings.test.js`, expecting `Cannot find module`.
- [ ] **Step 3: Implement the model.**
- [ ] **Step 4: Run it and watch it pass** — 3 tests.
- [ ] **Step 5: Commit** — `feat: AutomationSettings model for invoice and statement blocks`

---

## Task 2: Settings helpers — parse, validate, shape

**Files:**
- Create: `Backend/src/utils/automationSettingsHelpers.js`
- Test: `Backend/test/unit/utils/automationSettingsHelpers.test.js`

**Interfaces:**
- Consumes: `AUTOMATION_UNITS`, `SEND_METHODS`, `RECIPIENTS` from `models/AutomationSettings.js`
- Produces: `DEFAULT_AUTOMATION_BLOCK`; `parseAutomationSettingsBody(body)` → `{ error }` or `{ value: { invoice, statement } }`; `buildAutomationSettingsPayload(settings, jobs)` → `{ invoice, statement }` with `nextRun` merged in, where `jobs` is `{ invoice_automation?: {nextRunAt}, statement_automation?: {nextRunAt} }`

**Two constraints not recoverable from the code:**

- **A disabled block is not validated at all.** A client turning automation off
  must not be blocked by a field they have stopped using — and the panel does
  not render those fields while disabled, so a stored malformed value could
  never be corrected and would leave Save permanently dead.
- **`nextRun` is never stored on `AutomationSettings`.** `ScheduledJob.nextRunAt`
  is the single source of truth, because it is the value the tick claims on.
  `buildAutomationSettingsPayload` merges it in for display only. Storing a
  second copy is how the panel comes to show a run that will not happen.

- [ ] **Step 1: Write the failing test.** `parseAutomationSettingsBody` assertions:
  - accepts a valid weekly block, `error` undefined, unit preserved
  - rejects an unknown unit, naming `unit`
  - rejects a weekday `runOn` when the unit is `month`, naming `runOn`
  - rejects a `runOn` outside the month range, naming `runOn`
  - rejects a malformed `runAt` (`'9am'`), naming `runAt`
  - rejects a malformed `sendCopyTo`, naming `sendCopyTo`
  - fills a missing block from `DEFAULT_AUTOMATION_BLOCK`
  - does **not** validate schedule fields of a disabled block

  `buildAutomationSettingsPayload` assertions:
  - merges `nextRunAt` from the linked job as read-only `nextRun`, and leaves
    `nextRun` null for the kind with no job
- [ ] **Step 2: Run it and watch it fail** — module not found.
- [ ] **Step 3: Implement the helpers.** Keep each function small; the complexity gate is 15 per file.
- [ ] **Step 4: Run it and watch it pass** — 9 tests.
- [ ] **Step 5: Commit** — `feat: validate and shape automation settings on the write path`

---

## Task 3: `GET` / `PUT` routes

**Files:**
- Modify: `Backend/src/routes/workspace.js` (append after the `feature-toggles` handlers)
- Test: `Backend/test/integration/workspace.automation-settings.route.test.js`

**Interfaces:**
- Consumes: `parseAutomationSettingsBody`, `buildAutomationSettingsPayload` (Task 2); `AutomationSettings` (Task 1); existing `parseWorkspaceIdParam`, `authenticateToken`, `sanitizeLogValue`, `info`, `error` already imported in this file
- Produces: `GET /api/workspaces/:workspaceId/automation-settings` → 200 `{invoice, statement}`; `PUT` same path → 200 with the saved payload, 400 `{message}` on validation failure

**Authorization decision (resolving the spec's open question):** these routes
use `authenticateToken` **only** — not `requireOwnerOrSupportAdmin`. Automation
settings are the client's own billing configuration. The owner/support gate
stays on `/feature-toggles`, which controls whether the tab exists at all.

**A deliberate placeholder:** both handlers pass `{}` as the second argument to
`buildAutomationSettingsPayload`. Schedules do not exist until Phase 2, so
`nextRun` is legitimately null here. Task 13 replaces it — this is not an
oversight to "fix" if you meet it mid-plan.

- [ ] **Step 1: Write the failing test.** Assertions:
  - `GET` with no document returns 200 with `invoice.enabled === false` and `invoice.nextRun === null`
  - `PUT` of a valid enabled block returns 200, echoes `runOn`, and the document is stored
  - `PUT` with `sendCopyTo: 'nope'` returns 400 and the message names `sendCopyTo`
  - an unauthenticated `GET` returns 401
- [ ] **Step 2: Run it and watch it fail** — 404 on both routes.
- [ ] **Step 3: Add the imports** for `AutomationSettings` and the two helpers.
- [ ] **Step 4: Add the two handlers** after the `feature-toggles` PUT handler. Both resolve `parseWorkspaceIdParam` first, use `{ $eq: workspaceId }` in the query, and log failures through `error(...)` with `sanitizeLogValue`.
- [ ] **Step 5: Run it and watch it pass** — 4 tests.
- [ ] **Step 6: Commit** — `feat: read and write automation settings per workspace`

---

## Task 4: `Run On` options (Frontend, pure)

**Files:**
- Create: `Frontend/lib/automation-run-on-options.ts`
- Test: `Frontend/test/unit/lib/automation-run-on-options.test.ts`

**Interfaces:**
- Produces: `AutomationUnit` type; `runOnOptionsForUnit(unit)` → `{ kind, options, months? }`; `defaultRunOnForUnit(unit)`

**Why these lists live here and not in `constants/automation.ts`:** they are
derived structures — `runOnOptionsForUnit` is the only thing that reads them,
and keeping them beside it is what stops a sixth unit being added without the
switch learning about it. See the Constants section of `CLAUDE.md`.

- [ ] **Step 1: Write the failing test.** Assertions:
  - `day` yields `kind: 'none'` and no options
  - `week` yields seven weekday options starting Monday
  - `month` yields `kind: 'day-of-month'`
  - `quarter` and `year` both yield `kind: 'month-day'`
  - `defaultRunOnForUnit` returns a unit-appropriate default: `'monday'`, `1`, `{month: 1, day: 1}`
- [ ] **Step 2: Run it and watch it fail** — cannot resolve the module.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Commit** — `feat: Run On options that change with the selected unit`

---

## Task 5: Settings client and types (Frontend)

**Files:**
- Create: `Frontend/lib/automation-settings.ts`
- Test: `Frontend/test/unit/lib/automation-settings.test.ts`

**Interfaces:**
- Consumes: `AutomationUnit` (Task 4); the shared axios instance at `@/app/utils/axiosConfig`
- Produces: `AutomationBlock` and `AutomationSettings` types; `fetchAutomationSettings(workspaceId)`; `saveAutomationSettings(workspaceId, settings)`; `DEFAULT_BLOCK`

**Use the shared axios instance, never bare `fetch`:** it sets
`withCredentials = true`, which is what sends the session cookie. A direct
`fetch` here authenticates as nobody and 401s.

- [ ] **Step 1: Write the failing test.** Assertions:
  - `fetchAutomationSettings` calls `axios.get` with a URL containing `/api/workspaces/ws-1/automation-settings`
  - `saveAutomationSettings` `PUT`s to the same path with the settings object as the body
- [ ] **Step 2: Run it and watch it fail** — cannot resolve `@/lib/automation-settings`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and watch it pass** — 2 tests.
- [ ] **Step 5: Commit** — `feat: automation settings client and types`

---

## Task 6: The panel, replacing Arnold's placeholder

**Files:**
- Create: `Frontend/lib/automation-schedule-block.tsx`
- Create: `Frontend/lib/automation-email-block.tsx`
- Create: `Frontend/lib/invoice-statement-automation-panel.tsx`
- Modify: `Frontend/lib/finance-settings-page.tsx` (the `TabsContent value="automation"` block)
- Test: `Frontend/test/unit/lib/invoice-statement-automation-panel.test.tsx`

**Interfaces:**
- Consumes: `runOnOptionsForUnit`, `defaultRunOnForUnit` (Task 4); `fetchAutomationSettings`, `saveAutomationSettings`, `DEFAULT_BLOCK`, types (Task 5)
- Produces: `<InvoiceStatementAutomationPanel workspaceId={string} />`

**The schedule and email blocks are built once and rendered twice** — invoice
and statement have identical field shapes (5.1/5.2 vs 5.3/5.4). Building them
twice is the obvious way this goes wrong.

**When the unit changes, set `runOn` to `defaultRunOnForUnit(nextUnit)` in the
same update.** Carrying a weekday into a monthly schedule silently misfires the
job — the schedule looks configured and fires on the wrong day.

**Do not render the excluded fields**: Invoice scope, Eligible billing items,
Statement type, Statement period, Transaction types. They are in the mockup and
out of this ticket's scope.

- [ ] **Step 1: Characterize the existing gating first.** Run Arnold's gating tests against unmodified code so "swapping the panel did not change the gating" is evidence, not assertion.
  Run: `cd Frontend && npx vitest run test/unit/finance-settings-tab.test.ts test/unit/lib/finance-settings-page.test.tsx` — record the counts; they must be identical after Step 7.
- [ ] **Step 2: Write the failing test.** Assertions, with `fetchAutomationSettings`/`saveAutomationSettings` mocked:
  - renders both the Invoice Automation and Statement Automation blocks
  - `Next Run` is present and carries `readonly`
  - Save Changes calls `saveAutomationSettings` once, with both blocks in one payload
  - Restore Defaults resets the form and calls `saveAutomationSettings` **not at all**
- [ ] **Step 3: Run it and watch it fail** — cannot resolve the panel module.
- [ ] **Step 4: Build the two reusable blocks.**
  `automation-schedule-block.tsx` — props `{ label, value, onChange }`. Renders an enable `Switch`; `Generate Every` as a number input plus a unit `Select`; `Run On` driven by `runOnOptionsForUnit(value.every.unit)`, hidden when `kind === 'none'`; `Run At` as `<input type="time">`; `Start Date` as `<input type="date">`; `Next Run` as a read-only input showing an em dash when null.
  `automation-email-block.tsx` — props `{ value, onChange }`. Renders `Recipient` and `Send Method` selects and the free-text email fields, each showing an inline error when non-empty and failing the address pattern.
- [ ] **Step 5: Build the panel.** It owns the fetch, the two `onChange` handlers, Save and Restore Defaults.
- [ ] **Step 6: Swap the placeholder** in `finance-settings-page.tsx`. Leave the surrounding `{automationEnabled ? … : null}` gating untouched — that is Arnold's Epic 2 behaviour and Step 1 pinned it.
- [ ] **Step 7: Run the new tests and the characterization tests together.** The two characterization files must report the **same counts as Step 1**. If `finance-settings-page.test.tsx` fails because it asserted on placeholder copy, update that assertion — but confirm the gating assertions still pass untouched.
- [ ] **Step 8: Commit** — `feat: real Invoice & Statement Automation panel in place of the placeholder`

---

## Task 7: End-to-end test (Playwright)

**Files:**
- Create: `Frontend/e2e/invoice-statement-automation.spec.ts`

**Interfaces:**
- Consumes: the running local stack (`npm run dev:up`), a workspace with the feature flag enabled

A user-visible change needs an end-to-end test — a feature with perfect unit
tests that nothing links to is not done.

- [ ] **Step 1: Write the failing test.** Two cases:
  - with the flag on: `/workspace/:id/finance-settings?tab=automation` shows the tab and the Invoice Automation block; filling `Generate Invoices Every` and pressing Save leaves `Next Run` read-only
  - with the flag off (skipped unless `E2E_WORKSPACE_ID_NO_FLAG` is set): the tab is absent
- [ ] **Step 2: Run it and watch it fail.** Bring the stack up with `npm run dev:up` from the repo root first.
- [ ] **Step 3: Fix whatever the e2e run exposes.** Likely candidates: label text not matching `getByLabel`, or the tab name differing from Arnold's copy. **Fix the component, not the assertion** — unless the assertion genuinely encoded the wrong expectation, in which case say which and why.
- [ ] **Step 4: Run it and watch it pass** — 1 passed, 1 skipped.
- [ ] **Step 5: Commit** — `test: end-to-end coverage for the automation tab`

---

## CHECKPOINT — Phase 1 complete

- [ ] Run the full backend suite: `cd Backend && npx vitest run` — expect all green.
- [ ] Run the full frontend suite: `cd Frontend && npx vitest run` — expect all green.
- [ ] **Do not open a PR for merge yet.** Phase 1 alone ships a UI that configures automation which cannot fire.
- [ ] **Wait for PR #855 to merge to `develop`.**
- [ ] Then rebase, following the repo recipe in [`CLAUDE.md`](../../CLAUDE.md) ("Keeping a branch current"). Expect one conflict, in `Backend/vitest.config.js` — union both sides. The `git diff backup/… HEAD` step should then show only that union.

---

# PHASE 2 — scheduler wiring

**Do not start until #855 is merged and the rebase above is done.**

## Task 8: `ScheduledJob` learns the picker shape

**Files:**
- Modify: `Backend/src/models/ScheduledJob.js`
- Test: `Backend/test/unit/models/scheduledJob.test.js` (extend the existing file)

**Interfaces:**
- Produces: `ScheduledJob` accepting **exactly one** of `cron` (String) or `schedule` (`{ every: {n, unit}, runOn, runAt, startDate }`)

**Three constraints the schema cannot express, and each is why a validator
looks odd:**

- `cron` loses `required: true`, so its own validator must return `true` for
  null/undefined and let the document-level exactly-one check own that case.
  A validator that rejects null would make every picker job invalid.
- A picker schedule still needs a real IANA zone, but `isValidSchedule` needs a
  cron to parse. The timezone validator therefore probes with a trivially valid
  expression (`* * * * *`) so the zone is checked in isolation.
- The exactly-one check reads `this.schedule?.every?.unit` rather than
  `this.schedule` — Mongoose materialises an empty subdocument, so a truthiness
  test on the subdocument itself passes for a job that has no picker schedule.

- [ ] **Step 1: Write the failing tests,** appended to the existing file. Assertions:
  - a cron-only job validates
  - a schedule-only job validates
  - a job with **both** rejects, matching `/exactly one/i`
  - a job with **neither** rejects, matching `/exactly one/i`
  - a schedule-only job with `timezone: 'Not/AZone'` rejects on timezone (the case the probe exists for)
  - an unknown `every.unit` rejects
- [ ] **Step 2: Run and watch it fail** — the cron-only case passes; everything else fails because `cron` is still `required: true` and `schedule` does not exist.
- [ ] **Step 3: Modify the model** — drop `required` from `cron`, add the `schedule` subdocument (`_id: false`), add the two branched validators and a `pre('validate')` hook for the exactly-one rule.
- [ ] **Step 4: Run and watch it pass** — the existing tests plus the 6 new ones.
- [ ] **Step 5: Commit** — `feat: ScheduledJob accepts a picker schedule as well as cron`

---

## Task 9: `upsertSchedule` accepts a picker schedule

**Files:**
- Modify: `Backend/src/services/scheduler/schedules.js`
- Create: `Backend/src/services/scheduler/advance.js`
- Test: `Backend/test/unit/services/scheduler.advance.test.js`
- Test: `Backend/test/unit/services/scheduler.schedules.test.js` (extend)

**Interfaces:**
- Consumes: `computeNextRun(cron, timezone, from)` from `scheduler/nextRun.js`; `computeNextRun(settings, from, timezone)` from `utils/automationScheduleHelpers.js`
- Produces: `advanceSchedule(job, now)` → `Date`; `upsertSchedule({ kind, targetId, workspaceId, cron?, schedule?, timezone, now })`

**Why `advance.js` exists as its own module: the two `computeNextRun` functions
take their arguments in different orders.** Absorbing that in one place is most
of the reason for the file — inlining either call at a second site is how the
timezone ends up in the `from` slot.

**`assertMinimumInterval` is called only on the cron branch,** per the second
erratum above. Put the reasoning in a comment at the call site rather than
letting it read as an omission.

- [ ] **Step 1: Write the failing test for `advance.js`.** Assertions:
  - a cron job routes to cron arithmetic and lands on the next 09:00 Sydney
  - a picker job routes to picker arithmetic and returns an instant after `now`
  - a job with neither throws, matching `/exactly one/i`
- [ ] **Step 2: Run and watch it fail** — module not found.
- [ ] **Step 3: Implement `advance.js`.**
- [ ] **Step 4: Run and watch it pass** — 3 tests.
- [ ] **Step 5: Extend `upsertSchedule`** — accept `schedule` alongside `cron`, throw when both or neither are given, run the cron-only validation on the cron branch, and take the initial `nextRunAt` from `advanceSchedule`.
- [ ] **Step 6: Add a round-trip test** to `scheduler.schedules.test.js`. Assertions:
  - a picker upsert stores `cron: null`, the picker `every.unit`, and a `Date` `nextRunAt`
  - an upsert given both cron and schedule rejects, matching `/exactly one/i`
- [ ] **Step 7: Run the scheduler suite** — `npx vitest run test/unit/services/scheduler.*.test.js`. **Existing cron behaviour must be unchanged**; that is what the pre-existing tests in this file are for.
- [ ] **Step 8: Commit** — `feat: upsertSchedule accepts picker schedules via a shared advance step`

---

## Task 10: The period key

**Files:**
- Create: `Backend/src/utils/automationPeriodKey.js`
- Test: `Backend/test/unit/utils/automationPeriodKey.test.js`

**Interfaces:**
- Produces: `automationPeriodKey({ slot, timezone })` → `string` of the form `YYYYMMDD-HHmm`

**This is the load-bearing part of the idempotency design.** The key derives
from the **claimed slot**, never from `Date.now()`. A retry claims the same
slot, produces the same key, and BullMQ drops the boards already enqueued.
Deriving it from the current time produces a fresh key per retry and
duplicate-bills every board that already succeeded — a billing incident, not a
cosmetic bug.

It is formatted in the schedule's own timezone so two workspaces in different
zones cannot collide on the same instant. Note that `Intl` renders hour `24`
for midnight in some engines; the implementation normalises that to `00`.

- [ ] **Step 1: Write the failing test.** Assertions:
  - formats the slot in the schedule timezone (`2026-08-11T23:00Z` → `20260812-0900` for Sydney)
  - is stable — the same instant always yields the same key
  - distinguishes two slots on the same day
  - does not collide across timezones for the same instant (Sydney vs Perth)
  - yields one key per slot across a DST boundary
- [ ] **Step 2: Run and watch it fail** — module not found.
- [ ] **Step 3: Implement,** with the "never `Date.now()`" rule stated in the docblock — this is the one comment in the feature that must survive.
- [ ] **Step 4: Run and watch it pass** — 5 tests.
- [ ] **Step 5: Commit** — `feat: stable per-slot period key for automation idempotency`

---

## Task 11: Queue and fan-out

**Files:**
- Create: `Backend/src/services/automation/queue.js`
- Create: `Backend/src/services/automation/fanOut.js`
- Test: `Backend/test/unit/services/automation.fanOut.test.js`

**Interfaces:**
- Consumes: `automationPeriodKey` (Task 10); `Board` model
- Produces: `AUTOMATION_QUEUE_NAME`, `getAutomationQueue()`; `KIND_INVOICE`, `KIND_STATEMENT`, `KIND_PREFIX`; `buildFanOutSpecs({ kind, workspaceId, boards, slot, timezone })` → `Array<{ name, data, opts: { jobId } }>`

**Four decisions, none visible in the resulting code:**

- **A separate queue from `syncQueue`, per R7** — a stuck sync backlog must not
  delay billing.
- **`redisConnection.js` is a builder, not a shared instance.** BullMQ Workers
  issue blocking commands and cannot share a connection with a Queue. That is
  why `syncWorker.js` already duplicates ~60 lines of `sync/queue.js`'s config
  rather than importing its `redisConnection` export.
- **Do not retrofit `sync/queue.js` or `syncWorker.js` onto the new builder.**
  That is an unrequested refactor of code this ticket does not otherwise touch.
  Mirror whatever `sync/queue.js` actually reads for cluster/TLS options — copy
  its option names verbatim rather than inventing them.
- **The queue is lazily constructed** so importing the module in a test does not
  open a Redis connection.
- **The `inv:`/`stmt:` jobId prefix** keeps an invoice and a statement falling
  on the same slot for the same board as two jobs rather than one silently
  deduped away.
- **Every board is included, with no eligibility filter.** No eligibility
  concept exists in the data model — `Board.syncData` governs ISO+ sync, not
  billing — and inventing a billing flag is out of scope. Whether a board has
  anything to bill is the generation step's question. If a real eligibility
  rule ever appears, `buildFanOutSpecs` is the only place it goes.

- [ ] **Step 1: Write the failing test.** Assertions:
  - one spec per board, each carrying `{ workspaceId, boardId }` in `data`
  - each `opts.jobId` is `inv:<boardId>:<periodKey>`
  - the same slot yields the same jobIds across two calls
  - invoice and statement on the same slot and board do **not** collide (`stmt:` prefix)
  - a workspace with no boards yields `[]`
- [ ] **Step 2: Run and watch it fail** — module not found.
- [ ] **Step 3: Extract `Backend/src/services/redisConnection.js`** for the new code only.
- [ ] **Step 4: Implement the queue.**
- [ ] **Step 5: Implement fan-out.**
- [ ] **Step 6: Run and watch it pass** — 5 tests.
- [ ] **Step 7: Commit** — `feat: automation queue and per-board fan-out with idempotency keys`

---

## Task 12: Handler registration and the worker

**Files:**
- Modify: `Backend/src/services/scheduler/handlers.js`
- Create: `Backend/src/workers/automationWorker.js`
- Test: `Backend/test/unit/services/automation.handler.test.js`

**Interfaces:**
- Consumes: `register`, `AT_LEAST_ONCE` from `scheduler/registry.js`; `buildFanOutSpecs`, `KIND_INVOICE`, `KIND_STATEMENT`, `getAutomationQueue`; `AutomationSettings`; `Board`
- Produces: registrations for both kinds; `runAutomationKind` (exported for tests); `startAutomationWorker()`

**Three failure modes this task is shaped around:**

- **A stale schedule must not throw.** Under `AT_LEAST_ONCE` a throw means no
  advance, so a schedule whose settings are gone or disabled would be retried
  on every tick, forever. It warns and returns.
- **Zero boards is success, not failure.** Treating it as failure climbs
  `consecutiveFailures` on a workspace that is merely configured and idle, and
  Epic 6 alerts on that field.
- **`AT_LEAST_ONCE` is chosen despite a duplicate invoice being worse than a
  late one.** Fan-out breaks both policies on its own: under at-most-once a
  crash mid-fan-out advances the schedule with some boards never enqueued — a
  silently skipped billing month — and under plain at-least-once a retry
  re-enqueues the boards already done. The safety comes from the per-board
  `jobId`, not from the policy. Given that key, missing a month is the only
  failure left worth designing against.

- [ ] **Step 1: Write the failing test,** mocking `services/automation/queue.js` so `addBulk` is observable. Assertions:
  - two boards → one `addBulk` call carrying two specs
  - no boards → resolves, `addBulk` never called
  - missing settings → resolves without throwing, `addBulk` never called
  - disabled block → resolves, `addBulk` never called
  - **the double-fire assertion:** two concurrent dispatches of the *same slot*
    produce the **same** `jobId`. This is what makes BullMQ collapse them into
    one job. If it fails, the idempotency design is wrong, not the test.
- [ ] **Step 2: Run and watch it fail** — `runAutomationKind` is not exported.
- [ ] **Step 3: Implement the handler** and call `registerAutomationHandlers()` from inside the existing `registerSchedulerHandlers()`.
- [ ] **Step 4: Implement the worker.** At this point in the plan it only drains and logs — PDF generation and email are Epic 5 parts 3–4. It exists so enqueued jobs are completed rather than accumulating and triggering BullMQ retry/backoff against a consumer that was never meant to act. **Retained job records are the trap here:** a job that completes without doing the work still consumes its jobId permanently, so the first real run of that period would be deduped away against the empty one. (See "Departures, as shipped" — this is where the plan and the shipped code diverge most.) Start it alongside the sync worker in `src/index.js`.
- [ ] **Step 5: Run and watch it pass** — 5 tests.
- [ ] **Step 6: Commit** — `feat: register automation handlers and drain the automation queue`

---

## Task 13: Wire saving to the scheduler

**Files:**
- Modify: `Backend/src/routes/workspace.js` (the `PUT` handler from Task 3, and the `GET`)
- Modify: `Backend/src/utils/automationSettingsHelpers.js` (add `toScheduleInput`)
- Test: `Backend/test/integration/workspace.automation-settings.route.test.js` (extend)

**Interfaces:**
- Consumes: `upsertSchedule`, `disableSchedule` (Task 9); `KIND_INVOICE`, `KIND_STATEMENT`
- Produces: `toScheduleInput(block)` → `{ every, runOn, runAt, startDate }`

**Ordering matters: write the schedule first, settings second.** A failed
schedule write then leaves the settings unchanged, so the UI keeps telling the
truth rather than claiming "enabled" for something that will never fire. The
fourth test below is the one that pins this ordering.

**A schedule validation error is a 400, not a 500** — it is caused by the
request body. Match on the scheduler's own message shapes (`invalid schedule`,
`exactly one`, `minimum interval`) before falling through to the existing 500
path.

- [ ] **Step 1: Write the failing test.** Assertions:
  - enabling a block creates a `ScheduledJob` with `enabled: true`, `cron: null` and the picker `every.unit`
  - turning the block off leaves the job present but `enabled: false`
  - `GET` afterwards returns a non-null `nextRun` from the linked job
  - a request whose schedule fails validation returns 400 **and stores no settings at all**
- [ ] **Step 2: Run and watch it fail** — no `ScheduledJob` is written; `nextRun` is null.
- [ ] **Step 3: Add `toScheduleInput`** to the helpers — the `ScheduledJob.schedule` projection of a settings block.
- [ ] **Step 4: Wire the `PUT` handler** — loop both kinds, `upsertSchedule` when enabled and `disableSchedule` when not, *then* write the settings, then reload the jobs for the response.
- [ ] **Step 5: Add `loadAutomationJobs(workspaceId)`** and replace the `{}` placeholder from Task 3 in the `GET` handler.
- [ ] **Step 6: Run and watch it pass** — the 4 tests from Task 3 plus the 4 new ones.
- [ ] **Step 7: Commit** — `feat: saving automation settings creates and disables the schedule`

---

## Task 14: Coverage config and final verification

**Files:**
- Modify: `Backend/vitest.config.js`

- [ ] **Step 1: Add the new modules to `coverage.include`,** keeping the file's existing grouping — services with services, utils with utils. `src/services/scheduler/**/*.js` is already present from #855 and covers `advance.js`.
- [ ] **Step 2: Run the full backend suite** — `cd Backend && npx vitest run`. Record the counts for the PR body.
- [ ] **Step 3: Run the full frontend suite** — `cd Frontend && npx vitest run`.
- [ ] **Step 4: Run the e2e suite** — `npm run dev:up` from the repo root, then `cd Frontend && npx playwright test`.
- [ ] **Step 5: Verify the complexity gate.** Every new file must sit under cognitive complexity 15. If `workspace.js` has grown past it, extract the two handlers' bodies into `automationSettingsHelpers.js` — do not restructure unrelated parts of the file.
- [ ] **Step 6: Commit and update the PR.** PR #857's body describes only `computeNextRun`; it needs the full scope, the real verification output from Steps 2–4, and the statement that it must not merge before #855.

---

## Self-review notes

**Spec coverage.** Every section of the spec maps to a task: data model → Tasks
1 and 8; components → Tasks 1–6 and 9–12; data flow save/read → Tasks 3 and 13,
fire → Tasks 9–12; error handling → Tasks 2, 12, 13; testing → every task, plus
Task 7 for e2e. The spec's open question on authorization is resolved
explicitly in Task 3.

**Two errata against the spec**, recorded at the top: `upsertSchedule` needed
extending rather than merely calling, and `assertMinimumInterval` is cron-only
and is skipped for picker schedules with reasoning.

**Third erratum, found during self-review.** An earlier draft imported
`buildRedisConnection` from `sync/queue.js`. That function does not exist —
`sync/queue.js` exports a shared `redisConnection` *instance*, and
`syncWorker.js` duplicates ~60 lines of config to get its own, because BullMQ
Workers block on their connection and cannot share one. Task 11 now adds
`services/redisConnection.js` for the new modules only, deliberately not
retrofitting the sync modules.

**Deliberately deferred**, carried from the spec: mid-cycle schedule edits
shifting `periodKey`; disable-mid-tick still dispatching; boards in one
workspace unable to bill on different cycles; `missedRuns` staying zero under
`AT_LEAST_ONCE`.

---

## Departures, as shipped

Recorded per `CLAUDE.md`: a plan kept after merge has to say where the code
went somewhere else, or it becomes a confident description of software that
does not exist.

- **The day-of-month range is 1–31, not 1–28.** The plan capped it at 28 because
  a cron schedule on the 29th–31st silently skips short months, which for
  invoicing means a client is not billed. The picker does not have that
  weakness: `addMonthsClamped` in `automationScheduleHelpers.js` shortens the
  day to the target month's length, so "the 31st" fires on 30 April and on 28
  or 29 February. The cap was widened deliberately once the clamp existed
  (commit `ceaefe3`), in `validateRunOn` and in `automation-run-on-options.ts`
  together. See `docs/scheduling.md`, "The picker schedule".
- **The worker is not inert.** Task 12 described a worker that logs and stops.
  What shipped generates the invoice or statement PDFs for the claimed period
  and writes a composed email to the offline outbox
  (`Backend/.local-s3/outbox/…`). The retained-jobId trap noted in Task 12 is
  why: a worker that completes jobs without doing the work permanently consumes
  the period's jobIds. Delivery over SES is still unimplemented. See the
  `testing-kan10-end-to-end` skill for the terminal observable.
- **`senderIdentityId` is gone.** Tasks 1 and 5 both carried it as a nullable
  phase-2 placeholder. It shipped with no reader and was deleted in the
  over-engineering review; a nullable field needs no migration, so it can
  arrive with phase 2.
- **The email pattern moved and changed.** The plan inlined
  `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` in both the helpers and the email block. It is
  now one `EMAIL_PATTERN` per app — `Backend/src/constants/validation.js` and
  `Frontend/constants/validation.ts` — and the domain is spelled as
  dot-separated labels, because the original backtracked super-linearly
  (SonarJS S5852).
- **The frontend constants moved out of `lib/`** into
  `Frontend/constants/automation.ts`, per the Constants section of `CLAUDE.md`,
  which post-dates this plan.
- **`saveAutomationSettings` no longer PUTs the settings object verbatim.** It
  strips the scheduler-owned read-only fields first (`toAutomationSavePayload`
  / `READ_ONLY_BLOCK_FIELDS`), so a Save cannot overwrite run state no user
  typed.
- **`buildFanOutSpecs` gained a `schedule` argument**, which the worker needs to
  resolve the completed billing period from the claimed slot.
- **The panel renders no form until the GET resolves.** The plan's version held
  `DEFAULT_BLOCK` while loading, which meant a Save from that state would
  disable both live schedules and erase their email configuration. It now shows
  a skeleton while loading and an alert if the load fails.
