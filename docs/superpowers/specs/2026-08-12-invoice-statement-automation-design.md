# Invoice & Statement Automation — settings and scheduler wiring

**Ticket:** KAN-10 (Epic 5 — Invoice & Statement Automation tab)
**Date:** 2026-08-12
**Status:** Approved
**Branch:** `feature/KAN-10_invoice_statement_automation`
**Depends on:** [PR #855](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/855) (scheduled job trigger, KAN-15) — must merge before this does
**Supersedes:** Task 13 of [the finance-settings plan](../../plans/2026-08-06-finance-settings-automation-plan.md), which predates #855

## Goal

Let a client configure invoice and statement automation on the Finance Settings tab, and have a scheduler tick claim that schedule and enqueue work for every board in the workspace.

**Nothing is generated and nothing is sent.** The worker drains the queue and logs. PDF generation and SES delivery are Epic 5 parts 3–4 and are deliberately out of scope.

## Scope

**In:** 5.1–5.5 (both settings blocks, schedule and email fields, Save/Restore Defaults), and the wiring half of 5.6 — schedule persistence, handler registration, fan-out, queue.

**Out:** 5.6/5.7 generation and delivery, 5.8 document header, 5.9 pilot verification. Also excluded, per the ticket: Invoice scope, Eligible billing items, Statement type, Statement period, Transaction types.

## Context that changed since the plan

Three things make Task 13 of the plan stale:

| Plan assumed | Reality |
|---|---|
| Build `routes/internal.js`, `services/automation/scheduler.js` | #855 shipped `routes/scheduler.js` + `services/scheduler/*` + `ScheduledJob` |
| Add to `Backend/src/routes/automation.js` | That file already exists and proxies ISO+ **board** automation URLs — unrelated |
| `computeNextRun` to be written | Done — [PR #857](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/857) |

What is genuinely missing is a **handler and a queue**, not a scheduler.

## Decisions

### 1. `ScheduledJob` learns the picker shape

Epic 5 schedules are `every {n, unit}` anchored on `startDate`. **Cron cannot express this.** There is no cron expression for "every 2 weeks", and `*/3` in the month field means January/April/July/October, not "three months from this client's start date". Both are in the spec.

`ScheduledJob` therefore gains an optional picker representation alongside cron:

```js
cron:     { type: String, default: null }   // was required: true
schedule: {                                  // new, optional
  every:     { n: Number, unit: String },    // day|week|month|quarter|year (enum)
  runOn:     mongoose.Schema.Types.Mixed,    // weekday name | 1-28 | {month, day}
  runAt:     String,                         // "09:00"
  startDate: Date,
}
```

A schema-level validator requires **exactly one** of `cron` / `schedule`. Both, or neither, is a programming error and must not reach storage.

**Watch the existing validators.** #855's `timezoneIsValid` calls `isValidSchedule(this.cron, value)`, which breaks when `cron` is null. Both validators need a branch so a picker schedule validates its timezone standalone. This is the fiddliest part of the change and is why it is sequenced last.

Rejected alternatives: a second due-source querying `AutomationSettings` (two claim paths, two compare-and-swap implementations to keep correct); a placeholder cron string (a field that lies, and a validator that must special-case it).

### 2. One workspace schedule, fanning out to all boards

Invoices generate per board — every route is `/:workspaceId/:boardId` — but Finance Settings is workspace-scoped. One schedule per workspace, `targetId = workspaceId`; the handler enqueues one job per eligible board.

This matches #855's own comment on `targetId`: *"a boardId for board_sync, a workspaceId for invoice_issuance."*

**"Eligible board" means every board in the workspace.** There is deliberately no filter, because no eligibility concept exists in the data model — `Board` carries `syncData`, which governs ISO+ sync rather than billing, and inventing a billing flag is Epic 5 scope creep. Whether a board actually has anything to bill is a question for the generation step, which is out of scope here; until then the fan-out is uniform and the stub worker discards the difference.

If a real eligibility rule emerges during delivery, it belongs in `fanOut.js` alone — that is the reason fan-out is its own module rather than inlined in the handler.

Accepted cost: boards in one workspace cannot bill on different cycles. Revisit if a client asks.

### 3. `AT_LEAST_ONCE` with a per-board idempotency key

Fan-out breaks both delivery policies on its own. Under `AT_MOST_ONCE` a crash mid-fan-out advances the schedule with some boards never enqueued — a silently skipped billing month. Under plain `AT_LEAST_ONCE` a retry re-enqueues boards already done — duplicate invoices.

Safety comes from the key, not the policy:

```
jobId = `${kindPrefix}:${boardId}:${periodKey}`     // inv: | stmt:
```

The prefix varies by kind, so an invoice and a statement falling on the same slot for the same board are two distinct jobs rather than one silently deduped away.

**`periodKey` derives from the claimed slot, not from `now`.** It is the `nextRunAt` value that was claimed, formatted in the schedule's timezone (`20260812-0900`). A retry claims the same slot, produces the same key, and BullMQ drops the boards already enqueued while admitting the missing ones. Deriving it from `Date.now()` would produce a fresh key per retry and duplicate-bill every board that already succeeded.

The dedupe window is therefore the billing cycle itself, which is the correct granularity.

### 4. No `nextRun` field on `AutomationSettings`

The plan lists one. Storing it there *and* as `ScheduledJob.nextRunAt` creates two sources of truth for the value the tick claims on, and they will drift. `ScheduledJob.nextRunAt` owns it; the settings API computes the display value by reading the linked job. `Next Run` is read-only in the UI, so nothing is lost.

## Components

Routes go into the **already-mounted** `routes/workspace.js`, matching Arnold's `/:workspaceId/feature-toggles` precedent. This sidesteps the `index.js`/`app.js` dual-mount hazard entirely — the two files currently carry 22 and 21 `/api` mounts respectively, and #855 demonstrated the failure mode where a route exists in tests and 404s in production.

### Backend

| Module | Status | Responsibility |
|---|---|---|
| `models/AutomationSettings.js` | new | the document |
| `models/ScheduledJob.js` | modify | relax `cron`, add `schedule`, XOR validator, fix coupled validators |
| `utils/automationSettingsHelpers.js` | new · pure | parse + validate body, defaults, email validation, response shaping |
| `utils/automationPeriodKey.js` | new · pure | stable period key from the claimed slot |
| `routes/workspace.js` | modify | `GET`/`PUT /:workspaceId/automation-settings` — thin handlers |
| `services/automation/queue.js` | new | `automationQueue`, separate from `syncQueue` per R7 |
| `services/automation/fanOut.js` | new | workspaceId → one job spec per board, each with its dedupe key |
| `services/scheduler/handlers.js` | modify | register `invoice_automation` + `statement_automation` |
| `services/scheduler/advance.js` | new | route to `nextRun.js` (cron) or `automationScheduleHelpers` (picker) |
| `workers/automationWorker.js` | new · **stub** | drains, logs, sends nothing |

`advance.js` is extracted rather than branched inside `tick.js`, which is already near the cognitive-complexity limit of 15.

### Frontend

| Module | Status | Responsibility |
|---|---|---|
| `lib/automation-settings.ts` | new | types, fetch, save |
| `lib/automation-run-on-options.ts` | new · pure | `Run On` options per unit |
| `lib/automation-schedule-block.tsx` | new | the five schedule fields |
| `lib/automation-email-block.tsx` | new | recipient + email fields |
| `lib/invoice-statement-automation-panel.tsx` | new | composes both blocks, twice |
| `lib/finance-settings-page.tsx` | modify | swap `PlaceholderPanel` for the real panel |

Invoice and statement have identical field shapes (5.1/5.2 vs 5.3/5.4). The schedule and email blocks are built **once** and rendered twice; building them twice is the obvious way this goes wrong.

`Run On` gets its own pure module because its options change meaning with the selected unit — the fiddliest logic here, and it should be testable without rendering.

## Data flow

**Save** — `PUT /api/workspaces/:workspaceId/automation-settings`

```
body ──► parse()                        validate, defaults, inline email errors
          ▼
      AutomationSettings.upsert({workspaceId})
          ├─ invoice.enabled   ──► upsertSchedule('invoice_automation',   workspaceId, schedule)
          ├─ statement.enabled ──► upsertSchedule('statement_automation', workspaceId, schedule)
          └─ disabled          ──► disableSchedule(kind, workspaceId)
```

`upsertSchedule` / `disableSchedule` are #855's and are the only sanctioned writers of `ScheduledJob`. Timezone comes from #855's `resolveTimezone`, which already inherits `Business.headOfficeTimezone`.

**Read** — `GET` loads the settings, loads the two linked jobs, merges `nextRunAt` in as read-only `Next Run`.

**Fire** — `POST /api/scheduler/tick`

```
EventBridge ──► tick.js: claim {enabled, nextRunAt <= now}
                   ▼
               advance.js ─── cron?     ──► nextRun.js
                          └── schedule? ──► automationScheduleHelpers.computeNextRun
                   ▼   AT_LEAST_ONCE: advance only after dispatch succeeds
               handler('invoice_automation', {targetId, workspaceId})
                   ▼
               fanOut(workspaceId) ──► eligible boards
                   ▼   one job per board
               automationQueue.add(spec, {jobId: `inv:${boardId}:${periodKey}`})
                   ▼
               automationWorker ── logs, sends nothing
```

## Error handling

**Validation belongs to the write path.** #857 left `computeNextRun` falling back to daily on an unknown unit — deliberate, so one malformed document cannot stop the tick for every client. That fallback stays at read time, but three layers now prevent a bad unit being stored: `parse()` rejects with a 400 and a field message, and both `AutomationSettings` and `ScheduledJob.schedule.every.unit` declare an enum. Same treatment for `runOn` mismatched to its unit, malformed `runAt`, and both email fields (inline errors, per doc 5).

**The partial write is the failure that silently breaks billing.** A save writes the settings document and up to two `ScheduledJob` rows; if the second fails, the UI says "enabled" and nothing ever fires. Mongo transactions need a replica set and local dev is standalone, so instead:

1. **Write the schedule first, settings second.** A failed schedule write leaves the settings unchanged, so the UI keeps telling the truth.
2. **The handler tolerates the reverse.** A `ScheduledJob` firing with missing or disabled `AutomationSettings` no-ops and warns rather than throwing — a stale schedule costs a log line, not a retry storm.

| Case | Behaviour |
|---|---|
| Board list fetch fails | handler throws → no advance → next tick retries |
| Redis dies mid fan-out | handler throws → no advance → retry, dedupe absorbs completed boards |
| Zero eligible boards | **success**, count logged |
| Settings missing / disabled | no-op + warn, never throws |
| Invalid `headOfficeTimezone` | handled by #855's `resolveTimezone` — warns, falls back to Sydney |

Zero eligible boards counts as success deliberately: treating it as failure would climb `consecutiveFailures` on a workspace that is merely configured and idle, and Epic 6 alerts on that field.

**The stub worker completes its jobs** rather than leaving them pending, or the queue grows unbounded and BullMQ retries fire against a worker never meant to act. It carries a comment stating it is intentionally inert and what replaces it.

## Testing

Test-first throughout: write it, watch it fail for the expected reason, then implement.

**Characterize before replacing the placeholder.** The tab's gating — visible only when the flag is on, `?tab=automation` resolving back to `financial` when off — is merged behaviour. Arnold's `finance-settings-tab.test.ts` runs green against unmodified code first, so "swapping the panel did not change the gating" is evidence.

**Unit**

- `automationPeriodKey` — same claimed slot → same key; a DST boundary yields one key per slot; timezones do not collide
- `automationSettingsHelpers` — each unit accepted, unknown rejected, `runOn`/unit mismatch rejected, malformed `runAt` rejected, both emails validated, defaults applied
- `advance.js` — cron routes to `nextRun.js`, picker routes to `automationScheduleHelpers`
- `automation-run-on-options.ts` — options per unit, without rendering

**Model** — `ScheduledJob` XOR in four cases: cron only (valid), schedule only (valid), both (invalid), neither (invalid). Plus the timezone validator working when `cron` is null — the exact thing that breaks if `required` is relaxed without touching the validators. `AutomationSettings` gets defaults, enum rejection, unique `workspaceId`.

**Integration (supertest)** — GET with no document returns defaults; PUT creates settings and schedule; disabling removes it; a bad email returns 400 with a field-level error; GET merges `nextRunAt` as read-only.

**The double-fire test, which the plan demands explicitly** — invoke the tick twice concurrently, assert one job per board. This is the assertion the idempotency design exists to satisfy; if it fails, the design is wrong, not the test.

**E2E (Playwright)**, required for user-visible change — flag on → tab appears → configure → save → `Next Run` renders; flag off → tab absent.

**Coverage** — new backend modules go into `vitest.config.js`'s `include` list. That file has already collided twice (Arnold's merge, then #855); expect to resolve it once more on the final rebase.

## Open question to confirm before implementing

**Who may edit automation settings?** Arnold gated `/feature-toggles` behind `requirePortalOwnerOrSupport`, because *enabling* automation for a workspace is an admin decision (Epic 2.1). The automation *settings* are the client's own billing configuration, so this design assumes `authenticateToken` plus the existing workspace authorization — **not** owner-only.

Wrong in either direction is bad: too tight and clients cannot configure their own billing; too loose and it is a tenancy issue. Confirm before the route is written.

## Sequencing

The settings layer has no dependency on #855 — it needs only `computeNextRun`, already on this branch. So the work builds in dependency order and nothing waits:

1. `AutomationSettings` model + helpers + route *(buildable on today's `develop`)*
2. Frontend panel replacing the placeholder *(same)*
3. **Rebase once #855 merges**
4. `ScheduledJob` changes, `advance.js`, handler registration, fan-out, queue, stub worker

**This must not merge before #855.** Merging steps 1–2 alone would ship a state where a client can configure automation that provably cannot fire. That is a merge-blocking condition, not a ship-and-see.

## Follow-ups

1. **Mid-cycle schedule edits shift `periodKey`**, so a job could legitimately run twice across overlapping periods. Harmless while nothing sends; a real constraint on the delivery work.
2. **Disable mid-tick** — an already-claimed job still dispatches. Accepted, not solved.
3. **Boards in one workspace cannot bill on different cycles** — a consequence of decision 2.
4. **`missedRuns` stays zero under `AT_LEAST_ONCE`** (inherited from #855), so `lastRunAt` staleness is the signal for these schedules.
5. **`index.js` / `app.js` remain parallel apps.** Avoided here by using an already-mounted router, not fixed.
