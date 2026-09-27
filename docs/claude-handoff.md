# Claude Code handoff

Concise orientation for a new session picking up this repo. `CLAUDE.md` is
still the source of truth for conventions (branching, PR format, code style,
migrations); this file is state, not rules.

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

- Repo just pulled to `505ded4f` on `develop` (was 35 commits behind).
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
