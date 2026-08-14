# Visibility & Monitoring — run history, System Health, and the client status panel

**Ticket:** KAN-11 (Epic 6 — Visibility & Monitoring, Track B)
**Date:** 2026-08-13
**Status:** Approved
**Branch:** `feature/KAN-11_visibility_and_monitoring`, cut from `feature/KAN-10_invoice_statement_automation_full`
**Depends on:** [PR #860](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/860) (KAN-10) — must merge before this does
**Source:** `1. System Health & Monitoring.pdf`

## Goal

Give Support and the System Owner one place to see whether Invoice & Statement
Automation is healthy across every client, and to troubleshoot a single client
without reading logs — plus the client-facing half of the same data on the
Invoice & Statement Automation tab.

**Nothing is sent, and nothing new is generated.** This epic reports on the
automation KAN-10 built; it does not extend it.

## Scope

**In:** 6.1 (client status panel), 6.3 (System Health entry point), 6.4 (global
overview), 6.5 (per-client drill-down, including Run now / Retry), 6.6 (the
backend metrics behind all of them).

**Out:** 6.2 (bounce & delivery failures) and the "every email sent" half of
6.5. Both are blocked — see below. They get their own ticket.

## The dependency that shapes this epic

The PDF names the data sources as "Audit Trail rows and SES configuration-set
events". The second half does not exist.

`Backend/src/workers/automationWorker.js` still opens with:

> INTENTIONALLY INERT. This worker generates nothing and sends nothing. […] PDF
> generation and SES delivery are Epic 5 parts 3-4 and replace the body of this
> handler.

Confirmed independently — the only AWS SDK packages in `Backend/package.json`
are `@aws-sdk/client-s3` and `s3-request-presigner`. There is no SES client, no
SNS topic and no mailer anywhere in the tree.

So 6.2 has nothing to report on. It is designed into the layout as a
present-but-disabled section rather than omitted, so that landing Epic 5.6/5.7
is a fill-in and not a redesign.

### What each item can actually be built on

| Item | Source | Status |
|---|---|---|
| 6.3 entry point, 6.4 active automations | `AutomationSettings`, `User.role` | Ready |
| 6.4 queue size | BullMQ `{automation}` queue | Ready |
| 6.4 connection status | `Business.xeroIntegrated` / `xeroTokens` | Xero only — MYOB and QuickBooks are disabled stubs in `Frontend/lib/accounting-integrations-panel.tsx` |
| 6.4 scheduler liveness | `SchedulerHealth`, `ScheduledJob.missedRuns` | Ready — `missedRuns` became meaningful for at-least-once schedules on 2026-08-13 |
| 6.1 / 6.4 / 6.5 run history, counts, error rate | **nothing** | `ScheduledJob` holds only `lastRunAt` / `lastError` / `consecutiveFailures` — one row per schedule, no history |
| 6.2 bounces, "every email sent" | **nothing** | Blocked |

The central piece of work is therefore introducing a run record, which the epic
assumes exists and which nothing in KAN-10 writes.

## Decisions

### 1. Run history lives in a new `AutomationRun` collection

Not `AuditTrail`. It has no duration, recipient or outcome field, its `before`
/`after` are `Mixed`, and it is the collection every audited HTTP request
writes to — "error rate over the last 24h" would scan all of that. Not BullMQ
job history either: Redis is not durable and BullMQ trims completed jobs, so
"full run history, not capped at 10" would silently truncate.

```
AutomationRun
  workspaceId  boardId   kind        invoice | statement
  periodKey    jobId     status      queued | running | succeeded | failed | skipped
  skipReason               // why a skipped run was skipped
  startedAt    finishedAt  durationMs
  recipient    error
  trigger                  // schedule | manual
```

Indexes:

```
{ workspaceId: 1, startedAt: -1 }   // drill-down history, client panel
{ status: 1, startedAt: -1 }        // error rate, runs-today counts
{ jobId: 1 } unique                 // the idempotency join
```

`jobId` carries the key `fanOut.js` already mints
(`inv:<boardId>:<periodKey>`), which is what makes "Retry failed run" and the
duplicate check well-defined rather than approximate. Needs a migration with a
real `down`.

Two notes on the fields, so a reviewer does not have to infer them:

- **`running` is unused until Epic 5.6/5.7.** The inert worker goes
  `queued` → `skipped` in one step, because it does no work to be in the middle
  of. The state exists so the real worker can mark a long generation in flight
  without the enum changing shape later.
- **`durationMs`, `finishedAt` and `recipient` are null on a `skipped` run.**
  Nothing ran and nobody was written to. The screens must render an absent
  duration rather than `0ms`, which would read as "instant success".

### 2. Runs are written at fan-out and closed by the worker

Two write points, both small:

- **`services/scheduler/handlers.js`**, immediately after
  `getAutomationQueue().addBulk(specs)` — a `bulkWrite` of `queued` records
  upserted on `jobId`. The same key BullMQ dedupes on, so an at-least-once
  redispatch reuses the row instead of creating a second one.
- **`workers/automationWorker.js`** — transitions each to its terminal state.

Deliberately not one write inside `fanOut.js`: that module is pure and returns
job specs, which is why it is testable and why the idempotency key has a single
home. It stays pure.

### 3. The inert worker records `skipped`, with a reason

`status: 'skipped'`, `skipReason: 'delivery_not_implemented'`.

The worker's contract is unchanged — it still generates nothing and sends
nothing. But a run that is enqueued and never resolved would sit at `queued`
forever, and the screens would show a phantom backlog that is really just an
unbuilt feature. `skipped` is the truth.

When Epic 5.6/5.7 lands, that one transition becomes `succeeded`/`failed` and
every screen above starts showing real outcomes with no further change.

`Backend/test/unit/workers/automationWorker.test.js` pins the inert contract
deliberately, so this change fails a test on purpose. That is the point: it
makes replacing the stub a reviewed edit rather than a silent one.

### 4. System Health is a dashboard tab, not a tile

The PDF says "a new System Health **tile** on the existing Dashboard homepage,
next to the other homepage tiles". There are no tiles.
`Frontend/app/dashboard/page.tsx` is a `Tabs` layout with **Workspaces** and an
admin-only **Application logs** tab gated on `support_admin || owner` — already
the established pattern for exactly this kind of surface.

So: a third **System Health** tab beside Application logs, gated with
`isOwnerOrSupport` from `Frontend/lib/access.ts` rather than another inline role
comparison. Clicking a client routes to `/workspace/[id]/system-health` for the
6.5 drill-down, mirroring how `audit-trail` already works per workspace.

Departing from the written spec is deliberate and recorded here because the
spec describes a layout the product does not have.

### 5. "Run now" refuses a repeat, and says why

Manual runs reuse the scheduled `periodKey`, so a stray click cannot double-bill.
If a run already exists for that period the route answers `409 already_run` with
the existing runs, and the UI shows *Already run for Aug 2026 — view run* beside
a **Force re-run** confirm.

A forced re-run mints `manual:<boardId>:<periodKey>:<n>`, where `n` is the count
of runs already recorded for that board and period. It is a disambiguator, not
a sequence number with meaning: it exists so the unique `jobId` index admits a
second deliberate run of a period without the operator having to invent a key,
and so BullMQ does not collapse the forced run into the original.

Safe by default, never silently does nothing, and the override is explicit.
Silent dedupe was rejected: on a troubleshooting screen, a button that appears
to do nothing is the worst of the three outcomes.

Manual runs carry `trigger: 'manual'` so the drill-down can distinguish them
from scheduled ones — otherwise a forced re-run looks like a duplicate bug in
the history it is meant to help debug.

### 6. Connection status must tolerate the field it depends on being absent

`npm run schema` reports, for `businesses`:

> declared but absent from the sample: … `xeroTenantId`, `xeroTokens.accessToken`,
> `xeroTokens.refreshToken`, `xeroTokens.expiresAt`,
> `xeroTokens.refreshTokenExpiresAt` …

`refreshTokenExpiresAt` is the natural signal for "needs re-auth" — a Xero
refresh token dies after 60 days idle — and it is **not present on existing
documents**. A naive `refreshTokenExpiresAt < now` check reads `undefined`,
compares as `NaN`, and would mark every existing client as needing re-auth on
the day this ships. A monitoring screen whose first act is a false alarm across
the whole grid does not get trusted again.

The derivation is therefore:

| Condition | Status |
|---|---|
| `xeroIntegrated` is false | `disconnected` |
| integrated, `refreshTokenExpiresAt` present and in the past | `needs_reauth` |
| integrated, `refreshTokenExpiresAt` present and in the future | `connected` |
| integrated, `refreshTokenExpiresAt` absent | `connected` |

The last row is the judgment call: absence means "this document predates the
field", not "the token expired". It is recorded as an open question below —
a backfill would make the check exact, and belongs to the Accounting
Integrations epic that owns the field, not this one.

## Constants

Per the convention added to `CLAUDE.md` on 2026-08-13, this feature's fixed
values live in one file each and are not re-declared per module:

- `Backend/src/constants/systemHealth.js` — run statuses, skip reasons, the
  trigger values, the error-rate window (24h), the trend bucket count, the
  drill-down page size, and the queue-depth threshold above which the overview
  flags a backlog.
- `Frontend/constants/system-health.ts` — the poll interval and the status
  labels/ordering the grid renders. This directory does not exist yet; it is
  the documented location for frontend constants.

Both follow the rules in `CLAUDE.md`: touchpoint comments naming the modules
that read each value, and no imports in the constants file itself.

`DEFAULT_TIMEZONE` comes from `constants/scheduler.js`. No new hardcoded
`'Australia/Sydney'`.

## Backend

Pure helpers, so the cognitive-complexity gate stays satisfiable:

| Module | Responsibility |
|---|---|
| `utils/automationRunMetrics.js` | rows → `{ runsToday, runsThisWeek, succeeded, failed, errorRate24h, trend[] }` |
| `utils/automationConnectionStatus.js` | a `Business` doc → `connected \| disconnected \| needs_reauth`, per decision 6 |
| `services/automation/runs.js` | the I/O: create queued rows, transition them, query history |
| `services/automation/queueMetrics.js` | `getJobCounts()` off the existing `{automation}` queue |

New router `routes/systemHealth.js`, mounted at `/api/system-health` **in both
`app.js` and `index.js`** — they are parallel express apps, and
`test/unit/routeMountParity.test.js` now fails if only one is updated.

Every route sits behind `authenticateToken` plus an owner/support_admin guard.

| Route | Serves |
|---|---|
| `GET /overview` | 6.4 — counts, queue depth, error rate + trend, scheduler heartbeat |
| `GET /clients` | 6.4 — the connection-status grid |
| `GET /workspace/:workspaceId` | 6.5 — schedule, uncapped paginated run history |
| `POST /workspace/:workspaceId/run` | 6.5 — Run now; `409 already_run` unless `?force=1` |
| `POST /workspace/:workspaceId/runs/:runId/retry` | 6.5 — retry one failed run |

The client panel (6.1) gets `GET /api/automation/:workspaceId/status` on the
existing automation router — last 10 runs, next run, last status. Deliberately
a separate endpoint from the admin ones so client scoping cannot leak the
global view, and so the admin routes can change shape without touching a
client-facing response.

## Frontend

Following the repo's `-page-view` / `-helpers` / `use-*` split, which is what
keeps these files under the complexity gate:

- `lib/system-health-page-view.tsx`, `lib/system-health-helpers.ts`,
  `lib/use-system-health.ts`, `lib/system-health-connection-grid.tsx` — the tab
- `app/workspace/[id]/system-health/page.tsx` +
  `lib/system-health-drilldown-view.tsx` — the drill-down
- `lib/automation-status-panel.tsx`, rendered inside the existing
  `lib/invoice-statement-automation-panel.tsx` — the client panel
- Tab wiring in `app/dashboard/page.tsx`

Bounce/complaint and "every email sent" render as a present-but-disabled
section reading *Email delivery is not enabled yet*.

## Testing

Failing test first, per `CLAUDE.md`.

- **Unit** — all four pure helpers, including the absent-`refreshTokenExpiresAt`
  case from decision 6 and the empty-history case for every metric.
- **Integration** (supertest against `createApp()`) — every route, including
  the role gate returning 403 for `isoplus_user`, the `409 already_run` path
  and its `?force=1` override, and retry against a run that is not `failed`.
- **Pipeline** — extend `test/integration/automation.pipeline.route.test.js`:
  ticking a due schedule must now also write one `AutomationRun` per board, and
  a redispatch of the same slot must reuse the rows rather than duplicate them.
- **E2E** (Playwright) — the tab renders for an admin, is absent for a
  non-admin, and the drill-down loads. A user-visible change needs one.

Use `test/helpers/queue.js` for anything asserting on enqueued jobs; the global
BullMQ mock records `addBulk` calls as of 2026-08-13.

## Blast radius

Two existing files change behaviour: `services/scheduler/handlers.js` gains a
write after the fan-out, and `workers/automationWorker.js` gains a state
transition. Neither changes what is enqueued, generated or sent. One new
collection, one migration, one new router, one new dashboard tab. No existing
route, response shape or stored field changes.

## Follow-ups

1. **6.2 and "every email sent"** — their own ticket, unblocked by Epic 5.6/5.7.
2. **MYOB and QuickBooks connection status** — the grid shows Xero only,
   because the other two are disabled stubs.
3. **`AutomationRun` retention** — nothing prunes the collection. "Every
   execution" is the requirement, so this is deliberate for now; a TTL or
   archive decision belongs with the first client at volume.
4. **A backfill for `xeroTokens.refreshTokenExpiresAt`** would make decision 6's
   last row exact rather than assumed.

## Open questions

1. **Is "integrated but no stored expiry" really `connected`?** Decision 6 says
   yes, to avoid a false alarm across every existing client. The alternative is
   a fourth `unknown` state, which the PDF does not have. Worth confirming with
   whoever owns Accounting Integrations.
2. **Does the client panel show `skipped` runs?** They are truthful but
   meaningless to a client while delivery is unbuilt. The current answer is
   that the client panel shows them as "Pending setup" rather than hiding them,
   because a silently empty history looks broken.
