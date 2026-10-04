---
name: testing-kan10-end-to-end
description: >-
  Use when testing, demoing or debugging KAN-10 invoice/statement automation
  end to end on the local stack — configuring the Finance Settings automation
  tab, forcing a scheduler tick, checking a ScheduledJob is claimed and
  advanced, confirming per-board fan-out and idempotent jobIds in Bull Board,
  or when asked whether an automation run reached PDF, email or Xero. Also use
  when asked to prove the generated invoices or statements are populated rather
  than blank, to check an email is not carrying another board's documents, or
  to export a run's PDFs and composed emails somewhere reviewable. Also use
  when sending a run for real through SES, or when asked why an automation
  email bounced, shows no delivery state, or never left the outbox. Also use
  when driving board `eNiJpH14PN3` / workspace `55369` (Care Management NDIS
  2026 Pricing) locally, or replaying its ISO+ webhook bodies.
---

# Testing KAN-10 end to end

## The boundary — read this before promising anyone a result

**Where a KAN-10 run ends depends on the environment, not on the code path.**
The worker never branches on how mail leaves the building: `selectBackendName`
resolves a delivery backend *by name*, and the run ends wherever that backend
takes it. Work out which row you are in first; the rows fail differently.

| Environment | Backend | Terminal observable |
|---|---|---|
| Offline (`ISOPLUS_OFFLINE=1`, or a blank `PERSONAL_ACCESS_TOKEN` outside production) | `local-outbox` | an outbox JSON file per composed message, plus the completed queue job |
| Online, `EMAIL_FROM` + the AWS variables set | `ses` | a real send — `SES-Transport: Email sent`, a row in `emailsends`, then a `Delivery`/`Bounce` row in `emailevents` |
| Online, no transport configured | none — resolves to `null` | **nothing generated.** The worker refuses *before* claiming invoice numbers |

Offline, the composed email is a file a person can open and verify:

```
Backend/.local-s3/outbox/<workspaceId>/<kind>-<boardId>-<periodKey>-<participant>.json
```

One file per **composed message**, and a message is composed **per
participant** — for every recipient type, `billing_contact` included. The
recipient type chooses which address on that participant's profile receives
their documents (Billing Email, or their own Email when no Billing Contact is
named); it does not mean one shared message for the board, and there is no
board-level billing contact to send one to. A board with nothing to bill
therefore writes no file at all rather than an email carrying no documents.

The name is the queue jobId plus the participant slug, so an at-least-once
redelivery overwrites its own preview rather than duplicating it. **A run that
ends at those files is a *passing* run** — offline there is nothing further to
wait for, and no amount of re-ticking will produce a send.

**KAN-10 does now reach Xero, on exactly one route:** an invoice block whose
`sendMethod` is `accounting` generates its invoices and creates them as Xero
DRAFTs *instead of* emailing them. Both generator branches are wired — NDIS
through `handleXeroInvoicendisInvoiceGenerator`, Age Care through
`handleXeroInvoiceParticipantTax` — which are the same handlers the Invoice
Generator page's own buttons call, so a scheduled draft carries the same
contact, lines and account/tax mapping as one pushed by hand. Statements always
email — Xero has no statement object here — and a statement block carrying
`accounting` says so once in the log rather than silently ignoring the setting.
Xero-not-connected is settled before generation, so that misconfiguration logs
an error and produces nothing, rather than burning invoice numbers on drafts it
cannot create; so is a board neither generator serves.

Every *other* way Xero is reachable in this repo is Track B — a different,
older, webhook-driven system (and the `xero-sync-local` skill). Do not report a
Track B success as evidence KAN-10 works.

| | Track A — KAN-10 | Track B — board automations |
|---|---|---|
| Trigger | `POST /api/scheduler/tick` (EventBridge in prod, `npm run tick` locally) | ISO+ `ButtonTrigger`/`ValueChange` node → `TriggerWebhook` |
| Config lives in | Finance Settings → Automation tab | the ISO+ board itself |
| Ends at | offline: generated PDFs + an outbox file per claimed slot. Online: a real SES send, or Xero DRAFTs on the `accounting` route | `/api/pdf`, `/api/xero`, `/api/care-management-ndis-pricing` |
| Reaches Xero | only via `sendMethod: 'accounting'` — invoices, as DRAFTs | yes (2 ButtonTrigger automations) |
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

- **Password login no longer exists.** KAN-27 replaced it: `POST /api/auth/login`
  now answers **404** with *"Support admin password login is no longer
  available. Use Google sign-in."* `npm run dev:user` still writes the row and
  still prints `local-dev-only`, but nothing will accept that password. The
  local way in is the one-time OAuth ticket the e2e helper uses —
  `node Backend/scripts/e2e-support-ticket.mjs`, then load
  `http://localhost:3100/?ticket=<ticket>`. **The exchange answers 503 while
  `PERSONAL_ACCESS_TOKEN` is blank** — `applyPrivilegedSessionAuth` refuses to
  issue a support_admin session without one, and `GET /api/auth/verify` still
  answering 200 is what makes it look like the session exists. The local fix
  is a placeholder token with offline mode pinned on, so nothing tries to use
  it against ISO+:

  ```
  PERSONAL_ACCESS_TOKEN=local-offline-placeholder
  ISOPLUS_OFFLINE=1
  ```

  then `docker compose up -d --force-recreate --no-deps backend`. With that the
  exchange answers 200 and the e2e helper signs in.
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

**Prefer the multi-board fixture for generator testing.** Workspace `55390`
(`Backend/test/fixtures/care-management-automation.json`, captured from
portal-dev's "ISO+™ NDIS & SaH Demo") seeds three Care Management boards that
exercise all three generator branches at once — `jpjztrn14pJ` (SaH → Age Care
invoice), `o24sGM1FoST` (NDIS legacy pricing), `dwV23F5WcQL` (NDIS 2026
pricing) — plus `automationSettings` (both blocks enabled) and two already-due
`scheduledJobs` rows (slot 2025-02-01 09:00 Sydney, periodKey `20250201-0900`,
billing January 2025). After loading it, steps 2–5 below are unnecessary — one
`npm run tick -- --once` claims both kinds, generates 5 invoices + 6 statements,
and writes 6 outbox files. Reloading the fixture resets `nextRunAt`, so tick
runs are repeatable:

```bash
npm run dev:fixture -- --file test/fixtures/care-management-automation.json
npm run tick -- --once     # claimed=2 dispatched=2
find Backend/.local-s3/outbox/55390 -type f    # one file per participant, all *-20250201-0900-*.json
```

**Reloading the fixture is not enough to re-run a slot.** It resets `nextRunAt`,
but the jobId dedupe lives in **Redis**, and a completed
`bull:automation:stmt:<board>:<periodKey>` swallows the replay silently — the
tick prints `claimed=2 dispatched=2` and nothing is generated. That is the
idempotency guarantee doing its job, and it looks exactly like a broken run.
Clear all three before re-running:

```bash
docker exec -i isoplus-redis redis-cli --scan --pattern 'bull:automation:*' \
  | xargs -r docker exec -i isoplus-redis redis-cli DEL
docker exec -i isoplus-mongo mongosh business-dashboard --quiet --eval '
  db.pdflinks.deleteMany({workspaceId:"55390", type:{$in:["Monthly Statement","Statement of Account"]}});
  db.scheduledjobs.updateMany({targetId:"55390"},{$set:{nextRunAt:new Date(Date.now()-60000)}})'
rm -rf Backend/.local-s3/outbox/55390
```

**Playwright, and the two things that stopped it starting.** Until 2026-09-08
`e2e/helpers/support-auth.ts` used `import.meta`, which Playwright's TS loader
rejects on **every** Node version because it transpiles e2e files to CommonJS
(*"Cannot use 'import.meta' outside a module"* → `Error: No tests found`). That
was misdiagnosed as a Node 25 problem; it reproduced on Node 22 and is fixed.
The Frontend unit suite's Node 25 failure (`window.localStorage.clear is not a
function`, ~370 tests) is real and separate — use Node 22 for that.

`e2e/board-sync-schedule.spec.ts` was truncated to 20 lines, mid-function, by
the same commit — a syntax error, so a bare `npx playwright test` aborted with
*"Unexpected token (21:0)"* before running anything. Restored; the suite now
enumerates **43 tests in 6 files**.

Playwright covers this journey in `Frontend/e2e/care-management-automation.spec.ts`.
Sign-in is the one-time Google-support ticket (see Preconditions), minted by
the helper itself; it needs `E2E_SCHEDULER_API_KEY` for the tick test and
`E2E_LOAD_FIXTURES=1` to make global-setup load the fixture. `E2E_BOARD_ID`
matters too: the board-sync spec defaults to `eNiJpH14PN3`, which has
`workspaceId: null` locally (33 of 34 boards do), and workspace 55369's only
real board is `g9n7vgdrXJX`.

```bash
cd Frontend
E2E_BACKEND_URL=http://localhost:4001 PLAYWRIGHT_BASE_URL=http://localhost:3100 \
E2E_MONGO_DB=business-dashboard E2E_LOAD_FIXTURES=1 \
E2E_WORKSPACE_ID=55369 E2E_BOARD_ID=g9n7vgdrXJX \
E2E_SCHEDULER_API_KEY=$(grep '^SCHEDULER_API_KEY=' ../Backend/.env | cut -d= -f2-) \
npx playwright test
```

2026-09-08, main clone, Node 22: **39 passed, 3 skipped, 2 failed**. The three
skips want `E2E_USER_*` (the non-admin role gate) and `E2E_WORKSPACE_ID_NO_FLAG`.

**The two failures are one pre-existing defect, and it is not a flake.**
`auth-boundary.spec.ts:43` pins "a signed-out visitor stays on /dashboard" and
`smoke.spec.ts:10` pins "/access-denied is reachable". The app now redirects an
unauthenticated visitor to `/` in both cases. Each fails **6 of 6** and **3 of 4**
runs in isolation and passes only when the machine is loaded enough that
`waitForLoadState('networkidle')` resolves before the client-side redirect lands
— which is why a busy full-suite run can show them green and a quiet single run
cannot. Both spec files are byte-identical to `develop`.

Deliberately not corrected here. These pin auth and routing behaviour that
KAN-27 changed on purpose, and rewriting a security-boundary assertion to match
whatever the code now does is how a real regression gets waved through. Whoever
owns that change should say whether the redirect is the intended behaviour, and
then the assertions follow.

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
find Backend/.local-s3/outbox -type f          # one file per composed message
cat Backend/.local-s3/outbox/55369/invoice_automation-*.json
```

Observed shape — subject/body/replyTo from the settings block, the slot's
periodKey, and an explicit nothing-was-sent note:

```json
{ "kind": "invoice_automation", "periodKey": "20260814-1652",
  "recipientType": "billing_contact", "replyTo": "billing@iso-plus.com.au",
  "subject": "Your ISO+ invoice run",
  "note": "Offline outbox preview — nothing was sent." }
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
boards that are not Low Cat. NDIS-only boards no-op statements. That budget
statement is issued **only when the statement cadence is a single calendar
month** (`every: {n: 1, unit: 'month'}`, or no schedule at all). On a weekly,
fortnightly, quarterly or multi-month cadence it is withheld, because its
template says "previous calendar month" in fixed text; the statement of account
below follows the configured period and still goes out. The run logs
`Statement period is not a calendar month; budget statement not issued` once per run
in that case.

**A statement slot now produces two documents per participant, not one.** The
budget statement above says what was *delivered*; the **Statement of Account**
(`PDFLINK_TYPE_STATEMENT_OF_ACCOUNT`, key `statements-of-account/`) says what is
*owed* — opening balance, charges, payments, closing balance, ageing. They run
alongside each other and replay on separate itemIds, and both go out in the one
email — the worker groups a run's documents by participant, so
`{{statement_number}}` renders as the two numbers comma-joined.

Its charges come from `PDFLink.invoiceTotal` on **invoice** rows for the same
participant, so **a participant with no invoices gets no statement of account**
— section 4.5, logged as `No account activity; no statement of account`. On a
fresh fixture that is every participant, because the invoice branch drops
everything at selection (`Invoice selection removed listed items from this
period`). To exercise it, seed invoice rows and a payment by hand. **Seed the
shape production writes, not one row per invoice.** `recordPdfLinks` writes one
`pdflinks` row *per item* with the whole invoice's `invoiceTotal` on every row,
so a real two-shift invoice is two rows sharing one `pdfLink` and one
`invoiceNumber`. The statement path dedupes those by `pdfLink`; a seed of one row
per invoice cannot tell whether it does, and that is exactly how a statement that
charged a multi-item invoice once per item passed every hand-seeded check on
2026-09-08. Insert two rows for at least one invoice and confirm one charge row:

```bash
docker exec -i isoplus-mongo mongosh business-dashboard --quiet --eval '
  db.pdflinks.insertOne({workspaceId:"55390", boardId:"jpjztrn14pJ", participant:"Jane Smith",
    itemId:"seed-inv-1", type:"Participant Tax Invoice", invoiceNumber:"INV-9003",
    invoiceTotal:310, periodKey:"20260801-0900", pdfLink:"https://s3.example/INV-9003.pdf",
    createdAt:new Date("2026-08-05T00:00:00Z"), isDeleted:false, SignatureStatus:"Unsigned", createdBy:""});
  db.items.updateOne({workspaceId:"55390",boardId:"jpjztrn14pJ","data.Full Name/Preferred Name":"Jane Smith"},
    {$set:{invoicedBy:"INV-9003","data.Amount Received($)":"110",
           "data.Payment Received Date":"2026-08-18T00:00:00.000Z"}})'
```

**The document fails itself rather than going out wrong**, which is the point of
sections 4.3 and 4.4 — so a defect here surfaces as a job failure, not a bad
PDF:

```
error: statement: ageing does not reconcile — buckets total 423.7,
       closing balance stated as 400.5
```

That exact line was a real bug, found this way on 2026-09-08: ageing counted
every invoice ever raised, including ones raised *after* the period, which the
closing balance could never see. Fixed by bounding both invoices and payments at
the statement date (`asAtCutoff` in `utils/statementLedger.js`).

**A blank block on the PDF is a pdfme trap, not missing data.**
`multiVariableText` refuses to draw a block if **any one** of its variables is
empty — so a participant with no address on their profile lost the entire
STATEMENT TO block, name included. `buildStatementInputs` now substitutes a
space for every empty value. If a whole block ever goes missing again, look for
an empty variable before looking at the data.

Confirm Invoice Generator shows those rows as invoiced, not merely that an
`auto/` quote-line PDF exists.

**That file is the end of KAN-10 offline.** It is also served at
`/api/local-files/outbox/…`. Jobs land in `completed`, not `waiting`. An empty
outbox with completed jobs means the settings block is disabled, the block
chose `sendMethod: 'accounting'` (invoices go to Xero and no email is composed),
or the backend is not in offline mode.

Online the same job ends at a real send instead — see **Sending for real**
below.

### 11. Check what the run actually produced

A green tick says a job was dispatched, not that anything usable came out of
it. Two failures survive `claimed=2 dispatched=2 failed=0`: a PDF that
rendered its template — every rule, heading and total line in place — with no
values on it, and an email carrying a **different board's** documents. Neither
is visible in file sizes; a blank statement still weighs ~230 kB.

```bash
cd Backend
node scripts/verify-automation-output.mjs                       # check only
node scripts/verify-automation-output.mjs --out ~/Desktop/run   # check + export
```

It reads the offline store the worker wrote to, and **exits non-zero** when a
PDF carries no embedded text, when an email attaches another board's PDFs, or
when the run produced nothing at all — that last one because "none of the zero
PDFs were blank" passes every other check trivially.

```
workspace 55390: 16 PDFs (7 invoices, 9 statements), 8 emails
PASS
```

`--workspace <id>` for anything other than 55390. `--out <dir>` also copies the
PDFs and emails there with `verification.json`, a README table of per-file text
volume, and **page 1 of every PDF as a PNG** so a blank page is visible without
opening sixteen files (that step needs macOS `sips`; elsewhere it is skipped
and said so, and the checks still run).

The text-volume measure is the load-bearing part: it counts characters inside
the PDF's text-showing operators, and it reads the **hex** strings pdfme emits
for embedded subset fonts as well as literal ones — a checker that understood
only literals would report every real invoice as blank. The pure half lives in
`Backend/scripts/verifyAutomationShape.mjs` with unit tests, including one that
pins a page of lines and boxes as zero.

What a populated run looks like, for comparison: NDIS invoices ~2.6-3.1k text
characters, Age Care ~3.6k, 14-page statements ~48k.

### 12. Sending for real

Everything above runs offline and stops at the outbox. To make the same tick
actually send, put the AWS credential, `EMAIL_FROM` and `SES_EVENTS_QUEUE_URL`
in `Backend/.env` and recreate the backend — nothing else about the pipeline
changes, because only the resolved backend changes.

**`docs/ongoing/KAN-10-email-delivery.md` is the reference** for the variables,
the rotated-key status, and the go-live checklist. Do not restate it here. Two
of its rules matter enough to repeat, because getting them wrong reaches
production:

- **Send only to the SES simulator addresses** — `success@`, `bounce@`,
  `complaint@simulator.amazonses.com`. The suppression list is account-level and
  shared with production; one careless bounce in dev can silently stop a real
  client's mail. The dev IAM key allowlists three domains and returns
  `AccessDenied` for anything else, which the SES backend records as a refusal
  (`reason: 'access_denied'`) rather than retrying — a backstop, not the plan.
- **The SQS queue is shared with the deployed dev environment.** SQS delivers
  each message to one consumer, so a local consumer steals its events. Leave
  `SES_EVENTS_QUEUE_URL` unset and read the queue by hand if anything is
  deployed.

What a real send looks like, end to end:

```bash
npm run tick -- --once
# backend log: SES-Transport: Email sent   (bare messageId; never an address)

docker exec -i isoplus-mongo mongosh business-dashboard --quiet --eval '
  db.emailsends.find({}, {messageId:1, kind:1, recipientType:1, _id:0}).forEach(printjson)'

# ~a minute later the SQS consumer applies the event
docker exec -i isoplus-mongo mongosh business-dashboard --quiet --eval '
  db.emailevents.find({}, {sesMessageId:1, eventType:1, eventAt:1, _id:0}).forEach(printjson)'
```

`emailsends.messageId` is the **bare** SES id and the only join between an event
and the run that caused it. Events apply to the stamped `PDFLink` rows through a
ranked state machine, so a duplicate matches nothing and a late `Delivery`
cannot erase a `Bounce`.

### Why a scheduled run "Succeeds" and generates nothing

Established 2026-08-26 by driving three real EventBridge runs against
portal-dev. Every one closed `Succeeded` and produced no documents. This is the
most expensive trap in Track A, so work through it before assuming a defect.

**A run that selects nothing is a success, and it is silent.** `Succeeded`,
recipient `—`, no S3 object, and **nothing in Application logs under source
`Automation`** — filtering to that source after three runs returned only the
previous day's entries. `Succeeded` does not mean "generated". Check the
drill-down's recipient column, or the object list under
`output/<workspaceId>/` in the environment's bucket.

**Selection is on Service Delivery Date, not Scheduled Service Date.**
`invoiceGeneratorListQuery` spreads `schedulePeriodServiceDeliveryWindow(...)`,
whose entire return is:

```js
serviceDeliveryStart: start.toISOString(),
serviceDeliveryEnd: new Date(slotStart.getTime() - 1).toISOString(),
```

`filterNdisByDates` compares those against **Actual Shift Start Date & Time**.
Editing *Scheduled* Shift Start moves the "Scheduled Service Date" column on the
Invoice Generator and changes nothing about what a run picks up.

Do not reason from `isItemInvoiceable`'s OR-across-two-date-fields rule. It is a
different gate and does not govern the generator's list query.

**The window excludes the run day.** One cadence step back from the slot's
calendar day, in the schedule's timezone, ending at start-of-run-day minus 1ms.
A monthly block run on 26/08/2026 bills
`26/07/2026 00:00:00.000 → 25/08/2026 23:59:59.999`, so a delivery date of 26/08
misses on the very day you are testing.

**A board edit is invisible until a sync.** The portal reads synced `Item`
documents and sync replaces `data` wholesale. After editing in ISO+, use
**Resync Data** on the Invoice Generator page (or wait for the board-sync cron),
then filter that page to the participant and read the dates back before arming
anything.

**Re-arming rolls forward if you are late.** Changing Run At recomputes
`nextRun`, and a time already past advances to the next period — a month, for a
monthly block. Leave a few minutes' margin to type and save.

**Selection is two stages, and the second one is where this actually failed.**
The list decides what the period CONTAINS; `selectBillableItemIds` decides what
of it is BILLABLE, applying the spec's status-and-date table. A run whose list
is non-empty but whose selection is empty says so at warn — and that line is the
one worth going after:

```
warn Invoice selection removed listed items from this period
     boardId=eNiJpH14PN3 invoiceType=ndis-certification
     listed=5 selected=0 dropped=5
```

The cause on 2026-08-26 was the two stages disagreeing about where the shift
status lives. The list tolerates five spellings (`SHIFT_STATUS_KEYS`); selection
knew only the spec's `Job Status`, and these boards name the column
**`Shift Status`**. Every item failed the status test whatever its dates were —
so no amount of date editing could have worked. Fixed by `STATUS_FIELD_ALIASES`,
which is the same list, so the two cannot drift apart again.

**Where to read that warn.** Not the portal's Application Logs screen — it did
not surface any of it. The line is in the Elastic Beanstalk application stdout:

```bash
aws elasticbeanstalk request-environment-info  --environment-name isoplus-be-dev-blue --info-type bundle
aws elasticbeanstalk retrieve-environment-info --environment-name isoplus-be-dev-blue --info-type bundle
# then unzip and: grep -o '"source":"Automation"[^}]*' var/log/web.stdout.log
```

`--info-type tail` is quicker but holds only the last ~100 lines, which will not
reach a run from more than a few minutes ago. There is no CloudWatch log group
for the dev environment — only prod has one.

**A note on `status: 'pending'`.** The list also filters on it, derived from the
`InvoiceNumber` collection (`type: 'PDF'`) and not from the board's "Generated
NDIS Invoice Number" column — so a Xero number in that column does not exclude
an item. This was checked and was not the blocker.

### Track A quick reference

| Symptom | Cause |
|---|---|
| `claimed=0` forever | not due, disabled, or `SCHEDULER_API_KEY` mismatch (401) |
| Tab missing / `?tab=automation` bounces | `invoiceStatementAutomation` toggle off |
| Tick succeeds, queue empty | no `Board` rows for the workspace — success, not failure |
| Schedule fires, warn "no enabled settings" | settings deleted/disabled; a no-op by design, never throws |
| Two jobs per board | real defect — the periodKey is being derived from `now` |
| Jobs pile up `waiting` | automation worker not started |
| Tick green, nothing generated | `AUTOMATION_ENABLED` unset — the pipeline is gated off by default |
| Run `Succeeded`, recipient `—`, no PDFs | nothing fell in the period — see the section above; check **Actual Shift Start**, not Scheduled |
| Board edit made no difference | no Resync — the portal reads synced Items, not the board |
| PDFs generated but blank | real defect — run step 11; the source rows resolved no values |
| A whole block missing from a statement PDF | one of its multiVariableText variables was empty — pdfme skips the block, not just the field |
| `No account activity; no statement of account` for everyone | no invoice PDFLink rows carry `invoiceTotal` for those participants — expected on a fresh fixture |
| `Statement of account could not be stated` for one participant, "ageing does not reconcile" | the two figures on that document disagree; the check refused to send it and the run carried on without it. Usually a payment against an invoice the ledger has no row for. Read the numbers, do not weaken the check |
| Tick green, replay generates nothing | a completed `bull:automation:*` jobId for that periodKey is still in Redis — clear it |
| An email lists another board's PDFs | real defect — a PDF lookup lost its `boardId` scope |
| Online, tick green, nothing generated at all | no delivery backend resolved — `EMAIL_FROM` or an AWS variable is blank, so the worker refused before claiming invoice numbers |
| Invoices generated, no email, no outbox file | the block chose `sendMethod: 'accounting'` — they went to Xero as DRAFTs |
| `accounting` block logs an error, generates nothing | Xero not connected for that workspace, or the board is not a Care Management board; both settled before generation, on purpose |
| Automation schedules never fire, tick reports `heldBack` | `AUTOMATION_ENABLED` is off. The slots are held, not skipped — each is billed when the switch comes on |
| Send succeeds, `emailevents` stays empty | `SES_EVENTS_QUEUE_URL` unset, or the deployed dev consumer took the message first |

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

- **Tunnel setup, port choice and teardown are the `activate-ngrok` skill's** —
  follow it rather than improvising. What it cannot know: 26 of this board's 41
  automations point at `portal-backend.isoplus.online`, so capture those URLs
  before anything rewrites them.
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

## Related

- `docs/testing-kan10-portal-dev.md` — the same automation driven on portal-dev, including a real SES send via `bypassEmail`
- `docs/testing-kan11-end-to-end.md` — the System Health screens that report on these runs
- `docs/testing-statement-of-account-particulars.md` — proving statement-of-account particulars on portal-dev
- `docs/scheduling.md` — the endpoint, the two delivery policies, what to alert on
- `docs/superpowers/specs/2026-08-12-invoice-statement-automation-design.md` — why the queue is where it stops
- `docs/ongoing/webhooks-and-automation.md` — the 41-automation inventory
- `Backend/test/fixtures/README.md` — what the fixture reproduces and why
- `activate-ngrok` skill — tunnel setup and teardown
