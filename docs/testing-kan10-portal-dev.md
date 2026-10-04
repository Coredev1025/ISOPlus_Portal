---
name: testing-kan10-portal-dev
description: >-
  Use when driving KAN-10 invoice/statement automation by hand on portal-dev —
  firing a scoped scheduler tick, forcing the recipient to the SES simulator
  with bypassEmail, reading a tick's response, deciding whether `sent` is a
  pass, or restoring a shared workspace afterwards. Also use when sends stop
  dead for every recipient on portal-dev. For the local stack use
  docs/testing-kan10-end-to-end.md instead.
---

# Testing KAN-10 on portal-dev

Invoice & Statement Automation (Epic 5), driven by hand against the deployed
dev environment. The local stack is covered in depth by
[`testing-kan10-end-to-end.md`](testing-kan10-end-to-end.md); this file is the
half that covers what only a deployed environment can prove — a real SES send.
For proving statement-of-account particulars specifically, use
[`testing-statement-of-account-particulars.md`](testing-statement-of-account-particulars.md).

## Which environment proves what

The worker never branches on how mail leaves the building; only the resolved
delivery backend changes. So where a run *ends* is a property of the
environment. Decide what you are trying to prove before picking one.

| Want to prove | Local | portal-dev |
|---|---|---|
| Settings validation, Next Run, timezone, panel behaviour | yes | yes |
| Selection, generation, populated PDFs, per-board fan-out | yes | yes |
| A composed email with the right attachments | yes — as an outbox JSON file | yes |
| A real send (`sent`) | only with real AWS creds in `Backend/.env` | **yes, via `bypassEmail`** |
| `delivered` / `bounced` | no | only once `SES_EVENTS_QUEUE_URL` is set on the EB environment — see *Reading the result* |

Locally the offline backend records no `messageId`, so no delivery event can
ever match a document. A local run that ends at the outbox files is a
*passing* run.

## Environment

| | |
|---|---|
| Frontend | <https://portal-dev.isoplus.online> — sign in via SSO (**Support agent sign-in**, Google) |
| Backend | `https://portal-be-dev.isoplus.online` |
| EB environment | `isoplus-be-dev-blue`, `ap-southeast-2` |
| Workspace with seeded Care Management boards | **55390** (ISO+™ NDIS & SaH Demo) |

This is a shared environment, and part of every run is irreversible. Read
*Leave it as you found it* before you start.

**Check the code under test is actually deployed.** Merging to `develop`
triggers the deploy, but a green *Deploy Backend* job only proves the version
label was handed to Elastic Beanstalk — it does not wait for the environment to
come back `Ready`/`Green`. Confirm the environment's running version before
testing against it.

## 1. Arm the schedule through the UI

1. **Toggle the feature on** — Workspace → Configuration → Feature Toggles card,
   *Invoice & Statement Automation*. Owner / Support Admin only. Default off,
   and with it off the Automation tab does not exist.
2. **Arm a block** — Finance Settings → `?tab=automation`. Enable it, set Run
   At a few minutes ahead and Start Date today, and Save. **Record every value
   you change first** — you must put them back.
3. **Check Next Run** against the block's own "Times shown in <zone>" note. The
   schedule runs in the workspace's Head Office Timezone, which is not
   necessarily Sydney.

**Re-arming rolls forward if you are late.** Changing Run At recomputes
`nextRun`; a time that has already passed advances to the next period — a month
away for a monthly block. Leave a few minutes' margin to type and save.

**The EventBridge rules may beat you to it.** If `isoplus-dev-scheduler-invoice`
/ `-statement` are enabled, an armed schedule fires on its own without your
tick. Check before assuming a run was yours.

## 2. Fire it — scoped key, forced recipient

### Use the scoped key

The presented key *is* the scope:

| Key | Claims |
|---|---|
| `SCHEDULER_API_KEY` | every kind, including `board_sync` |
| `SCHEDULER_API_KEY_INVOICE` | invoice schedules only |
| `SCHEDULER_API_KEY_STATEMENT` | statement schedules only |

Use the scoped key so you do not drag board sync into your test. The header is
the **bare key, no `Bearer`**. Full rules in [`scheduling.md`](scheduling.md).

The scoped keys are **not** in a local `Backend/.env` — the unscoped local key
401s against portal-dev. Read the real values off the EB environment:

```bash
aws elasticbeanstalk describe-configuration-settings --profile isoplus-dev \
  --region ap-southeast-2 --application-name isoplus-be-dev \
  --environment-name isoplus-be-dev-blue --output json
```

The **backend** origin accepts a non-browser `curl` — an unauthenticated or
wrong-key request comes back as an application 401, not a Cloudflare 403. So
the tick can be driven from a shell, which keeps the key out of any browser
transcript. The **frontend** origin is Cloudflare-gated and does 403 non-browser
clients.

### Force the recipient with `bypassEmail`

The demo participants are not clean data — some have no billing address at
all — so a run to the real billing contacts generates documents and delivers
none. `bypassEmail` replaces the resolved recipient for the whole tick: same
selection, same generation, same composition, same attachments, real SES; only
the destination changes.

```bash
curl -sS -X POST https://portal-be-dev.isoplus.online/api/scheduler/tick \
  -H "Authorization: $SCHEDULER_API_KEY_STATEMENT" \
  -H 'Content-Type: application/json' \
  -d '{"bypassEmail":"success@simulator.amazonses.com"}'
```

**Only ever the SES simulator addresses** — `success@`, `bounce@`,
`complaint@simulator.amazonses.com`. The SES suppression list is account-level
and shared with production; one careless bounce in dev can silently stop a real
client's mail.

A malformed `bypassEmail` returns 400 and claims nothing — deliberately,
because falling back to the real billing contacts is the outcome it exists to
prevent.

### When every send is refused

Dev SES is **not** in sandbox (`aws sesv2 get-account` reports
`ProductionAccessEnabled: true`), so an `AccessDenied` is an **IAM** decision,
not a recipient restriction.

SES authorises `ses:SendEmail` against the *sending identity* —
`identity/<from-address>` — never the recipient. The from-address is the
environment's `EMAIL_FROM`, and it must sit on a verified identity
(`isoplus.online` or `dev.isoplus.online`). If it does not, every send fails
whoever the recipient is, and `Backend/src/services/email/backends.js` reports
it as *"The address is outside the domains this environment is allowed to send
to"* — which blames the recipient and sends you looking in the wrong place.
**If sends stop dead, check `EMAIL_FROM` on the EB environment first.**

## 3. Reading the result

```
200 {"claimed":1,"dispatched":1,"failed":0,"heldBack":0,"capped":false}
```

| Field | Means |
|---|---|
| `claimed: 0` | nothing due, disabled, or the key did not match its kind |
| `heldBack > 0` | `AUTOMATION_ENABLED` is off — slots held, not skipped |
| `failed > 0` | the job threw before dispatch; check the logs |
| `capped: true` | you hit the batch limit; re-tick for the rest |

Then, on the Automation tab: the schedule's last run advances, it is not marked
failed, Next Run advances by exactly one period, and the recent documents
appear with recipient, sent time and delivery state. The System Health
drill-down (`/workspace/<id>/system-health`) shows the same run — see
[`testing-kan11-end-to-end.md`](testing-kan11-end-to-end.md).

### `sent` or `delivered`?

`delivered` advances only from the SES feedback loop, and
`workers/emailEventsWorker.js` is inert by design while `SES_EVENTS_QUEUE_URL`
is unset on the EB environment. **Check whether it is set before you judge the
result.** If it is not, `sent` is the passing result — do not report it as a
failure and do not wait for `delivered`. As of 2026-09-22 it was absent, and no
portal-dev document had ever left `sent`.

Once it is set, a run gains two more observable steps about a minute after the
send:

1. `emailsends` gains a row under the **bare** SES `messageId` — the only join
   between an event and the run that caused it.
2. `emailevents` gains a `Delivery` (or `Bounce`) row for the same
   `sesMessageId`, and the document's delivery state advances.

Aim a run at `bounce@simulator.amazonses.com` to exercise the other branch.
Events apply through a ranked state machine, so a late `Delivery` cannot erase
a `Bounce` and a duplicate matches nothing.

**Once the queue is wired, do not set `SES_EVENTS_QUEUE_URL` locally.** The
queue is shared with portal-dev and SQS delivers each message to one consumer,
so a local backend with it set *steals* portal-dev's events — silently at both
ends. Read the queue by hand instead
(`aws sqs receive-message --queue-url … --visibility-timeout 0`). Detail in
[`ongoing/KAN-10-email-delivery.md`](ongoing/KAN-10-email-delivery.md).

## 4. A run that "Succeeds" and generates nothing

The biggest time-sink in this feature, and covered in full in
[`testing-kan10-end-to-end.md`](testing-kan10-end-to-end.md#why-a-scheduled-run-succeeds-and-generates-nothing).
The short version, because it bites hardest on portal-dev:

- **A run that selects nothing closes `Succeeded`.** Read the drill-down's
  explanation and recipient column, or the object list in
  `s3://isoplus-portal-dev/output/<workspace>/`, before reading `Succeeded` as
  "it generated".
- **Selection windows on Service Delivery Date** (Actual Shift Start), never
  Scheduled Shift Start. Editing the scheduled date changes nothing a run picks
  up.
- **The window excludes the run day** — it ends at start-of-run-day minus 1 ms
  in the schedule's timezone. Pick a delivery date a few days back.
- **Board edits do not reach the automation until a sync.** Use **Resync Data**
  on the Invoice Generator page, then filter it to the participant and read the
  dates back before you arm anything.

Automation warnings are in the Elastic Beanstalk stdout, not only on the
Application Logs screen. There is no CloudWatch log group for dev, and
`--info-type tail` holds ~100 lines, so go straight to a bundle:

```bash
aws elasticbeanstalk request-environment-info  --environment-name isoplus-be-dev-blue --info-type bundle
aws elasticbeanstalk retrieve-environment-info --environment-name isoplus-be-dev-blue --info-type bundle
# unzip, then: grep -o '"source":"Automation"[^}]*' var/log/web.stdout.log
```

## 5. Leave it as you found it

- Switch the automation block back off, so nothing further fires.
- Restore every setting you changed, from the values you recorded in step 1.
- **Not reversible:** consumed document numbers and the generated documents
  themselves, which stay in the list. Budget for that before running against a
  workspace someone will demo.

## Known ceilings

Not defects; do not spend a session chasing them.

| Ceiling | Where |
|---|---|
| `delivered` / `bounced` unprovable | portal-dev, until `SES_EVENTS_QUEUE_URL` is set |
| No `messageId`, so no delivery event can match | local — offline outbox backend |
| `automationWorker.js` runs `concurrency: 1` and renders PDFs | both — a fan-out takes minutes |
| Demo participants without billing addresses | portal-dev workspace 55390 |

Delivery *failure* states are reachable: a refused send stamps the document
"Failed to send" with a plain-English reason. Locally those are seeded in the
shape the real writers leave behind — `Frontend/e2e/support/delivery-failures.ts`
and `seedFailedDocument` in the invoice spec — because the pipeline that
produces a bounce cannot run on a laptop.
