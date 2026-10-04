---
name: testing-kan11-end-to-end
description: >-
  Use when testing KAN-11 Visibility & Monitoring (Epic 6) — the System Health
  overview tiles, scheduler heartbeat, Xero connection grid, the per-client
  drill-down, Retry on a failed run, delivery-failure reporting, or the
  admin-only gating — locally or on portal-dev. Also use when a run's history
  looks stuck at `queued`, or when asked what a passing KAN-11 result looks
  like.
---

# Testing KAN-11 end to end

Visibility & Monitoring (Epic 6). An `AutomationRun` record per board per
period, and the admin-only screens that read it. These screens report on the
runs KAN-10 produces, so the way to *cause* a run is in
[`testing-kan10-end-to-end.md`](testing-kan10-end-to-end.md) (local) and
[`testing-kan10-portal-dev.md`](testing-kan10-portal-dev.md) (portal-dev).

## What is being tested

| Screen | Where |
|---|---|
| Overview — tiles, scheduler heartbeat, Xero connection grid | Dashboard → **System Health** tab |
| Per-client drill-down — schedule, paged run history, Retry | `/workspace/<id>/system-health` |

Both are gated on `isOwnerOrSupport`. The API routes in
`Backend/src/routes/systemHealth.js` sit behind `authenticateToken` +
`requireOwnerOrSupport`.

## Signing in

**Sign in via SSO** — **Support agent sign-in** (Google) on the login screen.
On portal-dev that is the only way in. If a session has expired (portal-dev
sessions are short), sign in again rather than working around it.

## Setup

Local:

```bash
npm run dev:up
curl -sS localhost:4001/api/healthcheck          # {"status":"OK"}
```

Two quiet prerequisites in `Backend/.env`, the same as KAN-10:
`SCHEDULER_API_KEY` (any non-empty string) and `AUTOMATION_ENABLED=true`, each
followed by `docker compose up -d --force-recreate --no-deps backend` —
`restart` does not re-read env files.

From a worktree, read the ports and database from **that worktree's** root
`.env` (`FRONTEND_PORT`, `BACKEND_PORT`, `MONGO_DB`). Anything that shells into
`isoplus-mongo` directly needs `MONGO_DB`, or it writes to
`business-dashboard` while the app reads the worktree's own database — the
write succeeds and every assertion fails as though the UI never rendered.

portal-dev: confirm the build under test is actually deployed before testing
against it. See *Environment* in
[`testing-kan10-portal-dev.md`](testing-kan10-portal-dev.md).

## 1. Test the empty state first

`AutomationRun` starts empty; history begins at the first fan-out. Two states
are only reachable **before** you tick, and cannot be got back without clearing
the collection:

1. **Scheduler heartbeat with `lastTickAt: null`.** The tile the epic exists
   for. With no ticks, runs-today and the error rate are *legitimately* zero
   and the screen otherwise looks healthy — confirm `null` renders prominent
   copy naming a missing EventBridge rule, not a blank dash. **Only reachable
   on a fresh local database**: portal-dev has ticked, so `lastTickAt` is set
   there for good.
2. **Delivery counters at zero.** `delivery.bounced` / `.complained` are always
   present and numeric. Zero must read as "nothing bounced", not as "not
   implemented".

Then tick and watch the screens fill:

```bash
npm run tick
```

**Expect most rows to sit `queued` for a while.** `automationWorker.js` runs
`concurrency: 1` and every job renders PDFs, so a six-board fan-out shows 1
`succeeded` and 5 `queued` for minutes. That is the real state of the queue,
not a stuck screen.

## 2. The drill-down

Reach it from the connection grid, or go to `/workspace/<id>/system-health`.

Per row: date, period, kind, trigger, status, duration, recipient, and error
text where there is one. Check:

- `trigger` distinguishes `schedule` from `manual`.
- The period key is derived from the run's own period, not from `now` — two
  rows for one board in one period is a real defect.
- Times are in the **schedule's** timezone and agree with the Automation tab.
- A run that ran and had nothing to do says why (`outcomeReason`) rather than
  only "No emails were sent". A run recorded before that field existed has no
  reason stored, and that is expected.

### Retry

The **Retry** button appears on a `failed` row only.
`POST /api/system-health/workspace/:id/runs/:runId/retry`:

| Response | Means |
|---|---|
| `202 {retried}` | re-enqueued; a new row `retry-<runId>:BOARD:PERIOD`, trigger `manual` |
| `409 {error:"not_failed", status}` | the run is not `failed` — retrying a success would bill twice, and retrying a `queued` run would race the worker holding it |

A retry is idempotent per run — the job id is deterministic, so a second retry
of the same run dedupes in BullMQ and is a no-op. A retry **re-sends** the
period's existing documents rather than regenerating them.

### Run now — API only

The *Run invoices now* / *Run statements now* buttons were removed from the
drill-down (KAN-230). The route remains as an operational trigger and is what
[`testing-statement-of-account-particulars.md`](testing-statement-of-account-particulars.md)
uses. `POST /api/system-health/workspace/:id/run`, body `{"kind":"invoice"}`:

| Response | Means |
|---|---|
| `202 {enqueued, periodKey}` | dispatched |
| `400` | `kind` was not `invoice` or `statement` |
| `404` | no *enabled* block of that kind — arm it on the Automation tab first |
| `409 {error:"already_run", periodKey, runs}` | that period already ran; `?force=1` overrides |

The 409 is the guarantee that run history cannot double-count, so exercise both
halves. Both Run now and Retry enqueue *first*, then record — a run recorded
for a job that never reached the queue would sit `queued` forever.

## 3. Delivery failure states must be seeded

Bounced, complained and Rendering Failure cannot be produced on a laptop — no
SES, the worker falls back to the offline outbox, and it records no
`messageId` for an event to match. Everything *downstream* is ordinary code,
and that is what you are testing.

`Frontend/e2e/support/delivery-failures.ts` seeds one run with all four
outcomes (delivered, bounced, complained, rendering failure), writing
`automationruns`, `emailsends`, `emailevents` and `pdflinks` in the shape the
real writers leave them. Rows are namespaced by suite marker so that two specs
sharing one database under `fullyParallel` cannot delete each other's rows.

Check the *sentence*, not just the badge: each failed message must name what
happened and why, not the bare word "failed".

## 4. Admin gating

A non-admin must never see the System Health tab, and `/api/system-health/*`
must answer **403** for them. Sign in via SSO as a non-admin account to check
it.

## The Playwright spec

`Frontend/e2e/system-health.spec.ts`. Playwright is not in CI, so nothing gates
it except running it by hand:

```bash
cd Frontend && npx playwright test e2e/system-health.spec.ts
```

The spec signs itself in as support admin. Point it at the right stack and
data with `E2E_BACKEND_URL`, `E2E_FRONTEND_URL` (or `PLAYWRIGHT_BASE_URL`),
`E2E_MONGO_DB` and `E2E_SYSTEM_HEALTH_WORKSPACE_ID` — from a worktree, use that
worktree's ports and database. The non-admin test skips unless
`E2E_USER_EMAIL` / `E2E_USER_PASSWORD` are set.

## Known ceilings and quirks

| Thing | Note |
|---|---|
| Board sync records no `AutomationRun` | KAN-12's sweep dispatches without one — a gap, not a regression |
| System Health tab absent for a moment on a hard refresh | `AppContext` initialises `role: "isoplus_user"` until hydration; the tab recovers on its own |
| Real bounces unprovable locally | seeded instead — see section 3 |
| Overview degrades rather than fails | the queue tile reports `available: false` if Redis is unreachable |
| Xero grid never calls Xero | derived from `Business.xeroTokens.refreshTokenExpiresAt`; read-only |

---

## Appendix — portal-dev results, 2026-08-27

The reference pass: what passing looked like. Tested against portal-dev,
workspace **55369**, after [PR #889](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/889),
with real EventBridge dispatches and API responses checked against the screens.
**Every KAN-11 acceptance passed.** Run now was still in the UI at the time.

### The record

| Requirement | Result |
|---|---|
| One `AutomationRun` per board per period | **PASS** — 78 rows, one per board per periodKey |
| Keyed on the jobId BullMQ dedupes on | **PASS** — `inv:BOARD:PERIOD` on scheduled rows |
| Trigger distinguishes scheduled from manual | **PASS** — rendered as Scheduled / Manual |
| Closed with a real outcome | **PASS** — succeeded / failed observed, with error text on the failure |

### Admin API

| Route | Result |
|---|---|
| `GET /overview` | **PASS** — `runsToday 55`, `succeeded 54`, `failed 1`, `errorRate24h 0.018` = exactly 1/55 |
| heartbeat | **PASS** — `lastTickAt` live and advancing |
| queue tile | **PASS** — `available: true`; degrade path not exercised (Redis healthy) |
| delivery counters | **PASS** — always numeric, `bounced 0` / `complained 0` over 168h |
| `GET /clients` | **PASS** — 2 workspaces, Xero `connected` |
| `GET /workspace/:id` | **PASS** — schedules carry `timezone`, `total 55` / `pageSize 50` → pagination live |
| `GET …/runs/:id/emails` | **PASS** — real SES messageIds, `recipient`, `recipientType: billing_contact`, `state: sent` |
| `POST …/run` bad kind | **PASS** — `400 kind must be "invoice" or "statement"` |
| `POST …/run` disabled kind | **PASS** — `404 No enabled automation for that kind` |
| `POST …/run` duplicate period | **PASS** — `409 {error:"already_run", periodKey, runs}` |
| `POST …/run?force=1` | **PASS** — `202 {enqueued: 11}`, ids `manual-11:BOARD:PERIOD` |
| `POST …/runs/:id/retry` on failed | **PASS** — `202 {retried}`, new row `retry-<runId>:BOARD:PERIOD`, trigger `manual` |
| `POST …/runs/:id/retry` on succeeded | **PASS** — `409 {error:"not_failed", status:"succeeded"}` |

### Screens

| Requirement | Result |
|---|---|
| Tiles, heartbeat, connection grid | **PASS** |
| Drill-down: schedule summary, paged history | **PASS** |
| Row detail: date, period, kind, trigger, status, duration, recipient | **PASS** |
| Error text on a failed row | **PASS** |
| Retry button only on a failed row | **PASS** |
| Retry failure surfaces to the operator | **PASS** — "Could not retry the run. Try again." |
| Times in the schedule's zone | **PASS** since [PR #882](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/882) |

### Defects that pass found, both fixed

1. **The drill-down rendered every instant in the reader's zone** (PR #882) —
   a run at 21:54 Sydney read "7:54 PM" to a reader in Manila, contradicting
   the Automation tab one click away.
2. **Retry and forced re-run answered 500 on every call** (PR #889). BullMQ
   accepts a colon-joined custom id only at exactly three parts; both ids had
   a fourth. CI missed it because `Backend/test/setup.js` mocked BullMQ with an
   `addBulk` that accepted any id. When a test double is more permissive than
   the library it stands for, a green suite says nothing about that path.
