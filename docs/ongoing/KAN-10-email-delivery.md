# KAN-10 — SES email delivery and event pipeline

**Status:** Code complete on `feature/KAN-10_invoice_statement_automation_full`; blocked on the rotated AWS key for a real send.
**Deleted on merge**, per `docs/ongoing/README.md`.

## What this covers

Sending goes through the SESv2 SDK (`services/email/sesTransport.js`) with the
same IAM key as S3 — there are no SMTP credentials and none are needed (the
earlier SMTP endpoint was an inbound Mail Manager ingress, created by mistake,
deleted upstream 2026-08-18). Delivery/bounce/complaint events land in an SQS
queue polled by `workers/emailEventsWorker.js` into the `emailevents`
collection; each send is recorded in `emailsends` keyed by the bare SES
messageId, which is the only join between an event and the invoice run that
caused it. The full infra reference is Masoud's guide (shared 2026-08-18);
`Backend/.env.example` documents every variable.

## Running locally

Two modes, chosen by what is in `Backend/.env`:

- **Without AWS credentials (today's default):** run offline
  (`ISOPLUS_OFFLINE=1`) and automation emails are written to the outbox
  preview store instead of sent — unchanged from before this work. Online
  with placeholder AWS creds, sends fail at the AWS call; the settings are
  present but the account is fake.
- **Real SES sends:** paste the real `isoplus-app-dev` key into
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (Masoud is sending the
  rotated value separately — the placeholders are `local-dev-*`), and
  uncomment `SES_EVENTS_QUEUE_URL` in `Backend/.env`. Nothing else changes:
  `EMAIL_FROM=noreply@dev.isoplus.online` is already set, and the events
  consumer starts on boot once the queue URL is present.

After any dependency change remember `npm run dev:build`
(see `docs/local-development.md`).

**Send tests only to the simulator addresses** — `success@`, `bounce@`,
`complaint@simulator.amazonses.com`. The suppression list is account-level and
shared with production: one careless bounce in dev can silently stop a real
client's production mail. The dev key's IAM allowlist
(`isoconsultingservices.com.au`, `isoplus.online`, `simulator.amazonses.com`)
rejects everything else with `AccessDenied`, which the SES backend records as
`reason: 'access_denied'` rather than retrying.

**The SQS queue is shared with the deployed dev environment.** A local
consumer steals its messages (SQS delivers each message to one consumer).
Fine while nothing is deployed; coordinate afterwards, or leave
`SES_EVENTS_QUEUE_URL` commented and read the queue manually:

```bash
aws sqs receive-message --queue-url https://sqs.ap-southeast-2.amazonaws.com/645518292482/isoplus-dev-ses-events \
  --max-number-of-messages 1 --wait-time-seconds 5 --visibility-timeout 0 --region ap-southeast-2
```

## Verifying a real send end to end

1. `npm run tick -- --once` (or wait for the schedule) with an enabled
   automation block whose resolved recipient is a simulator address.
2. Backend log shows `SES-Transport: Email sent` with a bare `messageId`;
   `emailsends` gains a row under that id.
3. Within ~a minute the consumer logs `SES event received` and `emailevents`
   gains the `Delivery` (or `Bounce`) row for the same `sesMessageId`.

## Go-live checklist (dev environment)

1. Set on the EB environment (manual, like every other secret there):
   `EMAIL_FROM`, `SES_EVENTS_QUEUE_URL`, `SCHEDULER_API_KEY`, and the
   per-kind `SCHEDULER_API_KEY_INVOICE` / `SCHEDULER_API_KEY_STATEMENT`
   matching the two EventBridge rules Masoud created (values are in the local
   `Backend/.env`; header is the bare key, no `Bearer`).
2. Deploy the branch.
3. Ping Masoud to enable `isoplus-dev-scheduler-invoice` and
   `isoplus-dev-scheduler-statement` — do not enable them yourself.
4. Watch `SchedulerHealth.lastTickAt` advance and the first simulator-recipient
   run produce `emailsends` + `emailevents` rows.

## Open items

- Rotated AWS key value — Masoud, sending separately.
- `hillsgrade.com.au` will not be allowlisted (decided 2026-08-18); use an
  `isoconsultingservices.com.au` address or the simulator.
- Bounce *handling* (marking a recipient invalid, alerting) is deliberately
  out of scope: events are stored, nothing acts on them yet.
