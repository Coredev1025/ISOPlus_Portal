# The Terraform checked against what dev actually has

Dev was built by hand and works, so it is the best test of whether `infrastructure/terraform/` describes the
right things. On 2026-10-06 each Terraform resource was compared with the matching dev resource, read-only
(`aws sesv2`, `sns`, `sqs`, `cloudwatch`, `events`, `iam`). Terraform itself has **not** been run:
it is not installed and the code has never been through `validate`, `plan` or `apply`.

> **Read this before ISO+ moves to `mail.isoplus.online`.**
> ISO+ Portal (this product) will send from `mail.isoplus.online` with its own SES configuration set as the
> identity's default, and ISO+ (the main platform, which sends from `isoplus.online` today) is expected to move
> to the same subdomain later. Anything ISO+ sends from `mail.isoplus.online` **without naming its own
> configuration set** has its delivery, bounce and complaint events delivered to ISO+ Portal's SNS topic and
> queue. ISO+ Portal cannot match them to a document, so they fail, are retried five times, and fill the
> dead-letter queue, which trips the alarm and can stall real ISO+ Portal events behind them. Do the checklist
> in "Before ISO+ moves" below first.

## What matches

| Area | Terraform | Dev | Result |
|---|---|---|---|
| SES identity | DKIM `RSA_2048_BIT`, custom MAIL FROM `mail.<domain>`, on MX failure `USE_DEFAULT_VALUE` | `dev.isoplus.online`: DKIM success, RSA 2048, MAIL FROM `mail.dev.isoplus.online` verified, `USE_DEFAULT_VALUE` | Match |
| Configuration set | TLS `REQUIRE`, reputation metrics on, sending on, named for the environment | `isoplus-dev`: the same | Match |
| Event types | `BOUNCE COMPLAINT DELIVERY DELIVERY_DELAY REJECT RENDERING_FAILURE` | The same six | Match |
| SNS | `<prefix>` (events) and `<prefix>-alerts`; SQS subscription with raw delivery | `isoplus-dev`, `isoplus-dev-alerts`; SQS subscription raw delivery `true` | Match |
| SQS | 14-day retention, 30 s visibility, 20 s long poll, redrive after 5 to a DLQ, SSE on | `isoplus-dev-ses-events` and `-dlq`: the same values | Match |
| Alarms | `...-ses-events-stalled` (age over 900 s, 2 x 300 s), `...-ses-events-dlq-nonempty` (over 0, 1 x 300 s), missing data not breaching | The same two, same values | Match |
| Scheduler | API-key connection (header `Authorization`), API destination `POST` at 10 per second, `rate(1 minute)` rule, tick role `<prefix>-eventbridge-tick` | The same shape and names | Match |

So the building blocks are right. The differences below are about the **production environment**, not the shape.

## What does not match, and what to do

### 1. The parent domain is already a verified SES identity, so production uses a subdomain

`isoplus.online` already exists in this account: verified, DKIM success (its three DKIM records are in Cloudflare),
**no default configuration set, no custom MAIL FROM**. About 100 emails a day leave the account, and a separate
configuration set `delivery-reporting` streams events to a Firehose (the `isoplus-email-logs` bucket). ISO+ already sends through this domain. The production tfvars example has `sending_domain = "isoplus.online"`,
so applying it would either fail (the identity exists) or, if imported, **attach our configuration set and a
new MAIL FROM to that domain**, changing mail that is not ours.

**Decided 2026-10-06:** ISO+ Portal sends from its own identity, `sending_domain = "mail.isoplus.online"`
(matching `EMAIL_FROM=noreply@mail.isoplus.online`), the same pattern as dev's `dev.isoplus.online`. The parent
`isoplus.online` is ISO+'s and is left alone. SES uses the most specific identity, so the new one does not
affect the parent. ISO+ is expected to move to `mail.isoplus.online` later (see below).
Needed in Cloudflare: three new DKIM CNAMEs for the subdomain and the MAIL FROM records. SES requires the MAIL
FROM domain to be a subdomain of the identity, so `mail_from_subdomain = "bounce"` gives `bounce.mail.isoplus.online`
(see [`11-dns-and-cloudflare.md`](11-dns-and-cloudflare.md)).

## Before ISO+ moves to `mail.isoplus.online`

After the move, ISO+ and ISO+ Portal send from one identity. Do not move ISO+ until each of these is settled and
written down:

1. **ISO+ names its own configuration set on every send.** Today it uses `delivery-reporting` (events to a
   Firehose and the `isoplus-email-logs` bucket). An explicit configuration set on a send overrides the
   identity's default, so ISO+'s events keep going where they go now and never reach ISO+ Portal's queue.
   Confirm in ISO+'s code that **every** send path sets it, including retries, test sends and any second
   service. One path without it is enough to fill the queue.
2. **Prove it on dev first.** Send from ISO+ through `dev.isoplus.online` (or a test identity) with and without
   the configuration set, and watch `isoplus-dev-ses-events` and its dead-letter queue. Without the set, events must
   appear in the queue; with it they must not.
3. **Decide whether the default stays attached.** The safest option is to **not** make ISO+ Portal's configuration
   set the identity default (set it per send in ISO+ Portal instead, as the code allows). Then a send that names
   no set is untracked, not misrouted. The cost is that ISO+ Portal must never omit it. The Terraform currently
   attaches it as the default (a deliberate safeguard noted in `ses.tf`); changing that is a choice between the two
   failure modes, to be made before the move.
4. **Sending permission.** ISO+'s IAM user or role must be allowed `ses:SendEmail` on the new identity. The
   ISO+ Portal policy is scoped to that identity and to its configuration set only, so it does not cover ISO+, and
   ISO+ keeps its own policy.
5. **Reputation and suppression.** Bounces and complaints from either application count against the one
   domain and the one account, and the account already shares a single suppression list. Agree who watches the
   bounce-rate and complaint-rate alarms, which are account-wide.
6. **SPF, DKIM and DMARC for the subdomain.** Alignment is then judged for both applications' mail. The apex has
   no SPF record and DMARC is set to monitor only (`p=none`). Check ISO+'s mail aligns before tightening
   anything.
7. **Alert when it goes wrong.** The existing dead-letter queue alarm (`...-ses-events-dlq-nonempty`) fires on the
   first message. Make sure its recipients know what a flood from ISO+ would mean, and how to redrive or purge it.
   `docs/infrastructure/03-operations-sop.md` has the redrive steps.

### 2. The app's AWS user: Terraform makes a new one nobody uses

ISO+ Portal's production application authenticates as the existing IAM user **`isoplus-app`**, whose only policy is
`s3:*` on the production buckets. Dev's `isoplus-app-dev` has S3 plus SES sending (limited to the dev identity
and configuration set). The Terraform creates a new user `isoplus-prod-app` with S3, SES and queue permissions,
and the tfvars sets `create_app_access_key = false`, so the application would never use it. SES sends and
event-queue reads would be refused in production.

**Decided 2026-10-06:** attach the SES and queue permissions to the existing `isoplus-app` user, the same way
dev's hand-built policy sits on `isoplus-app-dev`. The Terraform then references that user by name instead of
creating a new one, creates no new access key, and the production `AWS_ACCESS_KEY_ID` and secret stay as they are.
Consequences to keep in mind:

* The application keeps using one long-lived key for S3, SES and the queue, now with wider access than before.
  That is the situation KAN-325 exists to remove (the instance role instead of user keys).
* The new policy must **not** repeat the S3 permissions: `isoplus-app-policy` already grants `s3:*` on the production
  buckets. Only the SES-send and queue-consume statements are added.
* The SES statement is scoped to the new identity (`mail.isoplus.online`) and to the new configuration set only,
  so it does not widen access to ISO+'s identity `isoplus.online`.
* Rollback is detaching the one policy from `isoplus-app`; nothing else changes.

**How dev does it (checked 2026-10-06):** dev did not create a separate key or user for email.
`isoplus-app-dev` has one access key (created March 2025, before the email work) and one policy,
`isoplus-app-dev-policy`, with an S3 statement and a `SesSendDev` statement. The application's key in dev is that
key. Production follows the same pattern: one existing user, one key, a policy statement added.

**Do not copy dev's gap, and know about the bug it exposed.** Dev's policy had **no statement allowing the queue to
be read**, and the dev application had no `SES_EVENTS_QUEUE_URL`, so its event consumer was not running and
`isoplus-dev-ses-events` held 62 unread messages with the stalled alarm in ALARM. The production Terraform
does include the queue statement (`ConsumeSesEvents`), and stage 2 sets `SES_EVENTS_QUEUE_URL` (see
[`09-production-environment-properties.md`](09-production-environment-properties.md)); both are required in
production.

On 2026-10-06 dev was fixed (queue statement added as policy version `v6`, queue URL set, KAN-329) and that
exposed a **bug in the event consumer**, now fixed by PR #992 (KAN-329) and verified on dev the same day:

* **Cause:** the consumer processed events correctly (a row per event in `emailevents`, no errors) but its handler
  returned nothing, and `sqs-consumer` v15 deletes a message only when the handler returns it. The messages stayed
  on the queue, were redelivered, and after five receives moved to the dead-letter queue. Nothing was lost or
  duplicated: redelivery was idempotent.
* **Fix:** the handler returns the message once the event is stored. A new test runs the real `sqs-consumer`
  against a fake SQS client, because the existing tests mock the library and could not see this.
* **Verified on dev:** a redrive of the 63 dead-lettered events was processed and deleted (queue and DLQ at zero);
  fresh simulator success, bounce and complaint events were each stored once; and a real scheduled run (statements
  to the bounce simulator, an invoice to the success simulator) ended with the documents **bounced** and
  **delivered** respectively.
* **Production:** the consumer is inert there until stage 2 sets `SES_EVENTS_QUEUE_URL`. The fix ships with the
  same release as the consumer, so stage 2 must not be switched on from a build that lacks it.

### 3. Wrong values in `prod.tfvars.example`

| Value | In the example | Real |
|---|---|---|
| `scheduler_endpoint` host | `portal-be.isoplus.online` | `portal-backend.isoplus.online` |
| `app_s3_buckets` | `isoplus-portal-prod`, `isoplus-portal-prod-public` | `isoplus-portal`, `isoplus-portal-public` |

### 4. Things to know before an apply

* **The account's SES reputation alarms are account-wide.** The bounce-rate and complaint-rate alarms (production
  only) watch the whole account, so a dev test that bounces moves the same number. Suppression is account-wide too.
* **Production already sends** through this account, so a configuration mistake here is not a quiet one.
* The runbook says to build UAT first and promote to production only after UAT has run one full invoicing
  cycle. No UAT environment exists, and **the owners decided on 2026-10-06 to skip it** and apply straight to
  production. The mitigations (this comparison with dev, a re-run plan, scheduler rules left disabled, simulator
  addresses only, proving the alarms) are in section 8 of [`02-terraform-runbook.md`](02-terraform-runbook.md).
* Remote state is an S3 bucket with S3-native locking (`use_lockfile`, no DynamoDB table), created by hand; see section 3 of the runbook.

## Not compared

IAM for the team (`infrastructure/iam/`, applied to dev on 20 August) was not re-read. The Firehose logging and the
`ses-mail-manager` role in the account are older work outside this Terraform.
