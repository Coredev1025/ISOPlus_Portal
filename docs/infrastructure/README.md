# Cloud infrastructure (AWS)

The AWS infrastructure the portal needs in **dev, UAT and production**: email sending (SES),
delivery events (SNS and SQS), alarms (CloudWatch), the scheduler trigger (EventBridge) and
the IAM access around them. This is where to start when building or changing it.

> **This is not the local Docker guide and not the AI agent guide.**
> Running the portal on a laptop is [`../local-development.md`](../local-development.md) and
> [`../worktrees.md`](../worktrees.md). Setting up an AI agent on a machine is
> [`../agent-setup.md`](../agent-setup.md). Neither describes AWS. This section describes only
> the cloud infrastructure of the running product, and nothing here is needed to work locally.

## What is here

| Where | What | Read it when |
|---|---|---|
| [`overview.md`](overview.md) | The system in one diagram, the current state of dev, the decisions taken and why, open items | First, before anything else |
| [`01-developer-guide.md`](01-developer-guide.md) | How the application sends email and consumes delivery events | Writing code that sends email or reads events |
| [`02-terraform-runbook.md`](02-terraform-runbook.md) | How to build UAT and production with Terraform | Building an environment |
| [`03-operations-sop.md`](03-operations-sop.md) | What to do when an alarm fires or email is not arriving | On call, or something is broken |
| [`04-invoice-statement-generator.md`](04-invoice-statement-generator.md) and [`templates/`](templates/) | The invoice and statement design (already built in the application) | Background for the generators |
| [`05-document-storage-notes.md`](05-document-storage-notes.md) | Attachment against link for statements | Background only |
| [`06-improvements-and-roadmap.md`](06-improvements-and-roadmap.md) | Out-of-scope improvements that need approval and budget | Planning |
| [`../../infrastructure/terraform/`](../../infrastructure/terraform/) | The infrastructure as code (written, **never applied**) | Building UAT and production |
| [`../../infrastructure/iam/`](../../infrastructure/iam/) | Dev team access policies (applied to dev on 20 August 2026) | Giving or reviewing access |

Not in this section: how the application is deployed (a push to `develop` or `main` that changes
`Backend/**` deploys to Elastic Beanstalk, see `.github/workflows/cicd.yml` and
[`../release-runbook.md`](../release-runbook.md)) and the application's own variables (see
`Backend/.env.example`).

## Status per environment

| Piece | Dev | UAT | Production |
|---|---|---|---|
| SES sending identity, config set, event destination | Built by hand, verified | Terraform written, not applied | **Does not exist** |
| SNS topic, SQS queue and dead-letter queue | Built by hand, working | Terraform written, not applied | **Does not exist** |
| CloudWatch alarms and the alert topic | Built by hand, proven to fire and clear | Terraform written, not applied | **Does not exist** |
| EventBridge scheduler rules | Created, **disabled** | Terraform written, not applied | **Does not exist** |
| IAM for the application and for the team | Applied | Terraform written, not applied | **Does not exist** |
| Google sign-in for support admins | Set up | Not documented | **Does not exist, and the release needs it** |

Production's list is from the team on 2026-10-04 and is repeated in the release runbook ("Production
today, and what must exist before the release"). Dev was built by hand and is deliberately not imported
into Terraform.

## Build order

This matches the release runbook's two stages, so infrastructure and release do not wait on each other.

**Stage 1: before the release (automation stays off)**
1. **Google sign-in** for support admins in production (OAuth client, service account, Workspace group,
   the `GOOGLE_*` variables). **Hard blocker**: password sign-in is removed on `develop`. This is *not*
   covered by the Terraform or by any document here; it needs its own short guide (see "Gaps").
2. Release with `AUTOMATION_ENABLED=false`. Nothing scheduled or emailed starts.

**Stage 2: automation (invoices and statements emailed on a schedule)**
3. **Prerequisites:** Terraform installed (the code has never been applied, expect small fixes), an AWS
   profile for the account, and control of the DNS for the sending domains (SES verification, DKIM and the
   custom MAIL FROM records).
4. **Build UAT first** with [`02-terraform-runbook.md`](02-terraform-runbook.md), verify a real send, a
   bounce and a complaint end to end with the simulator addresses, and prove both alarms.
5. **Set UAT's application variables** (`EMAIL_FROM`, `SES_EVENTS_QUEUE_URL`, `SCHEDULER_API_KEY*`,
   `AUTOMATION_ENABLED`, see the table in the release runbook) and run the end-to-end tests against it.
6. **Build production** with the same code and `prod.tfvars`. Production has no recipient allowlist, by
   design (real clients are on arbitrary domains), so use the simulator addresses for the first sends.
7. **Enable the EventBridge rules** only after the backend with the tick endpoint is deployed and the
   scheduler keys are set. Before switching `AUTOMATION_ENABLED` on, read `scheduledjobs.nextRunAt` for
   every enabled schedule (held-back slots bill immediately).
8. **Hand over to operations:** the alert recipients, and [`03-operations-sop.md`](03-operations-sop.md).

## Decisions to confirm before building production

* **One shared AWS account** holds dev, UAT and production (`overview.md`). The suppression list is
  account-wide, so a careless test can stop production email reaching a client. Keep it, or move production
  to its own account before it carries real traffic?
* **Region** `ap-southeast-2` (Sydney) and the sending domains (`dev.isoplus.online` is built; UAT and
  production domains are in the tfvars examples).
* **Keep or drop EventBridge** (scheduling already exists in the application through BullMQ; the rule is
  an external trigger with an audit trail). See `overview.md`.
* **The original IAM access key** pending rotation, and the NDIS record-keeping check on the removed
  outbound mail archive (both in `overview.md`).

## Gaps: not documented anywhere yet

These exist or are needed but have no guide. Each should become a short document in this folder:
* Google sign-in setup for support admins (production and UAT).
* The existing production runtime: the Elastic Beanstalk environments, load balancer and network,
  Redis (ElastiCache, `REDIS_CLUSTER`), the S3 buckets, MongoDB Atlas, and how their settings and
  secrets are held. Only the deploy workflow and the timeout settings are in the repository.
* DNS: who controls `isoplus.online` and where the verification records are added.
* Backups and recovery for MongoDB and the S3 documents.

## Placeholders in these files

The documents, the IAM policy JSON and the Terraform examples carry no account identifier, no real
email address and no keys. Wherever you see `<AWS_ACCOUNT_ID>`, use the account's id
(`aws sts get-caller-identity --query Account --output text`); the IAM JSON files are templates until
it is filled in. The `*.tfvars.example` files hold example values: copy to `*.tfvars` (git-ignored) and
put the real ones there.

## How current this is

Written 17 to 20 August 2026 and checked against live dev AWS with the CLI. The Terraform was reviewed
but **never applied** (Terraform was not installed where it was written). `overview.md` records the open
items as they were on 20 August; the application has moved since (the SQS consumer and the scheduler tick
endpoint exist and are tested), so confirm an item before acting on it. Never commit `*.tfvars` or Terraform state
(the folder's `.gitignore` already excludes them).
