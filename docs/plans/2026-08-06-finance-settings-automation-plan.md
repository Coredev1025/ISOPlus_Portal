# Finance Settings & Automation: baseline tests, then seven epics

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Ticket:** _none yet — required before branching (see [CLAUDE.md](../../CLAUDE.md))_
**Date:** 2026-08-06
**Status:** Draft, pending approval
**Source spec:** six documents, `1. System Health & Monitoring` … `6. Implementation Task Breakdown`, dated 2026-08-02

**Goal:** Ship the Finance Settings & Automation area — a renamed entry point, a per-workspace feature toggle, relocated Financial Settings, a multi-provider Accounting Integrations tab, scheduled invoice/statement generation and delivery, and the monitoring to see it working — on top of an end-to-end test baseline that covers every existing touchpoint the seven epics disturb.

**Architecture:** Phase 0 makes the backend testable at all (the Express app is currently not importable). Phase 1 writes characterization tests against **existing** behaviour at each touchpoint, before any of it is moved — so the large relocations in Epics 3 and 4 are provably behaviour-preserving. Phase 2 builds the epics against that net. The scheduler follows the spec's "tick + existing queue" approach: one EventBridge rule hits an internal endpoint, which enqueues due automations onto the BullMQ/Redis instance already used for sync.

**Tech Stack:** Node 20+ ESM, Express, Mongoose/MongoDB, BullMQ + Redis, Next.js 15 App Router, shadcn/ui, AWS SES + EventBridge Scheduler, `node:test` + `node:assert/strict`.

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
| R5 | — | `src/index.js` calls `app.listen()` (`:188`) and `mongoose.connect()` (`:164`) at import time and **never exports the app** | **Nothing can be tested end-to-end until this is split.** Task 1 |
| R6 | — | `authenticateToken` reads `req.session.token`, not an `Authorization` header (`middleware/auth.js:43`) | Tests need a cookie jar and a real `POST /api/auth/login`, not a bearer token |
| R7 | Reuse "the existing Redis queue" | One queue exists: `syncQueue` in `services/sync/queue.js:101`, drained by `workers/syncWorker.js:693` | Decide: second queue, or new job type on `syncQueue`. Task 13 assumes a **separate** `automationQueue` so a stuck sync backlog cannot delay billing |
| R8 | Epic 7: "create a schedule to sync automatically" | One sentence, no acceptance criteria, no cadence, no failure behaviour | **Underspecified.** Task 17 covers only the mechanism; the policy needs a design first |

**R8 is the one to resolve before Phase 2.** The rest can be decided in review.

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
| Workspace CRUD | `routes/workspace.js:145,227` | E2 | create/list unaffected by the new flag | 6 |
| Item/board storage | `models/Item.js`, `Board.js` | E5, E7 | fixture loads and reads back identically | 7 |

Where a touchpoint already has a committed fixture — `Backend/test/fixtures/ndis-quote-board.json` — the baseline test consumes it rather than inventing new data.

---

## File structure

**Phase 0 — harness**

- Create `Backend/src/app.js` — builds and returns the configured Express app. All middleware and route mounting moves here from `index.js`. Exports `createApp()`. No `listen`, no `mongoose.connect`.
- Modify `Backend/src/index.js` — becomes the bootstrap only: connect Mongo, `createApp()`, `listen`, startup job retry.
- Create `Backend/test/helpers/app.mjs` — boots an app instance on an ephemeral port for a test file; returns `{ baseUrl, close }`.
- Create `Backend/test/helpers/db.mjs` — connects to a **test** database, and truncates between files.
- Create `Backend/test/helpers/auth.mjs` — logs a role in and returns a cookie jar.
- Modify `Backend/package.json` — add `"test": "node --test test/**/*.test.mjs"`.

**Phase 1 — baseline** (one file per touchpoint group, so a failure names its own subject)

- `Backend/test/baseline/health.test.mjs`, `business-profile.test.mjs`, `document-numbering.test.mjs`, `xero-connection.test.mjs`, `role-gate.test.mjs`, `audit-trail.test.mjs`, `queue.test.mjs`, `fixture-load.test.mjs`

**Phase 2 — epics**

- Backend: `models/Workspace.js` (flag), `models/Business.js` (statement numbering, account/tax mapping), `routes/automation.js` (settings CRUD), `routes/internal.js` (tick endpoint, new), `services/automation/scheduler.js`, `services/automation/queue.js`, `services/email/ses.js`, `utils/automationScheduleHelpers.js`, `utils/automationEmailHelpers.js`, `routes/systemHealth.js`
- Frontend: `app/workspace/[id]/finance-settings/page.tsx` (shell + tabs), `components/finance-settings/financial-settings-tab.tsx`, `accounting-integrations-tab.tsx`, `invoice-statement-automation-tab.tsx`, `automation-status-panel.tsx`, `app/dashboard/system-health/page.tsx`

---

## Depth note

Phase 0 and Phase 1 are written to full step granularity with real code, because they are the part this plan exists to establish and the part everything else rests on. Phase 2 tasks carry exact files, interfaces, acceptance criteria and the test to write, but not every line of implementation — seven epics at that granularity is a document nobody reads, and the spec's own Track A/Track B split means two people work these in parallel. **Each Phase 2 task should be expanded into its own plan when it is picked up.** That is a deliberate boundary, not an omission.

---

# Phase 0 — Make the backend testable

### Task 1: Extract `createApp()` so the app can be imported without listening

**Files:**
- Create: `Backend/src/app.js`
- Modify: `Backend/src/index.js`
- Modify: `Backend/package.json`
- Test: `Backend/test/baseline/health.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `createApp(): express.Application` from `src/app.js` — every later test imports this.

- [ ] **Step 1: Add the test script**

In `Backend/package.json`, add to `scripts`:

```json
"test": "node --test test/**/*.test.mjs"
```

CI already runs `npm test --if-present`, so this starts running on merge with no CI change.

- [ ] **Step 2: Write the failing test**

`Backend/test/baseline/health.test.mjs`:

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../../src/app.js'

test('createApp returns an app without binding a port', async () => {
  const app = createApp()
  assert.equal(typeof app.listen, 'function')
})

test('GET /api/healthcheck reports OK', async () => {
  const app = createApp()
  const server = app.listen(0)
  try {
    const { port } = server.address()
    const res = await fetch(`http://127.0.0.1:${port}/api/healthcheck`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'OK' })
  } finally {
    server.close()
  }
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd Backend && npm test`
Expected: FAIL — `Cannot find module '../../src/app.js'`.

- [ ] **Step 4: Create `src/app.js`**

Move everything from `index.js` between `const app = express()` and the `errorHandler` mount into a `createApp()` function, unchanged. Keep import order — `requestContextMiddleware` and `auditHttpMiddleware` must stay ahead of the route mounts or audit rows lose their request context.

```javascript
export function createApp() {
  const app = express()
  // ... existing middleware, in the existing order ...
  // ... existing app.use('/api/...', ...) mounts, unchanged ...
  app.use(errorHandler)   // must remain last
  return app
}
```

- [ ] **Step 5: Reduce `index.js` to a bootstrap**

```javascript
import mongoose from 'mongoose'
import { createApp } from './app.js'
import { info, error as logError } from './utils/logger.js'
import { checkAndRetryFailedJobs } from './services/sync/queue.js'

await mongoose.connect(process.env.MONGODB_URI)

const app = createApp()
const PORT = process.env.PORT || 3001

app.listen(PORT, () => {
  info('Bootstrap', `Server is running on port ${PORT}`)
  setTimeout(async () => {
    try {
      await checkAndRetryFailedJobs()
    } catch (err) {
      logError('Bootstrap', 'Error checking failed jobs on startup', err)
    }
  }, 3000)
})
```

Match the real import paths in the current `index.js` — the names above are illustrative of shape, not a licence to guess module locations.

- [ ] **Step 6: Run the test**

Run: `cd Backend && npm test`
Expected: PASS, 2 tests.

- [ ] **Step 7: Verify the real server still boots**

Run: `npm run dev:up && curl -s localhost:4001/api/healthcheck`
Expected: `{"status":"OK"}`. Also confirm Bull Board still answers at `localhost:4001/api/queues` — that mount is easy to drop during the move.

- [ ] **Step 8: Commit**

```bash
git add Backend/src/app.js Backend/src/index.js Backend/package.json Backend/test
git commit -m "refactor: extract createApp so the backend can be tested without listening"
```

---

### Task 2: Test database helper

**Files:**
- Create: `Backend/test/helpers/db.mjs`
- Test: `Backend/test/baseline/fixture-load.test.mjs`

**Interfaces:**
- Consumes: `createApp()` (Task 1)
- Produces: `connectTestDb(): Promise<mongoose.Connection>`, `resetTestDb(): Promise<void>`, `disconnectTestDb(): Promise<void>`

- [ ] **Step 1: Write the helper**

`Backend/test/helpers/db.mjs`:

```javascript
import mongoose from 'mongoose'

// Never the dev database. A test run truncates collections, and pointing this
// at business-dashboard would delete a seeded dump someone waited on.
const TEST_DB = process.env.MONGO_TEST_DB || 'business-dashboard-test'

function testUri() {
  const base = process.env.MONGODB_URI
  if (!base) throw new Error('MONGODB_URI is not set')
  const uri = new URL(base)
  uri.pathname = `/${TEST_DB}`
  if (!/(?:@|\/\/)(?:localhost|127\.0\.0\.1|mongo)[:/]/.test(base)) {
    throw new Error(`refusing to run tests against a non-local database: ${uri.host}`)
  }
  return uri.toString()
}

export async function connectTestDb() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(testUri())
  return mongoose.connection
}

export async function resetTestDb() {
  const { collections } = mongoose.connection
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})))
}

export async function disconnectTestDb() {
  await mongoose.disconnect()
}
```

- [ ] **Step 2: Write the failing test**

`Backend/test/baseline/fixture-load.test.mjs`:

```javascript
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { connectTestDb, resetTestDb, disconnectTestDb } from '../helpers/db.mjs'
import Item from '../../src/models/Item.js'

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/ndis-quote-board.json', import.meta.url)),
)

before(connectTestDb)
beforeEach(resetTestDb)
after(disconnectTestDb)

test('fixture items round-trip through the Item model', async () => {
  const [quote17] = fixture.items
  await Item.create({
    workspaceId: fixture.business.workspaceId,
    boardId: fixture.board.boardId,
    folderId: quote17.folderId,
    itemId: quote17.itemId,
    data: quote17.data,
  })

  const found = await Item.findOne({ itemId: quote17.itemId }).lean()
  assert.equal(found.data['Recipient of the Quote'], 'Fixture Test Recipient')
  assert.equal(found.isoPlusItemId, quote17.itemId, 'pre-save hook mirrors itemId')
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd Backend && npm test`
Expected: FAIL — helper module not found, then a connection error if Mongo is down.

- [ ] **Step 4: Make it pass**

Start infra: `npm run dev:up`. Re-run.
Expected: PASS.

> The `isoPlusItemId` assertion is deliberate. `Item.pre('save')` sets it, but `findOneAndUpdate` — which `dev-fixture.mjs` uses — **does not fire that hook**. This test documents the difference; expect it to matter in Task 7.

- [ ] **Step 5: Commit**

```bash
git add Backend/test
git commit -m "test: add a test-database helper and pin Item round-tripping"
```

---

### Task 3: Authenticated request helper

**Files:**
- Create: `Backend/test/helpers/app.mjs`
- Create: `Backend/test/helpers/auth.mjs`
- Test: `Backend/test/baseline/role-gate.test.mjs` (started here, completed in Task 6)

**Interfaces:**
- Consumes: `createApp()`, `connectTestDb()`
- Produces:
  - `startTestServer(): Promise<{ baseUrl: string, close: () => Promise<void> }>`
  - `loginAs(baseUrl, role: 'owner'|'support_admin'|'isoplus_user'): Promise<{ cookie: string }>`
  - `authedFetch(baseUrl, cookie, path, init?): Promise<Response>`

- [ ] **Step 1: Write `app.mjs`**

```javascript
import { createApp } from '../../src/app.js'

export async function startTestServer() {
  const server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  }
}
```

- [ ] **Step 2: Write `auth.mjs`**

Auth is a **session cookie**, not a bearer header (`middleware/auth.js:43`), so the helper logs in for real and keeps the `Set-Cookie` value.

```javascript
import User from '../../src/models/User.js'

const PASSWORD = 'test-only-password'

export async function loginAs(baseUrl, role) {
  const email = `${role}@fixture.test`
  // The User pre('save') hook hashes the password; setting it directly would
  // store plaintext and the login below would never match.
  let user = await User.findOne({ email })
  if (!user) user = new User({ email, role })
  user.password = PASSWORD
  user.role = role
  user.disabled = false
  await user.save()

  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (res.status !== 200) {
    throw new Error(`login failed for ${role}: ${res.status} ${await res.text()}`)
  }
  const cookie = res.headers.getSetCookie().join('; ')
  if (!cookie) throw new Error(`login for ${role} returned no session cookie`)
  return { cookie }
}

export function authedFetch(baseUrl, cookie, path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', cookie, ...(init.headers || {}) },
  })
}
```

- [ ] **Step 3: Write the failing test**

`Backend/test/baseline/role-gate.test.mjs`:

```javascript
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from '../helpers/app.mjs'
import { loginAs } from '../helpers/auth.mjs'
import { connectTestDb, resetTestDb, disconnectTestDb } from '../helpers/db.mjs'

let server
before(async () => { await connectTestDb(); await resetTestDb(); server = await startTestServer() })
after(async () => { await server.close(); await disconnectTestDb() })

for (const role of ['owner', 'support_admin', 'isoplus_user']) {
  test(`${role} can log in and receives a session cookie`, async () => {
    const { cookie } = await loginAs(server.baseUrl, role)
    assert.match(cookie, /connect\.sid|session/i)
  })
}
```

- [ ] **Step 4: Run it**

Run: `cd Backend && npm test`
Expected: PASS. If the cookie name assertion fails, read the actual `Set-Cookie` and fix the pattern — do not weaken it to `assert.ok(cookie)`.

- [ ] **Step 5: Commit**

```bash
git add Backend/test/helpers Backend/test/baseline/role-gate.test.mjs
git commit -m "test: add server and session-login helpers for end-to-end tests"
```

---

# Phase 1 — Baseline the touchpoints

Every test here asserts what the code does **today**. If one fails, the test is wrong — fix the test, not the app. These land before any epic work so the Epic 3 and 4 relocations can be shown to preserve behaviour.

### Task 4: Business profile, bank details and document numbering

**Files:**
- Test: `Backend/test/baseline/business-profile.test.mjs`, `Backend/test/baseline/document-numbering.test.mjs`

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
- Test: `Backend/test/baseline/xero-connection.test.mjs`

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
git add Backend/test/baseline/xero-connection.test.mjs
git commit -m "test: baseline Xero connection auth and the quote-push contract"
```

---

### Task 6: Role gate and workspace CRUD

**Files:**
- Modify: `Backend/test/baseline/role-gate.test.mjs`
- Test: `Backend/test/baseline/workspace.test.mjs`

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

- [ ] **Step 2: Baseline workspace create/list**

Assert `GET /api/workspaces` and `POST /api/workspaces` (`workspace.js:145,227`) behave as they do now, and that a created workspace has **no** automation flag — the assertion Task 8 will deliberately update.

- [ ] **Step 3: Run, then commit**

```bash
git add Backend/test/baseline
git commit -m "test: baseline the owner/support role gate and workspace CRUD"
```

---

### Task 7: Audit trail and the job queue

**Files:**
- Test: `Backend/test/baseline/audit-trail.test.mjs`, `Backend/test/baseline/queue.test.mjs`

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

Guard the file with a skip when `REDIS_HOST` is unset, so the suite stays runnable without Redis:

```javascript
import { test } from 'node:test'
const noRedis = !process.env.REDIS_HOST
test('…', { skip: noRedis && 'REDIS_HOST not set' }, async () => { /* … */ })
```

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

### Task 8: Epic 2 — workspace feature toggle (Track A, unblocks everything)

**Files:** Modify `Backend/src/models/Workspace.js`, `Backend/src/routes/workspace.js`; Test `Backend/test/epics/feature-toggle.test.mjs`

**Interfaces produced:** `Workspace.invoiceStatementAutomationEnabled: Boolean` (default `false`); `PATCH /api/workspaces/:workspaceId/features` accepting `{ invoiceStatementAutomationEnabled: boolean }`, gated by `requirePortalOwnerOrSupport`; `GET /api/workspaces` includes the flag.

- [ ] Write failing tests: default is `false` for a newly created workspace (2.2); `isoplus_user` gets 403 from the PATCH (2.1); `owner` and `support_admin` both succeed; the flag persists and appears in `GET /api/workspaces` (2.3).
- [ ] Add the field to the schema. Mongo is schema-less but Mongoose will silently drop an undeclared field — declare it.
- [ ] Add the route using the **existing** `requirePortalOwnerOrSupport`, per R1.
- [ ] Update the Task 6 baseline assertion that said the flag does not exist, in the same commit, with the reason in the message.
- [ ] Update System Owner / Support Admin documentation (2.4).

**Covers:** 2.1, 2.2, 2.3, 2.4. **Also satisfies** the doc-5 note that this same toggle hides the tab for NDIS/SaH/IMS workspaces — no separate toggle.

---

### Task 9: Epic 1 — navigation and entry point (Track A)

**Files:** Modify `Frontend/app/workspace/[id]/page.tsx:266`; Create `Frontend/app/workspace/[id]/finance-settings/page.tsx`

- [ ] Rename the tile "Xero Integration" → "Finance Settings & Automation", title and subtitle only (1.1). Per R2 this is the **workspace** page, not the dashboard homepage — confirm the intended surface before editing.
- [ ] Build the page shell: header, breadcrumb, **full-width** content area, not the centre column (1.2, explicit feedback in the spec).
- [ ] Build the three-tab nav: Financial Settings / Accounting Integrations / Invoice & Statement Automation (1.3).
- [ ] Render tab 3 only when `invoiceStatementAutomationEnabled` is true for the workspace (1.4 — needs Task 8).
- [ ] Test: tab 3 absent when the flag is false, present when true.

**Covers:** 1.1, 1.2, 1.3, 1.4.

---

### Task 10: Epic 3 — Financial Settings tab (Track A)

**Files:** Modify `Backend/src/models/Business.js:96`; Create `Frontend/components/finance-settings/financial-settings-tab.tsx`; Modify `Frontend/app/workspace/[id]/configure-business/page.tsx`

**Interfaces produced:** `Business.documentNumbering.statement: { prefix: String (default 'ST-'), nextNumber: Number (default 1000) }` — same shape as the other three, per R4.

- [ ] Move Bank Details (`configure-business/page.tsx:907`) and Document Number Configuration (`:976`) out of the Additional Settings tab into the new tab, **no behaviour change** (3.1, 3.2).
- [ ] Add Statement Numbers — real, required, feeds Task 13 (3.3).
- [ ] Add Credit Note Numbers **disabled/greyed**, not hidden (3.4).
- [ ] Data migration (3.5): per R3 the values already live in `Business.documentNumbering`, so this is a UI relocation. Confirm no client has values stored anywhere else before declaring the migration a no-op — and if it is a no-op, say so in the PR rather than shipping an empty migration.
- [ ] Regression (3.6): the Task 4 baseline tests must still pass **unchanged** except for the deliberate `statement` assertion update. That is the whole reason Phase 1 exists.

**Covers:** 3.1–3.6.

---

### Task 11: Epic 4 — Accounting Integrations tab (Track A)

**Files:** Create `Frontend/components/finance-settings/accounting-integrations-tab.tsx`; Modify `Backend/src/models/Business.js`

**Interfaces produced:** `Business.accountingMapping: { quote: {accountCode, taxRate}, purchaseOrder: {...}, invoice: {...}, quoteLineItemOverrides: [{ lineItemType, accountCode, taxRate }] }`

- [ ] Tab shell with Xero / MYOB / QuickBooks sub-tabs, full page width (4.1).
- [ ] Relocate Connect Xero / Test Connection with **no behaviour change** — Task 5's baseline is the proof (4.2).
- [ ] Invoice/Customer/Payment/Contact Sync toggles, disabled/greyed (4.3).
- [ ] MYOB and QuickBooks sub-tabs inactive (4.4).
- [ ] Default Account + Tax Rate per document type, plus the Quote line-item override table (4.5). Tax-rate dropdowns are constrained: GST on Income / GST Free Income for Quote and Invoice; GST on Expenses / GST Free Expenses for Purchase Order.

**Open question from the spec (doc 4, verbatim):** the line-item override table is Quote-only "for now" — confirm whether Purchase Order and Invoice need the same before building 4.5.

**Covers:** 4.1–4.5.

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

**Files:** Modify `Backend/src/services/sync/queue.js`, `Backend/src/routes/internal.js`

> **Blocked on R8.** The spec is one sentence: "Currently we have manual sync which is triggered by users in Invoice and Statement pages. We need to create a schedule to sync automatically in the background." There is no cadence, no per-workspace vs global decision, no behaviour on failure, no interaction with the existing `syncStatus` state machine in `models/Board.js` (which already has `manual_triggered_sync` and `realtime_sync` states). **Write a short design before this task is planned.**

- [ ] Resolve: cadence and whether it is per-board or per-workspace.
- [ ] Resolve: how it interacts with `realtime_sync`, which already listens to webhooks — a scheduled sync may be redundant for boards already in that state.
- [ ] Then: reuse the Task 13 tick rather than adding a second scheduler.

**Covers:** 7.1, once specified.

---

## Out of scope this round

Carried from doc 6, not planned here: Contact/Invoice/Customer/Payment Sync working logic; the Credit Note feature; the struck-through mockup fields (Invoice scope, Eligible billing items, Statement type, Statement period, Transaction types); alerting infrastructure.

---

## Self-review

**Spec coverage.** Every numbered task in doc 6 maps to a task above: E1→9, E2→8, E3→10, E4→11, E5→12/13/14, E6→15/16, E7→17. Docs 1–5 are absorbed into those tasks; doc 2's five new AWS resources appear in Tasks 13 and 14; doc 1's global overview and drill-down in Task 16; doc 3's three numbering decisions in Task 10; doc 4's mapping fields in Task 11; doc 5's field table in Task 12.

**Gaps I am flagging rather than papering over:**
- Epic 7 has no acceptance criteria (R8) — Task 17 is blocked by design, not by effort.
- The Quote-only line-item override (doc 4) is an open question the spec itself raises.
- Phase 2 tasks are specified to interface level, not line level — stated in the depth note above, deliberately.

**Type consistency.** `createApp()`, `startTestServer()`, `loginAs()`, `authedFetch()`, `connectTestDb()`, `resetTestDb()`, `seedBusiness()` and `computeNextRun()` are used with the same names and signatures wherever they appear. `Business.documentNumbering.statement` (Task 10) and `Workspace.invoiceStatementAutomationEnabled` (Task 8) are referenced consistently by later tasks.

**Ordering.** Task 1 blocks all tests. Task 8 blocks Task 9.4. Task 12 blocks 13, which blocks 14. Task 14's SES production access has external lead time and should be requested during Phase 0.
