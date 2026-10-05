# Claude Code handoff

Concise orientation for a new session picking up this repo. `CLAUDE.md` is
still the source of truth for conventions (branching, PR format, code style,
migrations); this file is state, not rules. What an agent needs outside the code
(tool access, local environment, databases, backups before a reinstall) is in
[`agent-setup.md`](agent-setup.md).

## Architecture

Monorepo, two independently-deployed apps, no root build tooling.

- **Backend/** — Node.js + Express (ESM). MongoDB via Mongoose, Redis + BullMQ
  for board sync and the invoice/statement automation queue. Routes hold
  controller logic inline and delegate to `src/utils/*Helpers.js` and
  `src/services/*` (no controllers layer). Login is an ISO+ OAuth flow, JWT
  lives in the session. PDFs are `@pdfme/*` against JSON templates in
  `src/assets/`. Email delivery is a pluggable backend (`local-outbox` for
  offline dev, `ses` for real sends via the SESv2 SDK) selected in
  `services/email/registry.js`.
- **Frontend/** — Next.js App Router, routed along the ISO+ domain hierarchy
  (`app/workspace/[id]/board/[boardId]/...`). Large features split into
  `lib/*-page-view.tsx` + `*-helpers.ts` + `use-*.ts` hooks to stay under the
  cognitive-complexity gate.
- **Automation scheduling** — a `ScheduledJob` fires on a tick; each run's
  billing window is computed as exactly one period back from the slot
  (`schedulePeriodServiceDeliveryWindow`), no catch-up range. See "Important
  decisions" below — this is a frequent source of "why did nothing happen".
- **Diagnostics** — Winston logs to console, a daily-rotate file, and a
  MongoDB `logs` collection, surfaced in-app via **Application Logs** and
  **System Health** (both gated to `owner`/`support_admin`, dashboard tabs
  hidden otherwise).

Full detail: `CLAUDE.md` (Backend/Frontend architecture sections),
`docs/scheduling.md`, `docs/migrations.md`.

## Current status

- This file, `ARCHITECTURE.md` and `CONTRIBUTING.md` were added via
  [PR #925](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/925),
  merged to `develop` at `e700e235`. If you're reading this file itself, it
  may have been updated since, check `git log -- docs/claude-handoff.md`.
- Repo pulled to `505ded4f` on `develop` before that PR (was 35 commits
  behind).
- Recent merges of note: **KAN-266** (SES refusal diagnostics correctly blame
  the sending identity, not the recipient), **KAN-267** (Application Logs
  search + System Health messaging + a back button for a zero-output run,
  PR #924, already on `develop`), **KAN-263** (Run At time picker), **KAN-265**
  (automation email template defaults).
- Two client-facing UAT-feedback style tickets from this session:
  **KAN-267** — In Progress (fix merged, not yet independently re-verified
    live against the exact scenario that was reported).
  **KAN-268** — To Do, labeled `needs-approval`, waiting on Arash Niavarani's
    review before any implementation.
- A stray pre-existing local diff in `Backend/yarn.lock` / `Frontend/yarn.lock`
  was stashed (`pre-pull: uncommitted yarn.lock drift`) rather than committed
  or dropped — still sitting in `git stash list`, now stale against the
  lockfile the pull brought in. Needs a human decision (drop it, most likely).

## Outstanding issues

- **KAN-268** needs Arash's approval before any code is written — do not start
  implementation speculatively.
- The `yarn.lock` stash above is unresolved.
- KAN-267's fix hasn't been exercised end-to-end against workspace 55515 (the
  original repro) since it merged — worth a quick live check before closing
  the loop with whoever reported it.
- Dev's AWS role used for investigation (`isoplus-dev-role` SSO profile) has
  no `ssm:*` and no `ses:ListSuppressedDestinations` — if a future SES issue
  needs the account-wide suppression list, that requires a broader-permission
  session or the AWS console directly.

## Important decisions

- **The dev SES "AccessDenied" guardrail is about the sending identity, not
  the recipient.** SES authorizes `ses:SendEmail` against the From address's
  identity ARN; a workspace's `Email From` on an unverified domain gets
  refused exactly like a disallowed recipient would, and the two used to be
  indistinguishable in the logs. Fixed in KAN-266. Verified SES identities in
  this AWS account: `isoplus.online`, `dev.isoplus.online`. Production access
  is enabled (not sandboxed).
- **Automation never catches up on history.** A schedule only ever bills the
  single period immediately before each run. A freshly-enabled schedule over
  backdated test/seed data will legitimately produce zero documents — this is
  correct behavior today, not a bug. KAN-268 proposes changing that for the
  manual-to-automated switch case specifically, but it's a real change to
  billing/invoice-numbering behavior and is gated on approval.
- **Extracting a live database credential to disk is refused by design**
  (hit this when trying to query the dev Mongo `logs` collection directly) —
  the sanctioned path for that data is the in-app Application Logs / System
  Health views, or CloudWatch/EB log retrieval, not the raw connection string.
- **Don't duplicate `CLAUDE.md`.** README.md already keeps its own
  architecture/conventions sections short and points here for the rest;
  `ARCHITECTURE.md` and `CONTRIBUTING.md` (added alongside this file) are
  deliberately thin pointers for the same reason, not full restatements.

## Reference

Operational details that took real digging to find. Re-check before relying
on them if it's been a while — these are facts about external systems, not
things this repo controls.

- **Jira**: cloud ID / site is `isoconsultingservices.atlassian.net`, project
  key `KAN`. The Jira MCP tools take `cloudId` as that site string directly.
- **AWS**: two SSO profiles are configured locally —
  `isoplus-dev-role` (used for read-only investigation; has EB, SES and
  CloudWatch Logs read access, but **not** `ssm:*` or
  `ses:ListSuppressedDestinations`) and `isoplus-admin`. SSO session needs
  `aws sso login --profile isoplus-dev-role` when expired (opens a browser).
  Region is `ap-southeast-2`.
- **Elastic Beanstalk environments**: `isoplus-be-dev-blue` (dev,
  `develop` branch deploys here) and `isoplus-be-prod-blue` (prod, `main`
  branch). Only `isoplus-be-prod-blue` has CloudWatch log streaming enabled —
  for dev, use the EB "request/retrieve-environment-info" tail (last ~100
  lines per log file) or the in-app Application Logs / System Health views,
  not CloudWatch, for anything on dev.
- **Portal roles**: the in-app dashboard's **Application Logs** and
  **System Health** tabs only render for accounts with `owner` or
  `support_admin` role in that environment's own `users` collection — being
  logged in via ISO+ OAuth is not sufficient by itself. Role is per
  environment (dev vs prod are separate databases).
- **Known test workspaces on dev** (`portal-dev.isoplus.online`): `55369`
  ("Development Test Workspace"), `55515` ("Automated Invoicing Test",
  Arash's manual/automated invoicing test bed), `55390` (used for an earlier
  automation-timezone bug). Their boards and item data are real test fixtures,
  not synthetic — dates on them drift into the past relative to "today" as
  time passes, which is exactly what caused the KAN-267 investigation.

## Process note

The commit adding this Reference section was originally pushed straight to
`develop` with no branch or PR (2026-09-27, commit `12401aa5`). That was
wrong and got reverted (`e687e970`) and redone here via a branch and PR
instead. **Never push directly to `develop`** — branch and open a PR, even
for docs-only changes.
