---
name: testing-kan10-end-to-end
description: >-
  Use when testing, demoing or debugging KAN-10 invoice/statement automation
  end to end on the local stack — configuring the Finance Settings automation
  tab, forcing a scheduler tick, checking a ScheduledJob is claimed and
  advanced, confirming per-board fan-out and idempotent jobIds in Bull Board,
  or when asked whether an automation run reached PDF, email or Xero. Also use
  when driving board `eNiJpH14PN3` / workspace `55369` (Care Management NDIS
  2026 Pricing) locally, or replaying its ISO+ webhook bodies.
---

# Testing KAN-10 end to end

## The boundary — read this before promising anyone a result

**KAN-10's scheduled pipeline sends nothing, to anyone, in any mode — and it
never touches Xero.** SES delivery is Epic 5 part 4; only its first slice
exists: offline, the worker composes the email its settings block describes and
writes it to the **outbox**, a file a person can open and verify:

```
Backend/.local-s3/outbox/<workspaceId>/<kind>-<boardId>-<periodKey>.json
```

One file per claimed slot, named like the queue jobId, so an at-least-once
redelivery overwrites its own preview rather than duplicating it. Online there
is still no transport — the worker completes with a warn, and calling the
outbox directly online throws rather than silently dropping mail.

So "did it reach Xero?" is the wrong success criterion for KAN-10. **The
terminal observable offline is the outbox file (plus the completed queue job);
online it is a warn that delivery is unimplemented.** A run that ends there is
a *passing* run. Xero sync is a different, webhook-driven system — see the
`xero-sync-local` skill.

Xero *is* reachable in this repo — by a different, older system (Track B). Do
not let the two blur together, and do not report a Track B success as evidence
KAN-10 works.

| | Track A — KAN-10 | Track B — board automations |
|---|---|---|
| Trigger | `POST /api/scheduler/tick` (EventBridge in prod, `npm run tick` locally) | ISO+ `ButtonTrigger`/`ValueChange` node → `TriggerWebhook` |
| Config lives in | Finance Settings → Automation tab | the ISO+ board itself |
| Ends at | stub worker log line | `/api/pdf`, `/api/xero`, `/api/care-management-ndis-pricing` |
| Reaches Xero | **no, by design** | yes (2 ButtonTrigger automations) |
| Needs ngrok | **no** | yes, for a live board |

## Preconditions

Every one of these bit on a real run. Work through them in order.

```bash
docker info >/dev/null 2>&1 || open -a "Docker Desktop"     # then wait for the daemon
npm run dev:up                                              # health-gated
curl -sS localhost:4001/api/healthcheck                     # {"status":"OK"}
grep -q '^SCHEDULER_API_KEY=.\+' Backend/.env && echo "tick key set"
npm run dev:user -- --create --email dev@local.test         # NOT the bare form — see below
```

- **Expect the backend to crash-loop on the first `dev:up` of this branch.** The
  error reads like an ESM/CommonJS bug — `Named export 'CronExpressionParser' not
  found` — and is not one: it is a stale image with `cron-parser@4.9.0` hoisted.
  `npm run dev:build` fixes it. Confirm the output contains `==> discarding this
  project's node_modules/.next volumes`; without that line the rebuild did not take.
  Full explanation in `docs/scheduling.md`, "Trap: adding cron-parser needs a
  container rebuild".
- **`SCHEDULER_API_KEY` in `Backend/.env` is required for Track A.** `npm run tick`
  reads it from there and `POST /api/scheduler/tick` is guarded by
  `validateSchedulerApiKey`. Without it every tick is a 401 and nothing claims.
  Any non-empty string works locally. After adding it:
  `docker compose up -d --force-recreate --no-deps backend`. Sanity check —
  a tick with nothing due prints `claimed=0 dispatched=0 failed=0`, *not* an error.
- **`npm run dev:user` bare does not work here, twice over.** It refuses when more
  than one `support_admin` exists (`--email` required), and its default account
  `dev@local` **cannot log in at all**: `routes/auth.js` validates
  `body('email').isEmail()`, which requires a TLD, so `dev@local` is rejected 400
  before any password check. Use a TLD-bearing address —
  `npm run dev:user -- --create --email dev@local.test`. Creating a new account
  avoids resetting a real teammate's password on a seeded database.
- **Mongo and Redis are in the *infra* Compose project, not this one.**
  `docker compose exec mongo …` fails with *"service mongo is not running"*. Use
  `docker exec -i isoplus-mongo mongosh business-dashboard --quiet --eval '…'` and
  `docker exec -i isoplus-redis redis-cli …`.

- **Log in via credentials, never the ISO+ button.** Click *administrator
  credentials* at the bottom of the login screen (it reads **Support agent
  sign-in**) and use the account from `dev:user`, password `local-dev-only`. The
  OAuth path cannot complete locally.
- **Offline mode is expected.** With `PERSONAL_ACCESS_TOKEN` blank the backend is
  in offline mode. Track A is unaffected — the handler reads boards from Mongo,
  not from ISO+. `board_sync` schedules deliberately skip; that is a success, not
  a failure.

## Track A — the KAN-10 chain

### 1. Load the board from the URL

```bash
npm run dev:fixture              # additive; --remove deletes only these ids
npm run dev:fixture -- --list
```

This is workspace `55369` / board `eNiJpH14PN3` / Quotes folder `BFMUenisoQ4` —
the same board as
`app.isoplus.online/b/eNiJpH14PN3/…`, invented data, no live calls. Prefer it to
`npm run seed`, which is destructive and clears the dev password.

**Fan-out counts boards, so at least one `Board` row must carry
`workspaceId: "55369"`.** Zero boards is a *successful* no-op that enqueues
nothing — the most common reason this test looks broken when it isn't.

### 2. Turn the tab on

The Automation tab is gated on `Business.featureToggles.invoiceStatementAutomation`.
Off by default, and `?tab=automation` silently resolves back to `financial` when
off — which reads exactly like a broken build.

**Log in first, and check you are logged in.** `fetchInvoiceStatementAutomationFlag`
catches its own failure and returns `false`, so an unauthenticated session is
*indistinguishable* from the flag being off: same missing tab, same bounce to
`financial`. The tell is a toast reading "Failed to load financial settings —
Authentication required", and `Token verification failed: … 400` in the console.

Flip the flag directly — fewer moving parts than the session-gated route:

```bash
docker exec -i isoplus-mongo mongosh business-dashboard --quiet --eval '
  db.businesses.updateOne({workspaceId:"55369"},
    {$set:{"featureToggles.invoiceStatementAutomation": true}})'
```

Then load `/workspace/55369/finance-settings?tab=automation`. The tab reads
**Invoice & Statement Automation**.

### 3. Configure and save

Toggle **Enable automatic generation** in the Invoice block first — the email
fields and Start Date only render once it is on. The defaults (every 1 Month,
Run On 1, Run At 09:00) are fine; you force the fire in step 5 rather than
waiting, so a near-future `runAt` buys nothing.

Put a valid address in Reply-to, then **Save Changes** (one button, bottom of the
tab, saves both blocks).

Type `billing@iso-plus..com.au` into Reply-to first. It must flag inline with
*"Enter a valid email address."* and mark the field `aria-invalid`. The
double-dot domain is precisely what the pre-fix pattern accepted, so this is the
regression check for `EMAIL_PATTERN` in `constants/validation` — shared with the
business profile, and the reason both agree.

`Next Run` renders `—` / *"Calculated by the scheduler — read-only"* until a
schedule exists. It is never stored on `AutomationSettings`; it is read from the
linked `ScheduledJob.nextRunAt`.

### 4. Verify the two writes

Settings, and the schedule row it created — **the schedule is written first**, so
if only one exists it should be the schedule:

```bash
curl -sS localhost:4001/api/workspaces/55369/automation-settings -b cookies.txt
```

```bash
docker exec -i isoplus-mongo mongosh business-dashboard --quiet --eval '
  db.scheduledjobs.find({targetId:"55369"},
    {kind:1,enabled:1,cron:1,"schedule.every":1,nextRunAt:1,timezone:1,_id:0}).forEach(printjson)'
```

Observed, with the defaults (every 1 month, Run On 1, 09:00):

```js
{ kind: 'invoice_automation', cron: null, enabled: true,
  nextRunAt: ISODate('2026-08-31T23:00:00.000Z'),
  schedule: { every: { n: 1, unit: 'month' }, runOn: 1, runAt: '09:00' },
  timezone: 'Australia/Sydney' }
```

Assert **`cron: null` with `schedule` populated** — that is the XOR; both set, or
neither, is a schema violation that must never have stored. `nextRunAt` is stored
UTC: `2026-08-31T23:00` is 1 Sept 09:00 Sydney, i.e. the configured 1st-of-month.

**Exactly one row.** A disabled Statement block writes no schedule at all, so two
rows here means the disable path is broken.

### 5. Force it due

The tick claims `{enabled, nextRunAt <= now}`. Rather than waiting:

```bash
docker exec -i isoplus-mongo mongosh business-dashboard --quiet --eval '
  db.scheduledjobs.updateOne({targetId:"55369",kind:"invoice_automation"},
    {$set:{nextRunAt:new Date(Date.now()-60000)}})'
```

### 6. Tick — the step being validated

```bash
npm run tick -- --once
# [2026-08-14T05:10:32.642Z] claimed=1 dispatched=1 failed=0 (61ms)
```

`claimed=0` means the row was not due, not enabled, or the key is wrong. A 401
prints as a failed tick with a reason — read it rather than re-running.

### 7. Verify the claim advanced

```bash
docker exec -i isoplus-mongo mongosh business-dashboard --quiet --eval '
  const j = db.scheduledjobs.findOne({targetId:"55369",kind:"invoice_automation"});
  print(j.nextRunAt.toISOString(), j.lastRunAt.toISOString(), j.consecutiveFailures, j.missedRuns)'
# 2026-08-31T23:00:00.000Z 2026-08-14T05:10:32.681Z 0 0
```

`nextRunAt` returns to **1 Sept 09:00 Sydney** — the next slot on the anchored
series, *not* "claimed slot + 1 month" (which would be 14 Sept). Getting that
wrong is how a billing date drifts a fortnight over a year. `lastRunAt` is the
tick instant, `consecutiveFailures: 0`. Under `AT_LEAST_ONCE` the advance happens
only after dispatch resolves, so an advance *is* the evidence dispatch succeeded.

### 8. Verify fan-out and the idempotency key

Bull Board is at **http://localhost:4001/api/queues**, but Redis answers faster
and scriptably:

```bash
docker exec -i isoplus-redis redis-cli --scan --pattern 'bull:automation:inv:*'
# bull:automation:inv:eNiJpH14PN3:20260814-1509
```

One job per board, keyed `inv:<boardId>:<periodKey>` (`stmt:` for statements).
`20260814-1509` is the **claimed slot** rendered in the schedule's timezone —
05:09 UTC is 15:09 Sydney — not the tick instant. That is the whole safety
mechanism: a retry recomputes the same key and collapses into the job already
queued instead of billing every board twice.

### 9. The double-fire assertion

The assertion the design exists to satisfy. Test both halves — they fail
differently:

```bash
jobs() { docker exec -i isoplus-redis redis-cli --scan --pattern 'bull:automation:inv:*' | wc -l; }

# (a) two ticks at once
( npm run tick -- --once & npm run tick -- --once & wait )
jobs()   # still 1

# (b) the same claimed slot replayed — the retry-after-crash case
docker exec -i isoplus-mongo mongosh business-dashboard --quiet --eval '
  db.scheduledjobs.updateOne({targetId:"55369",kind:"invoice_automation"},
    {$set:{nextRunAt:new Date("<the same slot>")}})'
npm run tick -- --once
jobs()   # still 1, same jobId
```

Both hold. Note (a) can print `claimed=1` from *both* ticks — the count that
matters is the job count, not the claim count. Two jobs for one board would be a
duplicate-billing defect.

### 9b. The quiet window — nothing fires between slots

The inverse assertion, and the one that catches a scheduler that over-fires:
after a slot is claimed, every tick until the next computed `nextRunAt` must
claim **nothing**, and the next slot must mint a **new** periodKey.

```bash
npm run tick -- --once   # x3, all while nextRunAt is in the future
# claimed=0 dispatched=0 failed=0     <- every time; the schedule is not due
```

Then simulate the next slot arriving (backdate again) and tick once:

```
bull:automation:inv:eNiJpH14PN3:20260814-1646   <- new slot, new key
bull:automation:inv:eNiJpH14PN3:20260814-1509   <- previous slot, still held
```

Two distinct jobIds is correct: the dedupe window is the billing period, not
the queue's lifetime. One id repeated would mean the periodKey failed to move
with the slot; a fire while `claimed=0` was expected would mean the claim
query's `nextRunAt <= now` guard is broken.

### 10. Confirm the terminal state, and stop

```bash
find Backend/.local-s3/outbox -type f          # one file per claimed slot
cat Backend/.local-s3/outbox/55369/invoice_automation-*.json
```

Observed shape — subject/body/replyTo from the settings block, the slot's
periodKey, and an explicit nothing-was-sent note:

```json
{ "kind": "invoice_automation", "periodKey": "20260814-1652",
  "recipientType": "billing_contact", "replyTo": "billing@iso-plus.com.au",
  "subject": "Your ISO+ invoice run",
  "note": "Offline outbox preview — nothing was sent. SES delivery is Epic 5 part 4." }
```

Invoice slots carry **Invoice Generator** attachments: one NDIS (or Age Care)
invoice PDF per participant, using the same pipeline as the Invoice Generator
page, for rows whose **Service Delivery Date** falls in the **completed
schedule period** ending at the claimed slot (`ScheduledJob.schedule.every`
in the job timezone). Rows become **invoiced** (`InvoiceNumber` type PDF).
Quote-shaped items without an approved timesheet are **not** billed.
Idempotent per slot: redelivery reuses URLs and consumes no second invoice
number.

Statement slots carry **Monthly Statement** PDFs — one per participant for the
**previous complete calendar month** of the claimed slot — on Care Management
boards that are not Low Cat. NDIS-only boards no-op statements.

Confirm Invoice Generator shows those rows as invoiced, not merely that an
`auto/` quote-line PDF exists.

**That file is the end of KAN-10 offline.** It is also served at
`/api/local-files/outbox/…`. Jobs land in `completed`, not `waiting` — the
worker completes them so BullMQ does not retry against a transport that does
not exist. An empty outbox with completed jobs means the settings block is
disabled, or the backend is not in offline mode.

### Track A quick reference

| Symptom | Cause |
|---|---|
| `claimed=0` forever | not due, disabled, or `SCHEDULER_API_KEY` mismatch (401) |
| Tab missing / `?tab=automation` bounces | `invoiceStatementAutomation` toggle off |
| Tick succeeds, queue empty | no `Board` rows for the workspace — success, not failure |
| Schedule fires, warn "no enabled settings" | settings deleted/disabled; a no-op by design, never throws |
| Two jobs per board | real defect — the periodKey is being derived from `now` |
| Jobs pile up `waiting` | automation worker not started |

## Track B — the path that does reach Xero

Not KAN-10. Pre-existing board automations, on the same board.

**Everything on this path answers HTTP 200, errors included**, so ISO+ records a
successful delivery either way. Never judge a Track B run by the status code —
read the body and the backend log.

### The offline providers, and how far they reach

The inbound PDF path used to be unusable offline — every real webhook was
refused as an intrusion attempt. Three layers of offline stand-ins fixed that,
each gated on `isOfflineMode()` (hard false in production; see
`services/offlineIsoplus.js`):

| Live call | Offline stand-in | Backed by |
|---|---|---|
| `getItemValues` (tenancy guard) | `getItemValuesOffline` | Mongo `Item.data`, projected to `values[].attribute.name` |
| `getReferences` / `getAttribute` | fixture `references` + `attributes` | `ndis-quote-board.json` |
| `uploadFileToS3` / `getS3FileUrl` / `getS3File` | `utils/localFileStore.js` → `Backend/.local-s3/` | served by `GET /api/local-files` (404s entirely outside offline mode) |
| `setIntegrationMessage` / `setPDFLinkAttribute` / `setGeneratedField` | skip + warn | the local items do not exist on live ISO+, so the PUTs could only 404 — and two of them rethrow |

With those in place a `quotendis` fire completes the epic's actual purpose
offline: **a real PDF, generated locally, at a URL that downloads** — through
the ngrok tunnel if `BACKEND_URL` points at it, which is what makes the link
work from a live board. Side effects to verify: a `PDFLink` row in Mongo, and
`Business.documentNumbering.quote.nextNumber` incremented.

```
{"pdfUrl":"https://<tunnel>/api/local-files/output/55369/eNiJpH14PN3/NDIS-quote/QT-1090-…pdf"}
```

Two rules this taught, the hard way:

- **`isOfflineMode()` is implicitly true in every test run** (blank token outside
  production), so `test/setup.js` pins `ISOPLUS_OFFLINE=0` — without it, 34 tests
  that mock ISO+ HTTP silently asserted against Mongo. Any new offline branch in
  `services/isoplus.js` needs the same care, and `test/unit/app.test.js` keeps a
  documented mount list that a new route must be added to.
- **Tests must not share the real store**: point `LOCAL_FILE_ROOT` at a temp dir,
  or a route test's cleanup deletes the PDFs you just generated (it did).

```bash
npm run dev:fixture -- --replay quotendis --dry-run   # print the body
npm run dev:fixture -- --replay quotendis             # POST to localhost:4001
```

Delivery through the tunnel is provable without touching the live board — POST
the recorded body at the public URL and watch it reach the route:

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  -H 'ngrok-skip-browser-warning: 1' -d '<recorded body>' \
  https://saleably-obconical-percy.ngrok-free.dev/api/pdf/55369/eNiJpH14PN3/quotendis
```

That proves the tunnel and the mount's lack of auth. It does not prove the
handler works — the tenancy guard above is what gates that.

### Firing the live board without touching anything existing

Verified working. **Add** a new automation; never repoint one of the 26 existing
`Portal - ` ones.

1. `activate-ngrok` (port **4001**), then set `BACKEND_URL` and recreate backend.
2. Board → **Automations** → *Manage*. Note the count first — it read
   `34 Active automations (showing 41/41)`; afterwards it must be exactly +1.
3. **Create an Automation**. Name it obviously disposable
   (`ZZ TEMP - … safe to delete`).
4. Trigger: **Button**. It fires only on an explicit click, so nothing can go off
   on its own while you work.
5. Action: **Trigger a webhook** → the full tunnel URL, e.g.
   `https://saleably-obconical-percy.ngrok-free.dev/api/pdf/55369/eNiJpH14PN3/quotendis`
6. **Save an Automation**.
7. Reopen it and press **Test Trigger**. This opens a *Test Automation* modal —
   pick a **Folder** (Quotes) and a real **Item**, then *Save & Trigger the
   Automation*. **`Test Trigger` alone sends nothing**; without choosing an item
   no request leaves ISO+, which looks like a broken tunnel and is not one.
   This path also means you do **not** need to add a Button attribute to an item.

Watch it arrive on `http://127.0.0.1:4040` (ngrok inspector) — quote the query
string, `zsh` globs a bare `?limit=`:

```bash
curl -sS 'http://127.0.0.1:4040/api/requests/http?limit=5'
```

The real one is identifiable by `User-Agent: Infinity/43.2.2` — anything reading
`curl/…` is your own replay. A real captured body:

```json
{"items":[{"id":"cfd84160-…","object":"item:friendly","values":{
  "Source of Lead":["Partnership","Social Media"],
  "Recipient of the Quote":"Fixture Test Recipient",
  "OLD Direct Support Item Number":[] }}]}
```

Note `values` keyed by **attribute name**, and `OLD Direct Support Item Number`
present in live traffic — the rename that repoints pricing dispatch, visible in
the payload itself.

**Clean up when done**: delete the temp automation and confirm the count returns
to its original. Leaving an active automation pointed at a dead tunnel is a
booby-trap for the next person.

- **Port 4001, not 80.** Webhooks hit the *backend*; `BACKEND_PORT` defaults to
  4001. `ngrok http --url=saleably-obconical-percy.ngrok-free.dev 4001`.
  Port 80 serves nothing on this stack.
- **`PUT /api/automation/:ws/:board` rewrites `Portal - ` URLs to `BACKEND_URL`
  and that mutates the live board.** Capture the current URLs first and restore
  them when done. 26 of the board's 41 automations point at
  `portal-backend.isoplus.online`.
- The Xero leg needs `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` in `Backend/.env`
  plus a completed OAuth callback. Blank credentials mean the `/api/xero`
  automations cannot succeed regardless of tunnelling.
- The board's Xero automations are `ButtonTrigger` — a person clicks a button on
  an item. They do not fire from a field edit.

**Known live defect on this board:** 4 automations (`?type=direct_support`,
`?type=centre_capital_cost`) return `{"error":"Invalid type"}` **at HTTP 200**,
because the 2026 pricing migration renamed `Direct Support Item Number` to
`OLD …` and the board now resolves to the *new* pricing path. ISO+ records a
successful delivery either way. Do not spend an afternoon on it — see
`docs/ongoing/webhooks-and-automation.md`.

## Common mistakes

- **Reporting "KAN-10 works end to end, invoice in Xero."** Impossible. Either
  Track B did it, or nothing did.
- **Deriving `periodKey` from `now`** when writing a new handler — duplicate-bills
  every board on retry.
- **Waiting for the schedule instead of backdating `nextRunAt`.**
- **Running `npm run seed` mid-test** — destructive, and it clears the dev
  password; re-run `npm run dev:user`.
- **Adding an in-process timer** to "make it fire". Elastic Beanstalk runs more
  than one instance; a timer double-bills. The tick is external on purpose.
- **Leaving the live board pointed at the tunnel** after the session.

## Related

- `docs/scheduling.md` — the endpoint, the two delivery policies, what to alert on
- `docs/superpowers/specs/2026-08-12-invoice-statement-automation-design.md` — why the queue is where it stops
- `docs/ongoing/webhooks-and-automation.md` — the 41-automation inventory
- `Backend/test/fixtures/README.md` — what the fixture reproduces and why
- `activate-ngrok` skill — tunnel setup and teardown
