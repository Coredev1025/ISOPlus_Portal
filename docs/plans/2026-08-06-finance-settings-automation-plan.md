# Finance Settings & Automation: baseline tests, then seven epics

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Tickets:**
- Epic 1 (navigation & entry) — **KAN-6** — implemented on `feature/invoice-statement-automation-toggle`
- Epic 2 (workspace feature toggle) — **KAN-7** — implemented on the same branch
- Epic 3 (Financial Settings tab) — **KAN-8** — gap-finished on `feature/KAN-8-epic-3-financial-settings-tab-relocation-one`
- Later epics — tickets still required before branching further work from `develop`

**Date:** 2026-08-06
**Status:** In progress — Epics 1–3 implemented on the finance-settings topic branches (not all merged to `develop`). Epics 4–7 remain open.
**Source spec:** six documents, `1. System Health & Monitoring` … `6. Implementation Task Breakdown`, dated 2026-08-02

**Goal:** Ship the Finance Settings & Automation area — a renamed entry point, a per-workspace feature toggle, relocated Financial Settings, a multi-provider Accounting Integrations tab, scheduled invoice/statement generation and delivery, and the monitoring to see it working — on top of an end-to-end test baseline that covers every existing touchpoint the seven epics disturb.

**Architecture:** Phase 1 writes characterization tests against **existing** behaviour at each touchpoint, before any of it is moved — so the large relocations in Epics 3 and 4 are provably behaviour-preserving. Phase 2 builds the epics against that net. The scheduler follows the spec's "tick + existing queue" approach: one EventBridge rule hits an internal endpoint, which enqueues due automations onto the BullMQ/Redis instance already used for sync.

**Tech Stack:** Node 20+ ESM, Express, Mongoose/MongoDB, BullMQ + Redis, Next.js 15 App Router, shadcn/ui, AWS SES + EventBridge Scheduler, **Vitest** + `supertest` + `msw` + `mongodb-memory-server`.

> ## Phase 0 is done — superseded by PR #848
>
> This plan was written on 2026-08-06 against a repo with no test runner. Later
> that day `develop` merged PR #848, which had already built it, and better:
>
> | Plan's Phase 0 | What #848 shipped |
> |---|---|
> | Task 1 — extract `createApp()` | `Backend/src/app.js` exports `createApp()` — same name |
> | Task 1 — pick `node:test` | **Vitest**, with `test:watch` and `test:coverage` |
> | Task 2 — test-database helper | `mongodb-memory-server` in `test/setup.js` — no local Mongo needed |
> | Task 3 — session-login helper | `test/helpers/auth.js` + `supertest` |
> | Live/offline split (see below) | `test/real-api/`, gated on `RUN_REAL_API_TESTS=1` |
> | *(not planned)* | `msw` — mock ISO+ at the HTTP layer, which is stronger than anything proposed here |
>
> **Tasks 1–3 are withdrawn. Do not do them.** Phase 1 is rewritten below to use
> what exists. Two corrections that follow from it:
>
> - Test files must end **`.test.js`**. `vitest.config.js` collects
>   `test/**/*.test.js` only, so the `.test.mjs` names this plan originally used
>   would have been silently ignored — no error, just zero tests collected.
> - This plan's proposed `ISOPLUS_LIVE=1` gate is superseded by
>   **`RUN_REAL_API_TESTS=1`** and `npm run test:api:live`. Use theirs.
>
> One caveat inherited rather than fixed: `src/app.js` is a **parallel copy** of
> `src/index.js`, not a refactor — `index.js` still builds its own app and still
> calls `listen()`. They have already drifted, with `/api/queues` mounted in
> `index.js` and absent from `app.js`. So integration tests exercise an app that
> is not the one serving traffic, and every new route must be mounted twice.
> Worth its own ticket; not in scope here.

---

## Epic 1 (KAN-6) & Epic 2 (KAN-7) — implemented

Shipped on branch `feature/invoice-statement-automation-toggle` (commit family
around `86021e7`). Acceptance below matches the epics as built; **do not
re-implement Task 8 / Task 9**. Next work starts at Epic 3+.

### Epic 2 — Workspace Configuration: Feature Toggle (KAN-7)

| Item | Status | What shipped |
|---|---|---|
| **2.1** Enable/disable on Workspace Configuration; System Owner + Support Admin only | Done | Switch on Configuration via `workspace-feature-toggles-card.tsx`; API gated with `requirePortalOwnerOrSupport` (`owner` / `support_admin`, per R1) |
| **2.2** Default disabled for existing and new workspaces | Done | `Business.featureToggles.invoiceStatementAutomation` default `false` |
| **2.3** Persist per workspace; FE can gate the Automation tab | Done | `GET` / `PUT /api/workspaces/:workspaceId/feature-toggles` body `{ invoiceStatementAutomation: boolean }`; also exposed on business profile as `featureToggles` |
| **2.4** Docs for System Owner / Support Admin | Removed | Inline help on the Feature Toggles card (and related permission copy) was removed — no separate markdown guide |

**Departures from the original Task 8 sketch in this plan:**

| Plan said | Code does |
|---|---|
| `Workspace.invoiceStatementAutomationEnabled` | Flag lives on **`Business.featureToggles.invoiceStatementAutomation`** (workspace identity is still `workspaceId` on the Business doc) |
| `PATCH /api/workspaces/:id/features` with `invoiceStatementAutomationEnabled` | **`GET`/`PUT /api/workspaces/:id/feature-toggles`** with `invoiceStatementAutomation` |
| Flag appears on `GET /api/workspaces` | Flag is **not** on the ISO+ proxied workspace list (R9); FE loads it from **feature-toggles** and/or **business profile** |
| Tests under `Backend/test/epics/feature-toggle.test.js` | `Backend/test/unit/utils/workspaceFeatureToggleHelpers.test.js` + `Backend/test/integration/workspace.route.test.js` + model default assertion |

### Epic 1 — Navigation & Entry Point (KAN-6)

| Item | Status | What shipped |
|---|---|---|
| **Prep** Test coverage for helpers / toggle / tab resolve | Done | Backend unit + integration above; `Frontend/test/unit/finance-settings-tab.test.ts` |
| **1.1** Rename tile to “Finance Settings & Automation” | Done | Workspace page tile (`Frontend/app/workspace/[id]/page.tsx`) — not the homepage, per R2 |
| **1.2** Page shell: header, navigation back, full-width content | Done | `Frontend/app/workspace/[id]/finance-settings/page.tsx` — **Back to Workspace** button (not a formal shadcn breadcrumb trail) |
| **1.3** Three-tab nav | Done | Financial Settings / Accounting Integrations / Invoice & Statement Automation (`finance-settings-page.tsx`) |
| **1.4** Automation tab only when flag is on | Done | Tab hidden when flag is false; `?tab=automation` resolves back to `financial` via `resolveActiveFinanceTab` |

**Scope note for Epic 1:** tab 3 is a **placeholder** panel (“built in a later update”). Schedule/email UI and engine are Epics 5–6 — not KAN-6.

Old `/xero-integration` redirects into finance-settings (`?tab=accounting`).

**Key files (Epic 1–2):**

- Backend: `models/Business.js` (`featureToggles`), `utils/workspaceFeatureToggleHelpers.js`, `routes/workspace.js` (feature-toggles routes)
- Frontend: `lib/workspace-feature-toggles*.tsx`, `app/workspace/[id]/configuration/page.tsx`, `app/workspace/[id]/finance-settings/page.tsx`, `lib/finance-settings-page.tsx`, `lib/finance-settings-tab.ts`

**Verify:**

```bash
cd Backend && npm test -- test/unit/utils/workspaceFeatureToggleHelpers.test.js test/unit/models/business.test.js test/integration/workspace.route.test.js
cd Frontend && npm test -- test/unit/finance-settings-tab.test.ts test/unit/workspace-feature-toggles.test.ts
```

---

## Global Constraints

- **Cognitive complexity < 15 per file** (SonarJS S3776, `.eslintrc.complexity.cjs`). Extract into `utils/*Helpers.js` rather than nesting — this is enforced in CI, not advisory.
- **Backend is ESM** (`"type": "module"`); use `node:` prefixed built-ins and `.js` extensions in relative imports.
- **No new runtime dependencies without calling it out.** The spec's whole premise is reuse: Redis, BullMQ and the worker already exist. New AWS resources are limited to the five in doc 2.
- **MongoDB is schema-less by design here** — doc 2 states new fields need no migration. Mongoose schemas still need the field declared or it will not persist.
- **Feature flag defaults to disabled** for all existing and new workspaces (Epic 2.2).
- **Disabled-not-absent:** Credit Note Numbers, Contact/Invoice/Customer/Payment Sync, and the MYOB/QuickBooks sub-tabs render greyed out, never hidden (Epics 3.4, 4.3, 4.4).
- **No AI attribution** in commits or PR bodies.
- **Branch naming** `<type>/<TICKET>_<snake_case_description>`; `feature/` branches from `origin/develop`. Ask for the ticket; do not invent one.

---

## Reality checks: where the spec and the code disagree

Found by reading the code, not the spec. Each one changes a task, so settle them before starting.

| # | Spec says | Code says | Effect |
|---|---|---|---|
| R1 | "System Owner and Support Admin roles only" | `User.role` enum is `['isoplus_user', 'support_admin', 'owner']` — there is no `system_owner` | "System Owner" = `owner`. `requirePortalOwnerOrSupport` (`middleware/auth.js:81`) is already exactly this gate — reuse it, do not add a role |
| R2 | "Rename dashboard tile" | The "Xero Integration" tile is on the **workspace** page, `Frontend/app/workspace/[id]/page.tsx:266`, not the dashboard homepage | Epic 1.1 touches the workspace page. There is also a separate `xero-integration/page.tsx` |
| R3 | Bank Details / Document Numbering move "from Configure Your Business" | They are inside the **"Additional Settings" tab** of `configure-business/page.tsx` (`:569`, `:907`, `:976`) | Epic 3 is a tab-to-page move; the migration in 3.5 is about *where values are edited*, not a data reshape — `Business.documentNumbering` already holds them |
| R4 | Statement Numbers is a "new numbering series alongside Invoice/PO/Quote" | `Business.documentNumbering` has exactly `invoice`, `purchaseOrder`, `quote`, each `{prefix, nextNumber}` (`models/Business.js:96-125`) | Add a fourth sub-document of identical shape. Genuinely additive |
| R5 | — | ~~`src/index.js` never exports the app~~ — **resolved by PR #848**: `src/app.js` exports `createApp()` | Use it. But `index.js` still builds its own app and still `listen()`s, so the two definitions have already drifted (`/api/queues` is in `index.js` only) — tests exercise an app that is not the one serving traffic |
| R6 | — | `authenticateToken` reads `req.session.token`, not an `Authorization` header (`middleware/auth.js:43`) | Tests need a session cookie, not a bearer token. `test/helpers/auth.js` already handles this — reuse it |
| R7 | Reuse "the existing Redis queue" | One queue exists: `syncQueue` in `services/sync/queue.js:101`, drained by `workers/syncWorker.js:693` | Decide: second queue, or new job type on `syncQueue`. Task 13 assumes a **separate** `automationQueue` so a stuck sync backlog cannot delay billing |
| R8 | Epic 7: "create a schedule to sync automatically" | One sentence, no acceptance criteria, no cadence, no failure behaviour | **Underspecified.** Task 17 covers only the mechanism; the policy needs a design first |
| R9 | — | `GET /api/workspaces` does **not** read Mongo. It proxies `https://app.isoplus.online/api/v2/workspaces` using `req.session.Authorization` (`workspace.js:145` → `isoplus.js:261`) | A workspace cannot be seeded into existence. Task 6 cannot baseline it offline — see [Local environment](#local-environment-how-a-workspace-actually-loads) |
| R10 | — | `BACKEND_URL` is unset in `Backend/.env`. `automationUrlUpdate.js:7` silently no-ops the automation-URL rewrite when it is missing, and `webhookServiceHelpers.js:13` falls back to `http://localhost:3001` while still reporting success | Blocks pointing a live board at a local backend. See the ngrok note below |
| R11 | Feature flag on Workspace + appear in `GET /api/workspaces` | Epic 2 (KAN-7) stores the flag on **`Business.featureToggles`** and exposes it via **`/feature-toggles` + profile**, not the proxied workspace list | Later epics must read `Business.featureToggles.invoiceStatementAutomation` — see [Epic 1 (KAN-6) & Epic 2 (KAN-7) — implemented](#epic-1-kan-6--epic-2-kan-7--implemented) |

**R8 is the one to resolve before Epic 7.** Epics 1–2 (Tasks 8–9) are done; remaining Phase 2 starts at Epic 3.

---

## Local environment: how a workspace actually loads

This was the open question, and the answer changes the test strategy — so it is stated before the matrix rather than buried in a task.

**A workspace cannot be seeded.** `GET /api/workspaces` proxies ISO+ live; the Mongo `Workspace` model is not what the list renders from. What Mongo holds is the Portal's own copy — `Business`, `Board`, `Item`.

The bridge already exists in `middleware/authHelpers.js:37`:

```js
export function applyPrivilegedSessionAuth(req, user) {
  if (user.role === 'support_admin' || user.role === 'owner') {
    req.session.Authorization = `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`;
  }
}
```

So the working local recipe, which was never written down anywhere:

```bash
npm run dev:up
npm run dev:user -- --create      # local support-admin login, bypasses ISO+ OAuth
# Backend/.env must carry a valid PERSONAL_ACCESS_TOKEN
npm run seed                      # or: npm run dev:fixture
```

Log in through the "administrator credentials" link, not the ISO+ OAuth button. Workspace `55369` then appears, proxied live.

**Consequence for the test plan.** The local frontend is *not* offline — no `PERSONAL_ACCESS_TOKEN`, no workspaces. Any test that touches workspace listing therefore depends on live ISO+ and network. Phase 1 handles this by splitting the suite:

| Suite | Depends on | Runs in CI |
|---|---|---|
| `test/baseline/**` | local Mongo (+ Redis where marked) | yes |
| `test/real-api/**` | live ISO+ and a real token | no — opt in with `RUN_REAL_API_TESTS=1` |

Anything reading workspaces, board attributes, or references belongs in `test/real-api/`, skipped by default:

```javascript
const live = process.env.RUN_REAL_API_TESTS === '1'
test('GET /api/workspaces returns workspace 55369', { skip: !live && 'set RUN_REAL_API_TESTS=1' }, async () => { /* … */ })
```

This is the same offline/online split that already bites the pricing dispatch: `boardUsesLegacyNdisPricing()` reads the live API and defaults to `legacy` when it cannot (see `Backend/test/fixtures/README.md`).

### Pointing a live board at a local backend (ngrok) — later stage

Not planned as a task; recorded so the prerequisite is not rediscovered. Two settings already read `BACKEND_URL`, and both degrade silently while it is unset (R10):

1. `automationUrlUpdate.js:7` — `PUT /api/automation` rewrites `workflow[].config.url` for automations named `Portal - ` only (`:38`). With `BACKEND_URL` unset it warns and changes nothing.
2. `webhookServiceHelpers.js:13` — the sync hook callback falls back to `http://localhost:3001`, and registration still reports success.

Setting `BACKEND_URL=https://<id>.ngrok-free.app` and running the rewrite points the board's 26 `Portal - ` automations at the local backend; the other 15 are untouched by design.

**This mutates the live board.** Production automations stay pointed at the tunnel until rewritten back, and a laptop that goes offline takes real billing traffic with it. Before doing it: capture the current URLs (`GET /api/<team>/automations/<board>` is authoritative — the UI truncates the field without indication), and have the restore path tested, not assumed.

---

## Touchpoint coverage matrix

This is the Phase 1 deliverable: the existing surfaces each epic disturbs, and the baseline test that pins current behaviour **before** it moves. A relocation with no characterization test is an unverifiable claim.

| Touchpoint | Existing code | Disturbed by | Baseline test | Task |
|---|---|---|---|---|
| Health/bootstrap | `/api/healthcheck` | all | app boots without listening | 1 |
| Login + session cookie | `POST /api/auth/login`, `middleware/auth.js:42` | E2, E6 | all three roles receive a usable session | 3 |
| Role gate | `requirePortalOwnerOrSupport` (`auth.js:81`) | E2, E6 | `owner`/`support_admin` pass, `isoplus_user` gets 403 | 6 |
| Business profile read/write | `GET`/`PUT /api/business/profile` (`business.js:87,157`) | E3 | full round-trip preserves every field | 4 |
| Document numbering | `Business.documentNumbering` (`Business.js:96`) | E3 | invoice/PO/quote prefix + nextNumber survive a `PUT` | 4 |
| Bank details | `configure-business` Additional Settings (`:907`) | E3 | persisted and returned unchanged | 4 |
| Xero connect/disconnect | `business.js:292,336`, `routes/xero.js` | E4 | connection state transitions; `Test Connection` unchanged | 5 |
| Xero quote push | `/api/xero/:ws/:board/quotendis` | E4 | route exists and rejects an empty body in the documented way | 5 |
| PDF quote generation | `/api/pdf/:ws/:board/quotendis` (`webhook.js:1674`) | E5 | contract from the committed fixture still holds | 5 |
| Audit trail write | `models/AuditTrail.js`, `middleware/auditHttp.js` | E5, E6 | a request writes exactly one row with the documented fields | 7 |
| Sync queue | `services/sync/queue.js:101` | E5, E6, E7 | enqueue/drain works against a test Redis | 7 |
| Workspace listing | `routes/workspace.js:145` → live ISO+ | E2 | **live-only** — proxied, cannot run offline (R9) | 6 |
| Workspace document | `models/Workspace.js` | E2 | a new document carries no automation flag | 6 |
| Local login → ISO+ bearer | `authHelpers.js:37` | E2, E6 | `owner`/`support_admin` login populates `session.Authorization` | 3 |
| Item/board storage | `models/Item.js`, `Board.js` | E5, E7 | fixture loads and reads back identically | 7 |

Where a touchpoint already has a committed fixture — `Backend/test/fixtures/ndis-quote-board.json` — the baseline test consumes it rather than inventing new data.

---

## File structure

**Phase 0 — harness**

- Create `Backend/src/app.js` — builds and returns the configured Express app. All middleware and route mounting moves here from `index.js`. Exports `createApp()`. No `listen`, no `mongoose.connect`.
- Modify `Backend/src/index.js` — becomes the bootstrap only: connect Mongo, `createApp()`, `listen`, startup job retry.
All of it exists — nothing to create. `Backend/src/app.js` (`createApp()`),
`test/setup.js` (mongodb-memory-server + `ioredis` mock), `test/helpers/auth.js`,
`test/msw/` and the four `npm test` scripts all shipped with PR #848.
`Backend/Dockerfile` gained `libcurl4` on this branch so the suite runs in the
dev container as well as in CI.

**Phase 1 — baseline** (one file per touchpoint group, so a failure names its own subject)

- `Backend/test/baseline/health.test.js`, `business-profile.test.js`, `document-numbering.test.js`, `xero-connection.test.js`, `role-gate.test.js`, `audit-trail.test.js`, `queue.test.js`, `fixture-load.test.js`

**Phase 2 — epics**

- Backend: `models/Workspace.js` (flag), `models/Business.js` (statement numbering, account/tax mapping), `routes/automation.js` (settings CRUD), `routes/internal.js` (tick endpoint, new), `services/automation/scheduler.js`, `services/automation/queue.js`, `services/email/ses.js`, `utils/automationScheduleHelpers.js`, `utils/automationEmailHelpers.js`, `routes/systemHealth.js`
- Frontend: `app/workspace/[id]/finance-settings/page.tsx` (shell + tabs), `components/finance-settings/financial-settings-tab.tsx`, `accounting-integrations-tab.tsx`, `invoice-statement-automation-tab.tsx`, `automation-status-panel.tsx`, `app/dashboard/system-health/page.tsx`

---

## Depth note

Phase 0 and Phase 1 are written to full step granularity with real code, because they are the part this plan exists to establish and the part everything else rests on. Phase 2 tasks carry exact files, interfaces, acceptance criteria and the test to write, but not every line of implementation — seven epics at that granularity is a document nobody reads, and the spec's own Track A/Track B split means two people work these in parallel. **Each Phase 2 task should be expanded into its own plan when it is picked up.** That is a deliberate boundary, not an omission.

---

# Phase 0 — Withdrawn (already built by PR #848)

Tasks 1, 2 and 3 extracted `createApp()`, built a test-database helper and built
a session-login helper. All three exist on `develop`. **Do not do them.** The
detail is in the banner at the top of this plan.

What replaces them is a one-line orientation for anyone picking this up:

```bash
cd Backend
npm test                 # vitest run — 35 files, 140 tests
npm run test:watch
npm run test:coverage
npm run test:api:live    # RUN_REAL_API_TESTS=1, hits the real ISO+ API
```

The suite needs **no** local Mongo and **no** Redis: `test/setup.js` starts
`mongodb-memory-server` and mocks `ioredis`.

**One environment fix was needed** and is included on this branch. The mongod
binary that `mongodb-memory-server` downloads links against `libcurl.so.4`,
which `node:22-bookworm-slim` does not ship, so all 35 files failed at startup
inside the dev container while CI passed on `ubuntu-latest`. `Backend/Dockerfile`
now installs `libcurl4`. Run the suite in the container with:

```bash
docker compose run --rm --no-deps backend npm test
```

### What to reuse rather than rebuild

| Need | Use |
|---|---|
| An app instance | `import { createApp } from '../../src/app.js'` |
| HTTP assertions | `supertest` — `await request(app).get('/api/healthcheck')` |
| A logged-in session | `test/helpers/auth.js` |
| A database | nothing — `test/setup.js` provides it |
| A fake ISO+ response | `test/msw/handlers.js` |
| Committed sample data | `test/fixtures/ndis-quote-board.json` |

`msw` is the important one and was not in the original plan. Because it
intercepts at the HTTP layer, an ISO+ response can be shaped per test — which is
the only practical way to drive both branches of the pricing dispatch, since
that decision reads `getBoardAttributes()` from the live API.

---

# Phase 1 — Baseline the touchpoints

Every test here asserts what the code does **today**. If one fails, the test is wrong — fix the test, not the app. These land before any epic work so the Epic 3 and 4 relocations can be shown to preserve behaviour.

### Task 4: Business profile, bank details and document numbering

**Files:**
- Test: `Backend/test/baseline/business-profile.test.js`, `Backend/test/baseline/document-numbering.test.js`

**Interfaces:**
- Consumes: `startTestServer`, `loginAs`, `authedFetch`, `connectTestDb`
- Produces: `seedBusiness(overrides?): Promise<Business>` from `Backend/test/helpers/seed.mjs` — a helper, not a test-local function, because Task 5 and every Phase 2 task import it.

- [ ] **Step 1: Add `Backend/test/helpers/seed.mjs`**

```javascript
import { readFileSync } from 'node:fs'
import Business from '../../src/models/Business.js'

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/ndis-quote-board.json', import.meta.url)),
)

export async function seedBusiness(overrides = {}) {
  const { $comment, ...business } = fixture.business
  return Business.create({ ...business, ...overrides })
}
```

- [ ] **Step 2: Write the document-numbering baseline**

```javascript
test('PUT /api/business/profile preserves all three numbering series', async () => {
  await seedBusiness()
  const { cookie } = await loginAs(server.baseUrl, 'owner')

  const before = await authedFetch(server.baseUrl, cookie, '/api/business/profile').then((r) => r.json())
  const numbering = before.documentNumbering ?? before.business?.documentNumbering
  assert.ok(numbering, 'profile response exposes documentNumbering')

  for (const series of ['invoice', 'purchaseOrder', 'quote']) {
    assert.equal(typeof numbering[series].prefix, 'string', `${series} has a prefix`)
    assert.equal(typeof numbering[series].nextNumber, 'number', `${series} has a nextNumber`)
  }
  assert.equal(numbering.statement, undefined, 'statement numbering does not exist yet')
})
```

The last assertion is the point: it fails the moment Task 10 adds Statement Numbers, which is the reminder to update the baseline deliberately.

- [ ] **Step 3: Write the bank-details round-trip**

```javascript
test('bank details survive a profile round-trip unchanged', async () => {
  await seedBusiness()
  const { cookie } = await loginAs(server.baseUrl, 'owner')
  const terms = 'Payment due within 14 days of invoice date.'

  const put = await authedFetch(server.baseUrl, cookie, '/api/business/profile', {
    method: 'PUT',
    body: JSON.stringify({ bankDetails: { accountsReceivableTerms: terms } }),
  })
  assert.equal(put.status, 200)

  const after = await authedFetch(server.baseUrl, cookie, '/api/business/profile').then((r) => r.json())
  const got = after.bankDetails ?? after.business?.bankDetails
  assert.equal(got.accountsReceivableTerms, terms)
})
```

> `PUT /api/business/profile` runs `multiupload` and `validateBusinessProfile` (`business.js:157`). If it rejects a JSON body without multipart fields, the test must send `multipart/form-data` instead — discover this by running it, and record whichever it is in a comment. Do not delete the assertion to make it pass.

- [ ] **Step 4: Run, then commit**

Run: `cd Backend && npm test`

```bash
git add Backend/test
git commit -m "test: baseline business profile, bank details and document numbering"
```

---

### Task 5: Xero connection and the document-push contracts

**Files:**
- Test: `Backend/test/baseline/xero-connection.test.js`

- [ ] **Step 1: Baseline the connection endpoints**

Assert that `POST /api/business/xero/connect` and `/xero/disconnect` (`business.js:292,336`) reject an unauthenticated caller with 401, and that a logged-in `owner` gets a non-5xx response. **Do not** perform a real OAuth handshake — no test may depend on a live Xero tenant.

```javascript
test('xero connect requires authentication', async () => {
  const res = await fetch(`${server.baseUrl}/api/business/xero/connect`, { method: 'POST' })
  assert.equal(res.status, 401)
})
```

- [ ] **Step 2: Baseline the quote-push route contract from the fixture**

Uses the committed webhook body so the route contract and the fixture cannot drift apart:

```javascript
import { readFileSync } from 'node:fs'
const fixture = JSON.parse(readFileSync(new URL('../fixtures/ndis-quote-board.json', import.meta.url)))

test('POST /api/pdf/:ws/:board/quotendis answers 200 and reports failure in the body', async () => {
  const { items } = fixture.webhookPayloads.quotendis
  const res = await fetch(`${server.baseUrl}/api/pdf/55369/eNiJpH14PN3/quotendis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  })
  // This family always answers 200; failures are in the body. That is the
  // documented behaviour and the reason these routes fail silently today.
  assert.equal(res.status, 200)
})
```

- [ ] **Step 3: Run, then commit**

```bash
git add Backend/test/baseline/xero-connection.test.js
git commit -m "test: baseline Xero connection auth and the quote-push contract"
```

---

### Task 6: Role gate and workspace CRUD

**Files:**
- Modify: `Backend/test/baseline/role-gate.test.js`
- Test: `Backend/test/baseline/workspace.test.js`

- [ ] **Step 1: Pin the role gate on a route that already uses it**

Find a route mounted behind `requirePortalOwnerOrSupport` (time tracking, per its message) and assert the matrix:

```javascript
const EXPECTED = { owner: 'allowed', support_admin: 'allowed', isoplus_user: 403 }

for (const [role, expectation] of Object.entries(EXPECTED)) {
  test(`${role} against a portal-owner-or-support route`, async () => {
    const { cookie } = await loginAs(server.baseUrl, role)
    const res = await authedFetch(server.baseUrl, cookie, '/api/timetracks')
    if (expectation === 403) {
      assert.equal(res.status, 403)
      const body = await res.json()
      assert.match(body.message, /Owner or Support Admin/)
    } else {
      assert.notEqual(res.status, 403, `${role} must not be refused`)
    }
  })
}
```

This matrix is what Epic 2 and Epic 6 reuse. Getting it wrong means the feature toggle is visible to clients.

- [ ] **Step 2: Baseline workspace listing — as a *live* test, not a baseline one**

Per R9, `GET /api/workspaces` proxies ISO+ and cannot run offline. It goes in `test/real-api/workspaces.test.js`, skipped unless `RUN_REAL_API_TESTS=1`:

```javascript
const live = process.env.RUN_REAL_API_TESTS === '1'

test('GET /api/workspaces proxies ISO+ and includes workspace 55369',
  { skip: !live && 'set RUN_REAL_API_TESTS=1 and a valid PERSONAL_ACCESS_TOKEN' },
  async () => {
    const { cookie } = await loginAs(server.baseUrl, 'owner')
    const res = await authedFetch(server.baseUrl, cookie, '/api/workspaces')
    assert.equal(res.status, 200)
    const body = await res.json()
    const ids = (body.workspaces ?? body).map((w) => String(w.id ?? w.workspaceId))
    assert.ok(ids.includes('55369'), `expected 55369 among ${ids.join(', ')}`)
  })
```

- [ ] **Step 3: Baseline the offline half instead**

What *can* be pinned without the network is the business document that owns workspace-scoped portal settings. **Superseded by Epic 2 (KAN-7):** assert a new `Business` defaults `featureToggles.invoiceStatementAutomation` to `false` (see `Backend/test/unit/models/business.test.js` / feature-toggle helpers). The historical sketch below used a Workspace field that was never shipped:

```javascript
// Historical sketch — do not implement. Epic 2 uses Business.featureToggles instead.
test('a new Workspace document has no automation flag yet', async () => {
  const ws = await Workspace.create({ name: 'Fixture WS', userId: someUserId, businessId: someBusinessId })
  assert.equal(ws.invoiceStatementAutomationEnabled, undefined)
})
```

- [ ] **Step 3: Run, then commit**

```bash
git add Backend/test/baseline
git commit -m "test: baseline the owner/support role gate and workspace CRUD"
```

---

### Task 7: Audit trail and the job queue

**Files:**
- Test: `Backend/test/baseline/audit-trail.test.js`, `Backend/test/baseline/queue.test.js`

- [ ] **Step 1: Baseline audit writes**

Docs 1, 2 and 5 all build visibility on the Audit Trail, so its shape is load-bearing. Assert that a request through `auditHttpMiddleware` writes one row carrying `workspaceId`, `action`, `detail`, `userEmail`, `userRole`, `requestId`.

```javascript
test('an audited request writes exactly one audit row', async () => {
  const { cookie } = await loginAs(server.baseUrl, 'owner')
  await AuditTrail.deleteMany({})
  await authedFetch(server.baseUrl, cookie, '/api/business/profile')

  const rows = await AuditTrail.find({}).lean()
  assert.equal(rows.length, 1)
  assert.ok(rows[0].requestId, 'request context reached the audit row')
})
```

If more than one row appears, that is a finding — record the actual count and why, do not loosen the assertion to `>= 1`.

- [ ] **Step 2: Baseline the queue**

Against the local Redis on 6380. Assert `syncQueue` accepts a job and reports depth — this is the metric Epic 6.6 surfaces.

```javascript
test('syncQueue accepts a job and reports a countable depth', async () => {
  const before = await syncQueue.getJobCounts('waiting')
  const job = await syncQueue.add('baseline-probe', { probe: true }, { removeOnComplete: true })
  const after = await syncQueue.getJobCounts('waiting')
  assert.ok(after.waiting >= before.waiting)
  await job.remove()
})
```

No Redis guard is needed. `test/setup.js` mocks `ioredis` for the whole suite, so
queue code runs against the mock rather than a real broker. If a test genuinely
needs real Redis, put it in `test/real-api/` behind `RUN_REAL_API_TESTS=1` rather
than adding a per-file skip.

- [ ] **Step 3: Run the whole baseline, then commit**

Run: `cd Backend && npm test`
Expected: every Phase 1 test passes against unmodified application code. **If any test needed an application change to pass, stop** — that is a bug found, and it needs its own ticket before Phase 2 starts.

```bash
git add Backend/test/baseline
git commit -m "test: baseline audit trail writes and sync queue depth"
```

---

# Phase 2 — The seven epics

Each task below is a candidate for its own expanded plan when picked up. Track A and Track B can proceed in parallel after Task 8.

**Progress:** Tasks 8–9 (Epic 2 / Epic 1 — KAN-7 / KAN-6) are **done**. See [Epic 1 (KAN-6) & Epic 2 (KAN-7) — implemented](#epic-1-kan-6--epic-2-kan-7--implemented). Resume at Task 10 (Epic 3).

### Task 8: Epic 2 — workspace feature toggle (Track A, unblocks everything) — **DONE (KAN-7)**

> Implemented. See [Epic 1 (KAN-6) & Epic 2 (KAN-7) — implemented](#epic-1-kan-6--epic-2-kan-7--implemented) above. Do not re-do this task.

**Files (as built):** `Backend/src/models/Business.js`, `Backend/src/utils/workspaceFeatureToggleHelpers.js`, `Backend/src/routes/workspace.js`; `Frontend/lib/workspace-feature-toggles.ts`, `Frontend/lib/workspace-feature-toggles-card.tsx`, `Frontend/app/workspace/[id]/configuration/page.tsx`; Tests `Backend/test/unit/utils/workspaceFeatureToggleHelpers.test.js`, `Backend/test/integration/workspace.route.test.js`, `Backend/test/unit/models/business.test.js`

**Interfaces produced (as built):** `Business.featureToggles.invoiceStatementAutomation: Boolean` (default `false`); `GET` / `PUT /api/workspaces/:workspaceId/feature-toggles` accepting `{ invoiceStatementAutomation: boolean }`, gated by `requirePortalOwnerOrSupport`; profile responses include `featureToggles`. *(Original sketch used `Workspace.invoiceStatementAutomationEnabled` and `PATCH .../features` — superseded.)*

- [x] Write failing tests: default is `false` (2.2); `isoplus_user` cannot mutate; `owner` and `support_admin` succeed; flag persists via feature-toggles API (2.3).
- [x] Add the field to the schema (`Business.featureToggles`).
- [x] Add the routes using the **existing** `requirePortalOwnerOrSupport`, per R1.
- [x] Expose the flag to the frontend for tab gating (profile + dedicated endpoints; not via proxied `GET /api/workspaces`).
- [x] ~~Update System Owner / Support Admin documentation (2.4) — inline help on the Feature Toggles card.~~ **Removed** — inline help and related permission copy were dropped from Workspace Configuration; no separate markdown guide.

**Covers:** 2.1, 2.2, 2.3. **2.4** inline docs removed. The same toggle still hides the tab for NDIS/SaH/IMS workspaces — no separate toggle.

---

### Task 9: Epic 1 — navigation and entry point (Track A) — **DONE (KAN-6)**

> Implemented. See [Epic 1 (KAN-6) & Epic 2 (KAN-7) — implemented](#epic-1-kan-6--epic-2-kan-7--implemented) above. Do not re-do this task.

**Files (as built):** `Frontend/app/workspace/[id]/page.tsx`; `Frontend/app/workspace/[id]/finance-settings/page.tsx`; `Frontend/lib/finance-settings-page.tsx`, `Frontend/lib/finance-settings-tab.ts`; Test `Frontend/test/unit/finance-settings-tab.test.ts`. `/xero-integration` redirects to finance-settings accounting tab.

- [x] Rename the tile "Xero Integration" → "Finance Settings & Automation", title and subtitle (1.1). Workspace page, per R2.
- [x] Build the page shell: header, **Back to Workspace**, **full-width** content (1.2). Formal breadcrumb component not used.
- [x] Build the three-tab nav: Financial Settings / Accounting Integrations / Invoice & Statement Automation (1.3).
- [x] Render tab 3 only when `featureToggles.invoiceStatementAutomation` is true (1.4 — needs Task 8). Placeholder body until Epic 5.
- [x] Test: tab resolve hides/redirects automation when the flag is false; shows when true.

**Covers:** 1.1, 1.2, 1.3, 1.4.

---

### Task 10: Epic 3 — Financial Settings tab (Track A)

**Files:** `Frontend/lib/financial-settings-{form,panel}.tsx`, `Frontend/lib/finance-settings-page.tsx`, `Backend/src/models/Business.js`, `Frontend/app/workspace/[id]/configure-business/page.tsx`

**Interfaces produced:** `Business.documentNumbering.statement: { prefix: String (default 'STM-'), nextNumber: Number (default 1) }` — same shape as the other three, per R4. Default prefix follows the Finance Settings mockup (`STM-`), not the earlier plan draft (`ST-`).

- [x] Move Bank Details and Document Number Configuration out of Configure Your Business → Additional Settings into the Financial Settings tab, **no behaviour change** (3.1, 3.2). Additional Settings tab removed; Configure Business Basic save still passthroughs numbering so it cannot wipe Financial Settings.
- [x] Add Statement Numbers — real, required (same validation as Invoice/PO/Quote), feeds Task 13 (3.3).
- [x] Add Credit Note Numbers **disabled/greyed**, not hidden (3.4).
- [x] Data migration (3.5): **no-op**. Bank details and Invoice/PO/Quote numbering already live on `Business.bankDetails` / `Business.documentNumbering`; clients keep those values. No second storage location and no empty migration file. Statement is additive (`STM-` / `1000` via schema default for new docs; existing docs gain it on next profile save or when Mongoose applies defaults on create paths).
- [x] Regression (3.6): Configure Business no longer exposes Additional Settings; Financial Settings form/panel unit tests cover Bank Details + Document Numbering (+ statement / disabled credit note); Xero accounting routes and signed-out finance-settings auth boundary remain covered separately.

**Covers:** 3.1–3.6. Status: done on `feature/KAN-8-epic-3-financial-settings-tab-relocation-one`.

---

### Task 11: Epic 4 — Accounting Integrations tab (Track A)

**Files (as built):** `Frontend/lib/accounting-integrations-panel.tsx`, `Frontend/lib/xero-connect-section.tsx`, `Frontend/lib/xero-disabled-sync-toggles.tsx`, `Frontend/lib/xero-account-tax-mapping.tsx`, `Frontend/lib/xero-account-tax-mapping-options.ts`; Backend persists on `Business.xeroLineItemMapping` (not a renamed `accountingMapping`). Old `/xero-integration` redirects to finance-settings accounting tab.

**Interfaces produced:** `Business.xeroLineItemMapping: { quote, purchaseOrder, invoice, quoteOverrides: { quoteService, material } }` each `{ accountCode, taxType, taxRatePercent }`.

**Authorization (client Finance Settings):** mapping routes are **not** Owner/Support-only.

| Route | Gate |
|---|---|
| `GET /api/business/xero/account-tax-options` | `authenticateToken` only |
| `PUT /api/business/xero/line-item-mapping` | `authenticateToken` only |
| Connect / disconnect / profile / update-organization | `authenticateToken` only (unchanged) |
| Workspace **feature-toggles** (whether the Automation tab exists) | still Owner / Support Admin |

Any authenticated workspace client (`isoplus_user` via ISO+ OAuth) must be able to load chart options and save mapping on Accounting Integrations. An Owner/Support Admin gate on the two mapping routes was a regression that returned `403` with `Access denied. Owner or Support Admin permission required.` — removed.

**Connection actions on the Accounting Integrations tab** (`xero-connect-section.tsx`):

| State | Primary action | Disconnect |
|---|---|---|
| Not connected | **Connect Xero** | hidden |
| Tokens present + reconnect required (`needsReconnect`) | **Reconnect Xero** | **hidden** |
| Connected, healthy | — | **Disconnect Xero** |

- [x] Tab shell with Xero / MYOB / QuickBooks sub-tabs, full page width (4.1).
- [x] Relocate Connect Xero / Test Connection with **no behaviour change** — Task 5's baseline is the proof (4.2). *(Post-ship: Reconnect hides Disconnect when reconnect is required; Disconnect label is **Disconnect Xero**.)*
- [x] Invoice/Customer/Payment/Contact Sync toggles, disabled/greyed (4.3).
- [x] MYOB and QuickBooks sub-tabs inactive (4.4).
- [x] Default Account + Tax Rate per document type, plus the Quote line-item override table (4.5). Tax rates filtered by Xero `canApplyToRevenue` / `canApplyToExpenses` for the selected account class; accounts prefer REVENUE for Quote/Invoice and EXPENSE for Purchase Order (AU mockup names are examples, not hard-coded).
- [x] Mapping APIs allow `isoplus_user` (same `authenticateToken` gate as connect/disconnect); integration tests cover OAuth client load + save.

**Open question from the spec (doc 4, verbatim):** the line-item override table is Quote-only "for now" — confirmed Quote-only for this ship (matches mockup).

**Covers:** 4.1–4.5. Status: gap-finished on `feature/KAN-9-epic-4-accounting-integrations-tab-track-a` (core UI already on develop). Client access + reconnect button behaviour recorded above.

---

### Task 12: Epic 5 (part 1) — automation settings UI and persistence (Track B)

**Files:** Create `Frontend/components/finance-settings/invoice-statement-automation-tab.tsx`, `Backend/src/routes/automation.js` additions, `Backend/src/utils/automationScheduleHelpers.js`

**Interfaces produced:** an `AutomationSettings` document per workspace holding, for each of `invoice` and `statement`: `enabled`, `every: {n: Number, unit: 'day'|'week'|'month'|'quarter'|'year'}`, `runOn`, `runAt`, `startDate`, `nextRun`, `sendMethod: 'isoplus'|'accounting'`, `recipient: 'billing_contact'|'client_participant'`, `sendCopyTo`, `replyTo`, `emailFrom`, `emailSubject`, `emailMessage`, `senderIdentityId: String|null` (nullable now, per doc 2's phased sender plan).

- [ ] Both blocks — invoice and statement — independently enableable (5.1–5.4).
- [ ] `Run On` options change with the selected unit: Week → Mon–Sun; Month → 1st–31st; Quarter/Year → month + day.
- [ ] `Next Run` is read-only and computed. Compute it in `automationScheduleHelpers.js` as a pure function so it is unit-testable without a clock: `computeNextRun(settings, from: Date, timezone: string): Date`.
- [ ] Validate `sendCopyTo` and `replyTo` as email addresses, with an inline error (doc 5).
- [ ] Save Changes / Restore Defaults for both blocks (5.5).
- [ ] Exclude the struck-through mockup fields — Invoice scope, Eligible billing items, Statement type, Statement period, Transaction types.
- [ ] Test `computeNextRun` across all five units, a month-end rollover (31st in a 30-day month), and a DST boundary in `Australia/Sydney`. This is where scheduling bugs live.

**Covers:** 5.1–5.5.

---

### Task 13: Epic 5 (part 2) — the scheduler engine (Track B)

**Files:** Create `Backend/src/routes/internal.js`, `Backend/src/services/automation/queue.js`, `Backend/src/services/automation/scheduler.js`, `Backend/src/workers/automationWorker.js`

**Interfaces produced:** `POST /api/internal/automation/tick` (shared-secret protected); `automationQueue` (separate from `syncQueue` per R7); `findDueAutomations(now: Date): Promise<AutomationSettings[]>`

- [ ] Tick endpoint queries `nextRun <= now()` and enqueues one job per due automation (doc 2).
- [ ] Redlock-style short lock keyed on the automation id, so an overlapping tick cannot double-send. **Test the double-fire case explicitly** — invoke the tick twice concurrently and assert one job.
- [ ] Worker assembles the invoice/statement, renders the PDF, sends, then recomputes and persists `nextRun`.
- [ ] Retries/backoff via BullMQ job options; after N failures mark it failed in the audit log.
- [ ] Every run writes success/failure, recipient and timestamp to the Audit Trail — Task 7's baseline defines that shape.
- [ ] Protect the tick endpoint. It triggers real billing email; an unauthenticated endpoint that sends invoices is not acceptable. Note the existing precedent to avoid: `hookSecret` is stored and never verified (`docs/ongoing/webhooks-and-automation.md`).

**Covers:** 5.6, 5.7. **New AWS:** EventBridge Scheduler rule + IAM role (doc 2, rows 1–2).

---

### Task 14: Epic 5 (part 3) — SES delivery and the document header (Track B)

**Files:** Create `Backend/src/services/email/ses.js`, `Backend/src/utils/automationEmailHelpers.js`

- [ ] Verify the `mail.isoplus.online` subdomain with DKIM/SPF — **not** the primary domain (doc 2).
- [ ] Configuration set + SNS topic for bounce/complaint, feeding a suppression list.
- [ ] **Request SES production access on day one.** The account starts in sandbox and approval takes a day or two; this is the one item with external lead time and it blocks 5.9.
- [ ] Phase 1 sender: one shared verified identity, `Reply-To` set to the client's field. Write `senderIdentityId` as null now so phase 2 needs no migration.
- [ ] Subject-line templating: `{{invoice_number}}`, `{{statement_number}}`, `{{client_name}}`, `{{business_name}}`. Test that an unknown token is left intact rather than rendering "undefined".
- [ ] Invoice/statement header aligned with the Tax Invoice header (5.8).
- [ ] 5.9 — enable the flag for one pilot client and verify end to end. **Joint checkpoint: both tracks verify together.**

**Covers:** 5.8, 5.9. **New AWS:** SES domain identity, configuration set, SNS topic (doc 2, rows 3–5).

---

### Task 15: Epic 6 (part 1) — client-facing status panel (Track B)

**Files:** Create `Frontend/components/finance-settings/automation-status-panel.tsx`

- [ ] Panel sits **above** the settings blocks on tab 3.
- [ ] Status badge: On track / Attention needed / Paused, mirroring the enable switches.
- [ ] Next run, last run, and the last **10** generated documents with recipient, sent time and delivery state (6.1).
- [ ] Bounce/delivery failures inline, in plain English — "Email address doesn't exist", not an SES error code (6.2).
- [ ] Reads existing Audit Trail rows and SES configuration-set events. No new tracking system.

**Covers:** 6.1, 6.2.

---

### Task 16: Epic 6 (part 2) — System Health admin screens (Track B)

**Files:** Create `Backend/src/routes/systemHealth.js`, `Frontend/app/dashboard/system-health/page.tsx`

- [ ] Dashboard tile visible to `owner` and `support_admin` only (6.3) — reuse the Task 6 matrix.
- [ ] Global overview: active automations, runs today/this week split success/failed, queue depth, 24h error rate with trend, 7-day bounce/complaint count, per-client connection status grid (6.4).
- [ ] Per-client drill-down: full run history **not capped at 10**, every email with delivery state, connection status, and the admin-only **Run now** / **Retry failed run** actions (6.5).
- [ ] Expose BullMQ queue depth and accounting connection status to both the client panel and the admin screens (6.6).
- [ ] Test the role gate on every new endpoint. An `isoplus_user` reaching cross-client data is a tenancy breach, not a cosmetic bug.

**Covers:** 6.3–6.6. Explicitly out of scope: alerting thresholds (doc 1 defers these).

---

### Task 17: Epic 7 — automatic sync from ISO+ (Track A)

**Superseded.** Do not implement the `/api/internal` sketch or per-board
schedules from earlier drafts of this plan. Design and execution live in:

- [`docs/superpowers/specs/2026-08-19-automatic-board-sync-schedule-design.md`](../superpowers/specs/2026-08-19-automatic-board-sync-schedule-design.md)
- [`docs/plans/2026-08-19-automatic-board-sync-schedule-plan.md`](2026-08-19-automatic-board-sync-schedule-plan.md)

Portal-wide `board_sync` (`targetId: portal`), `BOARD_SYNC_CRON` (default
`0 2 * * *`), fan-out of `scheduled_sync` onto `board-sync`, worker
concurrency 1. Enable-time backlog and ISO+ webhooks stay.

**Covers:** 7.1.

---

## Out of scope this round

Carried from doc 6, not planned here: Contact/Invoice/Customer/Payment Sync working logic; the Credit Note feature; the struck-through mockup fields (Invoice scope, Eligible billing items, Statement type, Statement period, Transaction types); alerting infrastructure.

---

## Self-review

**Spec coverage.** Every numbered task in doc 6 maps to a task above: E1→9, E2→8, E3→10, E4→11, E5→12/13/14, E6→15/16, E7→17. Docs 1–5 are absorbed into those tasks; doc 2's five new AWS resources appear in Tasks 13 and 14; doc 1's global overview and drill-down in Task 16; doc 3's three numbering decisions in Task 10; doc 4's mapping fields in Task 11; doc 5's field table in Task 12.

**Gaps I am flagging rather than papering over:**
- Epic 7 (R8) is specified in `docs/superpowers/specs/2026-08-19-automatic-board-sync-schedule-design.md` and executed by `docs/plans/2026-08-19-automatic-board-sync-schedule-plan.md` — Task 17 above is a pointer, not work to do here.
- The Quote-only line-item override (doc 4) is an open question the spec itself raises.
- Phase 2 tasks are specified to interface level, not line level — stated in the depth note above, deliberately.

**Type consistency.** `createApp()`, `startTestServer()`, `loginAs()`, `authedFetch()`, `connectTestDb()`, `resetTestDb()`, `seedBusiness()` and `computeNextRun()` are used with the same names and signatures wherever they appear. `Business.documentNumbering.statement` (Task 10) remains for Epic 3. **Epic 2 shipped as** `Business.featureToggles.invoiceStatementAutomation` (not `Workspace.invoiceStatementAutomationEnabled`) — later tasks must use that name and the feature-toggles / profile APIs.

**Ordering.** Task 1 blocks all tests. Task 8 blocks Task 9.4 — **both done (KAN-7 / KAN-6)**. Task 12 blocks 13, which blocks 14. Task 14's SES production access has external lead time and should be requested during Phase 0.
