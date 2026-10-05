# Production release runbook

How a change gets to production, what has to be done by hand around it, and how
to undo it. Written from `.github/workflows/cicd.yml`, `docs/migrations.md` and
`docs/scheduling.md`. Anything that could not be confirmed from the repository
is in "To confirm" at the end and marked **(to confirm)** where it appears: fill
those in rather than guessing.

Ticket: KAN-295. Branching, tickets and commit rules are in
[`CLAUDE.md`](../CLAUDE.md); this file does not repeat them.

## What a release is here

- **A push to `main` that changes `Backend/**` deploys the backend to
  production.** The workflow decides what changed by diffing the push against its
  parent commit only (`HEAD~1`), so merge the release PR with a **merge commit**
  and confirm "Deploy Backend" actually ran. A rebase-merge of a multi-commit PR
  diffs only the last commit and can skip the deploy. The `CICD` workflow
  runs the backend tests (and the frontend tests if the frontend changed). If
  they pass, it zips `Backend/`, uploads it to S3
  (`isoplus-backend-deploy-bucket-isoplus-v1`), creates an Elastic Beanstalk
  application version in `isoplus-be-prod` labelled `<timestamp>-<commit sha>`,
  and points `isoplus-be-prod-blue` (region `ap-southeast-2`) at it.
- A push to `develop` does the same for `isoplus-be-dev-blue`.
- **The frontend is not deployed by this workflow.** How it reaches production is
  **(to confirm)**.
- A change that touches only `.github/` produces no push run, so it does not
  deploy itself. The workflow can be started by hand with the `deploy` input set,
  which builds, tests and deploys the backend. The Elastic Beanstalk steps only act
  when it is run on `main` (production) or `develop` (dev), but the S3 upload runs
  from whichever branch it is started on.
- **Migrations never run on deploy.** See "Migrations".
- **Elastic Beanstalk environment properties are not set by the workflow.** They
  live in the environment's own configuration and survive every deploy. Changing
  one triggers an environment update and a rolling restart, so treat it as a
  deployment. See `docs/scheduling.md`.
- **The scheduler is external.** An EventBridge rule calls
  `POST /api/scheduler/tick`; the app has no timer of its own for invoice and
  statement automation.

## 1. Before the release

Work through these in order. If a step cannot be done, say so in the release
note rather than skipping it.

1. **Compare `main` with `develop`, and reconcile them first.** They have
   drifted, so promoting `develop` ships everything in it and can silently undo
   a hotfix that exists only on `main`. Run the comparison in
   "Comparing main with develop" below, and do not open the release PR until:
   every commit that is only on `main` is also in `develop` (or has been
   consciously dropped), the trial merge is clean, and the release contents
   (migrations, environment variables, infrastructure, sign-in changes) have been
   read and signed off. The snapshot taken on 2026-10-04 is in the next section;
   it found problems.
2. **No open PR is half of a pair.** If a change needs a migration, an
   environment property, or a frontend deploy, confirm the other half is ready.
3. **CI is green on the commit being released**, backend and frontend.
4. **It has been verified on dev**, with evidence: not "tested locally". Dev is
   `portal-dev.isoplus.online`, backend health
   `https://portal-be-dev.isoplus.online/api/healthcheck`.
5. **List the migrations the release needs** (see "Migrations pending", below)
   and check each has been run on dev.
6. **List environment changes.** New or changed Elastic Beanstalk properties
   (for example `SCHEDULER_API_KEY`, `AUTOMATION_ENABLED`, `EMAIL_FROM`). They
   have to be set in production by hand, and a missing one often fails silently.
7. **Rehearse on a copy of the production database, run locally.** Restore a
   copy into its own local database, scrub it, run every pending migration in
   order with its duration recorded, run the new code against it, and compare
   what it produces with what the old code produces. Required before any release
   that carries a migration or touches billing. The procedure, the handling rules
   (the copy holds real data and may hold live credentials) and the pass criteria
   are in "Rehearsing on a copy of production" below.
8. **Take a database backup or snapshot and note its time.** How is **(to
   confirm)**. A migration is effectively irreversible without one.
9. **Pick the time.** Avoid the scheduled automation slots of the workspaces that
   matter most, and avoid starting a deploy while a run is in flight. Slot times
   are per workspace in the `scheduledjobs` collection.
10. **Name who is doing it and who can roll it back.** Whoever holds the production
   database and AWS credentials is **(to confirm)**.
11. **Record the version currently running**, so rollback has a target:

    ```bash
    aws elasticbeanstalk describe-environments \
      --environment-names isoplus-be-prod-blue --region ap-southeast-2 \
      --query 'Environments[0].VersionLabel'
    ```

## Comparing main with develop

Do this at the start of every release, from a fresh `git fetch origin`.

```bash
git fetch origin
BASE=$(git merge-base origin/main origin/develop)

git rev-list --count origin/main..origin/develop        # commits that would ship
git rev-list --count origin/develop..origin/main        # commits only main has
git log --oneline --merges origin/main..origin/develop  # the PRs that would ship
git cherry -v origin/develop origin/main                # "+" = a change develop lacks
git merge-tree --write-tree --name-only origin/main origin/develop   # trial merge, touches nothing

git diff --stat origin/main origin/develop              # size and areas
git diff --name-status origin/main origin/develop -- Backend/migrations      # migrations that would ship
git diff --name-status origin/main origin/develop -- Backend/src/models      # schema changes
git diff origin/main origin/develop -- Backend/package.json Frontend/package.json   # dependencies
git diff origin/main origin/develop -- Backend/.env.example                 # environment variables
git diff --stat origin/main origin/develop -- .github Backend/.ebextensions Backend/.platform   # deploy config
```

Read the `git cherry` output carefully. A `+` line is a commit on `main` whose
change is not in `develop`; if it is not brought across, the release removes it
from production.

### Snapshot: 2026-10-04

What the comparison found. Treat it as the starting point and re-run the
commands; it will be out of date.

| | |
|---|---|
| Merge base | `7dfbe16a`, 2026-07-23 (PR #844) |
| `develop` ahead of `main` | 525 commits, 87 merged PRs, 2026-07-23 to 2026-10-02 |
| `main` ahead of `develop` | 20 commits, of which 17 are merge commits |
| Size | 802 files changed, 173,230 insertions, 7,675 deletions (most of it tests: 267 Backend and 166 Frontend test files) |
| Source touched | 176 Backend `src` files, 54 Frontend `lib`, 14 Frontend `app`, 12 `scripts`, 33 `docs` |

**Findings that block a straight promotion:**

1. **Three production hotfixes exist only on `main`, and a trial merge conflicts
   in six files.**
   - `c5c67a6c` (2026-08-31, PR #892, KAN-22): "Fix isoplus_user board access and
     OAuth login redirect". Touches `Backend/src/index.js`, `Frontend/app/page.tsx`,
     the workspace page and the board page.
   - `f08001a9` and `1fe10a55` (2026-09-08, PR #896, KAN-28): ISO+ service
     authorization parameters, attribute caching and pagination. Touch
     `Backend/src/services/isoplus.js` and `Backend/src/utils/isoplusLogoHelpers.js`.
   - The trial merge reports content conflicts in `Backend/src/index.js`,
     `Backend/src/services/isoplus.js`, `Backend/src/utils/isoplusLogoHelpers.js`,
     `Frontend/app/page.tsx`, `Frontend/app/workspace/[id]/page.tsx` and
     `Frontend/app/workspace/[id]/board/[boardId]/page.tsx`.
   - **Do this first:** merge `main` into `develop` through a PR, resolve those six
     files once, and test. Then the release PR from `develop` to `main` has
     nothing to resolve and cannot drop a hotfix. Resolving the conflicts inside
     the release PR is how a hotfix gets lost.
2. **Support-admin password sign-in is removed.** On `main`, `POST
   /api/auth/login` signs a support admin in with email and password. On
   `develop` it answers 404 ("Support admin password login is no longer
   available. Use Google sign-in."). Support-admin access becomes Google sign-in
   with a Workspace group check on every session verify. Before releasing,
   production must have the Google settings (below) and at least one support admin
   must have confirmed they can sign in with them, or support admins are locked
   out. `GOOGLE_SUPPORT_BREAK_GLASS_EMAILS` is the escape hatch for a failed
   directory lookup only.
3. **Six migrations have never run in production** (table below).
4. **New infrastructure and environment variables are needed** (below). Several
   fail silently when missing.

**Also in the release:**

- **Schema.** 15 model files changed or added: `AutomationRun`,
  `AutomationSettings`, `ScheduledJob`, `SchedulerHealth`, `EmailSend`,
  `EmailEvent`, `XeroConnectTicket` (new collections; `ticketSchema.js` is a shared schema file), and changes
  to `AuditTrail`, `Board`, `Business`, `Item`, `OAuthTicket`, `PDFLink` and
  `SyncExecution`.
- **Dependencies.** Backend adds `@aws-sdk/client-sesv2`, `@aws-sdk/client-sqs`,
  `sqs-consumer`, `ts-migrate-mongoose` (runs migrations), `google-auth-library`, `googleapis`, `nodemailer`,
  `cron-parser` and `lodash-es`, and removes `node-schedule` (board catch-up
  moved to an in-process clock). Frontend adds the TipTap editor packages and
  `lodash-es`. Everything else added is test tooling.
- **Deploy workflow.** `.github/workflows/cicd.yml` was rewritten (259 lines
  changed). The release deploys with the `develop` version of it, which is the one
  this runbook describes.
- **Tests.** `develop` carries the Vitest suites and Playwright end-to-end tests
  that `main` does not have, so the first release also changes what CI enforces.

### Environment and infrastructure the `develop` code expects

Set these in the Elastic Beanstalk environment **before** the deploy, except
where noted. Each variable's meaning is in `Backend/.env.example`. Setting one
triggers an environment update and a restart.

| Needed | Variables and resources | If it is missing |
|---|---|---|
| Support-admin sign-in | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_CALLBACK_URL` (defaults to `${BACKEND_URL}/api/auth/google/callback`), `GOOGLE_ADMIN_EMAIL`, `GOOGLE_TARGET_GROUP`, `GOOGLE_SERVICE_ACCOUNT_JSON` (on Elastic Beanstalk use the JSON variable; `_KEY_FILE` is a path relative to `Backend/`), optional `GOOGLE_SUPPORT_BREAK_GLASS_EMAILS`; and the callback URL registered with Google | Support admins cannot sign in |
| Scheduler | `SCHEDULER_API_KEY` (and the optional per-kind `SCHEDULER_API_KEY_INVOICE` / `_STATEMENT`), plus the EventBridge rule. See `docs/scheduling.md` | The app boots healthy and no schedule ever runs |
| Automation switch | `AUTOMATION_ENABLED`. Leave it `false` until the migrations have run and the Google and email settings are verified; a tick then holds due jobs back instead of running them | With it off, jobs are held, not lost |
| Email | `EMAIL_FROM` (production: `noreply@mail.isoplus.online`, on a domain verified in SES) | Sends are refused |
| Email delivery events | `SES_EVENTS_QUEUE_URL`, the SQS queue and the SES event destination that feeds it | Delivered, bounced and complained states never reach the documents |
| Session cookies | `BACKEND_URL`. `SESSION_COOKIE_SAMESITE` is new but has no effect in production: with `NODE_ENV=production` the session cookie is always `Secure` and `SameSite=None` | None in production |
| Board catch-up | `BOARD_SYNC_ENABLED`, `BOARD_SYNC_CRON`, `BOARD_SYNC_GAP_MS` | Defaults apply |
| Must be unset in production | `ISOPLUS_OFFLINE`, `LOCAL_FILE_ROOT` | They switch the app to local, offline behaviour |
| Read by the code, optional | `EMAIL_BACKEND`, `XERO_SCOPES` | Defaults apply |

### Production today, and what must exist before the release

Told by the team on 2026-10-04: **production has no Google single sign-on
setup, and no SQS, SNS, SES or EventBridge setup.** The `develop` code expects
all of them. What that means, piece by piece:

| Missing in production | What the `develop` code does without it | Before releasing |
|---|---|---|
| **Google sign-in** (OAuth client, service account, Workspace group, the `GOOGLE_*` variables) | `GET /api/auth/google/redirect` returns 503 and **no support admin can sign in**, because password sign-in is removed on `develop`. Nothing else works around it. | **Hard blocker.** Set it up and have a support admin confirm they can sign in, before the release. There is no fallback to password login. |
| **SES** (verified sending identity for `EMAIL_FROM`, an IAM key allowed to `ses:SendEmail`) | No email backend: an automation run that would email "generated nothing rather than discarding it" and sends nothing. Safe, but no invoice or statement is emailed. | Needed only for automated emails. Not a blocker if automation stays off. |
| **SQS queue, and SES sending events feeding it** (the team's AWS setup guide, now in [`infrastructure/`](infrastructure/README.md), says an SNS topic does) | The email-events consumer does not start when `SES_EVENTS_QUEUE_URL` is unset. No delivery, bounce or complaint states are recorded; documents stay "generated". | Needed only for delivery tracking. Not a blocker. |
| **EventBridge rules** (dev has one per kind: invoice and statement) and `SCHEDULER_API_KEY` | `POST /api/scheduler/tick` is never called, so **no schedule ever runs**. With `SCHEDULER_API_KEY` unset the endpoint answers 500 and the app logs a warning at boot. | Needed only for scheduled automation. Not a blocker if automation stays off. |

**Suggested staging, for a decision:** release with `AUTOMATION_ENABLED=false`
once Google sign-in works (stage 1). The portal then behaves as `main` does for
users, plus the new screens and the KAN-292 and KAN-293 changes, and nothing
scheduled or emailed starts. Turn automation on later (stage 2) after SES, the
SQS queue, the EventBridge rules and the scheduler keys exist and have been
tested on a real send. Do not set `AUTOMATION_ENABLED=true` without them. **Before
switching it on, read `scheduledjobs.nextRunAt` for every enabled schedule:** slots
held back while it was off stay due, so each schedule's oldest held slot bills
immediately when the switch comes on.

Three things that catch people out:

- **The SES account is shared with dev.** The suppression list is account-level,
  so a bounce sent from dev can silently stop a real client's production mail.
  Test only with the simulator addresses until production sending is separate.
- **EventBridge rules are created and enabled by whoever owns the AWS account,**
  not by a deploy. Dev's rules are `isoplus-dev-scheduler-invoice` and
  `isoplus-dev-scheduler-statement`; do not enable a production one yourself
  without that owner.
- **Setting an Elastic Beanstalk property restarts the environment.** Set all the
  new ones in one change, not one at a time.

## 2. Migrations

Migrations are files in `Backend/migrations/`, run by hand with
`Backend/scripts/migrate.mjs`. Full detail in [`docs/migrations.md`](./migrations.md).
For a production release:

0. **Run migrations from a checkout of the exact release commit**, not a feature
   branch (a feature branch can carry migration files that are not part of the
   release) and not `main` (it has no `Backend/migrations`, no
   `scripts/migrate.mjs` and no `ts-migrate-mongoose`). Run `npm ci` in `Backend/`
   on the host first: the local Docker setup keeps `node_modules` in a volume, so a
   laptop may have none.
1. **Look at the data first.** A migration is a claim about what is stored.

   ```bash
   cd Backend
   MONGODB_URI='<production uri>' npm run schema -- <collection>
   ```

   **`npm run schema` is not read-only.** It imports every model from the release
   commit, and with Mongoose's defaults (`autoIndex` and `autoCreate` on) that
   creates missing collections and starts building every index the models declare.
   Against production that is part of the deploy's index work running early and
   unannounced. Run it against production only with a **read-only database user**,
   or treat it as part of the migration step at the time you chose.

2. **See what has run and what is pending.** `list` needs no remote flag, but it is
   not read-only: it first imports migration files the database does not know yet
   into its `migrations` collection (after a prompt). Run it from the release
   commit, as in step 0 above. In a terminal the import prompt starts with nothing
   selected: choose all, or a later `up <name>` fails with "Could not find
   migration ... in the database".

   ```bash
   MONGODB_URI='<production uri>' npm run migrate -- list
   ```

3. **Run it deliberately, one migration at a time.** The wrapper refuses a
   database that does not look local unless you pass `--allow-remote`. Typing it is
   the point, so confirm the target first: print the host of the URI you are about
   to use and check it is the production cluster, not the dev one in `Backend/.env`.
   Run from `Backend/` natively; the root `npm run migrate` execs into the local
   Docker container and would hit the local database, not production.

   ```bash
   MONGODB_URI='<production uri>' npm run migrate -- up <migration-name> --single --allow-remote
   ```

   Pass the bare name (`backfill-document-numbering-initialized`), not the file
   name. **Without `--single`, `up <name>` applies every pending migration older
   than it as well** (checked against the runner; this is how all seven ran on dev
   on 2026-10-04 when only one was meant). To apply several, run them oldest first,
   each with `--single`, and check each. **`--single` does not check whether a
   migration is already applied**: it will re-run one that has run (for
   `pdflink-invoice-period` that drops and rebuilds the double-billing unique
   index), and `down X --single` runs the `down` of one that never ran. Confirm
   the state with `list` immediately before. Every production command in this document
   carries `MONGODB_URI='<production uri>'`: without it the wrapper falls back to
   `Backend/.env`, which usually points at the dev database, and `--allow-remote`
   then bypasses the guard. Do not write the connection string into a file or a
   commit, and clear it from your shell history afterwards.
4. **Check it did what it should**, using the row for that migration in the table
   below.
5. **Order against the deploy** is stated per migration, because it differs. A
   migration that only fills in missing data is safe either side of the deploy; one
   that removes or reshapes a field the old code still reads must run after the
   deploy that stops reading it.
6. **Never edit a migration that has run outside your own machine.** Write a new
   one.

### Migrations pending for the next production release

Keep this table current. Add a row in the PR that adds the migration; delete the
row once the migration has run in production and the release is closed.

| Migration | Added by | Run | What it does | Check it worked | Undo |
|---|---|---|---|---|---|
| `backfill-document-numbering-initialized` | KAN-292 (PR #953) | **Before** the deploy that includes KAN-292. The first-numbers screen refuses a business whose counters are not all stored, so migrating first means nobody is ever refused. Safe against the old code and at any time. Idempotent. Needs MongoDB 4.2 or later (not DocumentDB). | Stores every missing document numbering counter and prefix (older businesses lack `statementOfAccount` and `statement`) and the `documentNumberingInitialized` flag, so a stale `save()` cannot write defaults back over numbers the user chose. Never changes a value that is already there. The flag is true where any of invoice, purchase order, quote or statement of account has moved off 1, otherwise false. | Before and after: `MONGODB_URI='<production uri>' npm run schema -- businesses`. Then in the database: `db.businesses.countDocuments({documentNumberingInitialized: {$exists: false}})` must be `0`, and `db.businesses.countDocuments({"documentNumbering.statementOfAccount.nextNumber": {$exists: false}})` must be `0` (same for `statement`, `invoice`, `purchaseOrder`, `quote`). After the deploy (section 4), open Finance Settings for one workspace that has issued invoices: the number fields must be read-only. | `MONGODB_URI='<production uri>' npm run migrate -- down backfill-document-numbering-initialized --single --allow-remote` removes the flag only; the backfilled counters stay. **It removes every flag, including one a user set after the migration**: a business that chose 1 for all four numbers and has issued nothing then looks unset again and can set its numbers a second time. Only run it together with rolling back the code that reads the flag. |

#### Migrations that ship when `develop` is promoted (snapshot 2026-10-04)

All seven are in `develop` (PR #953 merged on 2026-10-04).

None of these has run in production (all seven have run on dev, 2026-10-04). Pending migrations apply in
timestamp order, and `up <name>` without `--single` takes every older one with it. All of them only add indexes, clean up, or disable rows; none
reshapes data the old code reads. Run the index migrations **before the deploy**,
so the new code never runs without them (the unique one is the guard against
billing a period twice), and the KAN-292 backfill **before it as well**: until it
has run, a business with a missing counter is refused when it tries to set its
first numbers. So all seven run before the deploy. Keep `AUTOMATION_ENABLED` off
until they have run.

| Migration | What it does | Risk and pre-check | Undo |
|---|---|---|---|
| `1771401600000-remove-xero-connection-logs` | Unsets `xeroConnectionLogs` on every business. Those events now live in the audit trail. | Not reversible: the log documents are not copied out. Its own note says production documents never had the field. Check: `db.businesses.countDocuments({xeroConnectionLogs: {$exists: true}})`. | `down` writes an empty array back, not the history. |
| `1786697189409-pdflink-scheduled-xero-ids` | Creates index `automation_slot_lookup` on `pdflinks`. | Index build on the whole `pdflinks` collection. | `down` drops the index **and removes `periodKey` and `invoiceNumber`** from every `pdflinks` row that has a `periodKey`, which is every row an automation run wrote. Once automation has run that is billing data, so treat it as not undoable. |
| `1787023330061-pdflink-email-delivery-state` | Creates sparse index `delivery_message_lookup` on `pdflinks`. | Sparse, so small. No backfill by design. | `down` drops the index **and removes** `deliveryMessageId`, `deliveryState`, `deliveryDetail` and `deliveryUpdatedAt` from every row that carries a message id. Once emails have been tracked that is real data, so do not run it after go-live without a reason. |
| `1787097600000-audit-trail-workspace-category-index` | Creates `workspaceId_1_category_1_createdAt_-1` on `audittrails`. | Index build on a large collection. | `down` drops the index. |
| `1787186180650-pdflink-invoice-period` | Drops and recreates the **unique** partial index `automation_period_item_unique` (the double-billing guard) after the duplicate check. It does not add the period fields themselves; they are optional fields written by automation runs. | It checks for duplicate rows first and refuses to build, with a clear message naming them, if any exist; no index is left behind. If it refuses, the duplicates must be understood, not deleted blindly. | `down` drops the index and removes `periodStart`, `periodEnd`, `invoiceType` and `invoiceTotal` from rows that have them. `periodKey` is left alone. |
| `1787291724206-disable-portal-board-sync-schedule` | Sets `enabled: false` on the old EventBridge-era `scheduledjobs` row with `kind: 'board_sync'` and `targetId: 'portal'`. | That row must stay disabled or a tick claims it with no handler. Check: `db.scheduledjobs.find({kind: 'board_sync', targetId: 'portal'})`. | `down` sets it back to enabled, which you do not want. |
| `1791050490815-backfill-document-numbering-initialized` (KAN-292, PR #953) | The row above. | The row above. On the 2026-10-03 production snapshot it flags 93 of 95 businesses as initialized, because production counters started at 1000 (83 businesses sit at 1000/1000/1000/1 and have most likely issued nothing); for them the first-numbers screen is read-only. **Accepted (Masoud, 2026-10-04)**: a business that asks is updated by a support script. | The row above. |

Before running any of them in production: take the backup (section 1), then
`MONGODB_URI='<production uri>' npm run migrate -- list` to see exactly which are
pending, and run `MONGODB_URI='<production uri>' npm run schema -- pdflinks`,
`-- audittrails` and `-- businesses` to see the real shape.

If this release also ships KAN-293 (PR #952): it needs no migration and no
environment change. See "After the deploy" for what to watch.

## 3. The deploy

0. **Run the pre-deploy migrations** (section 2): the backup, then `list`, then
   each migration with `--single` oldest first, then the checks in the table. All
   seven are pre-deploy. Do not merge until they have run and been checked.
1. Open a PR from `develop` to `main` (hotfixes go from `hotfix/...` to `main`,
   see "Hotfix"). Check the diff is the scope you agreed.
2. Merge with a **merge commit**. The `CICD` workflow starts on the push to `main`.
3. Watch it: the test jobs, then `Deploy Backend`. Both must be green. A red test
   job blocks the deploy by design.
4. Watch the Elastic Beanstalk environment until it reports healthy:

   ```bash
   aws elasticbeanstalk describe-environments \
     --environment-names isoplus-be-prod-blue --region ap-southeast-2 \
     --query 'Environments[0].[Health,Status,VersionLabel]'
   ```

   The version label must be the new `<timestamp>-<sha>`. The backend can return
   502 briefly while it restarts.
5. Deploy the frontend **(to confirm how)**.
6. Confirm "Deploy Backend" really ran (the workflow only deploys when `Backend/**`
   changed in the pushed commit). There are no migrations to run after the deploy.

## 4. After the deploy

Do these before calling it done, and write down the result of each.

- **Health.** `GET /api/healthcheck` on the production backend host returns
  `{"status":"OK"}`. The production backend host is **(to confirm; the webhook
  documentation uses `portal-backend.isoplus.online`)**.
- **Boot warnings.** Check the deployment log for `Bootstrap:` warnings. In stage 1
  (automation off, no EventBridge) `SCHEDULER_API_KEY is not set` is **expected**.
  In stage 2 it means no schedule will ever run and nothing else says so.
- **Stage 2 only: the scheduler is ticking.** `SchedulerHealth.lastTickAt` keeps
  advancing. A stale value means the EventBridge rule or `SCHEDULER_API_KEY` is
  missing. See `docs/scheduling.md`, "What to alert on".
- **Sign in** and open a workspace: dashboard, a board, Finance Settings.
- **Errors.** Sentry and the in-app Application Logs show no new error class
  since the deploy.
- **The specific change.** Each change in the release has its own check. For
  KAN-292: a workspace that has issued documents shows read-only number fields,
  and a workspace whose counters are all 1 and whose flag is unset shows editable
  fields with examples. For KAN-293 (stage 2, once automation is on): after the first scheduled invoice run, the
  `AutomationRun` for a board with participants succeeded, the logs show no
  "multiple participant profiles detected", and any `Billable items left out: no
  Participant Profile` warning lists item ids worth a look.
- **Stage 2 only: watch the next scheduled run** of a workspace you can verify, and
  the emails it sent, before leaving.

## 5. Rolling back

Decide quickly. The longer a bad release runs, the more data it writes.

- **Code.** Point the environment at the previous version label recorded in
  section 1. The old application versions are kept in Elastic Beanstalk:

  ```bash
  aws elasticbeanstalk describe-application-versions \
    --application-name isoplus-be-prod --region ap-southeast-2 \
    --query 'ApplicationVersions[].[VersionLabel,DateCreated]' --output table

  aws elasticbeanstalk update-environment \
    --environment-name isoplus-be-prod-blue --region ap-southeast-2 \
    --version-label <previous label>
  ```

  Then revert the commit on `main` through a PR, so the next push does not
  redeploy the bad version. Reverting a merge commit has a trap: a later
  `develop` to `main` merge will not bring those changes back unless the revert is
  itself reverted first.
- **A migration.** Run its `down` with `--single` (without it, every newer applied
  migration is rolled back as well). The table says what each `down` does, and
  several delete data. Check first that the older code can run against the migrated
  data, and the reverse.
- **What cannot be rolled back.** Documents already issued: invoice and statement
  numbers that were claimed, PDFs written to S3, emails already sent, invoices
  pushed to Xero. A bad release that runs the automation can create these. If the
  release touched billing, say so in the rollback note and list what was issued
  after the deploy.
- **The database.** Restoring from backup loses everything written since, so it is
  the last resort and a decision for more than one person.

## Rehearsing on a copy of production

Done before the backup and the deploy, on the machine of whoever runs the release.
It exists because dev data is small and was damaged differently from production,
so it cannot show how the migrations, a backfill or new billing code behave on the
real shapes and volumes. The design behind it is section 8 of
[`2026-10-04-invoice-source-of-truth-design.md`](superpowers/specs/2026-10-04-invoice-source-of-truth-design.md).

**Automating this.** `npm run rehearse` replays steps 1 to 4, 6 and the backfill part of 7 below on a throwaway MongoDB 8.0 in Docker, in about half a minute for the production snapshot, and compares the result with `scripts/rehearse/expectations.*.json`. How to run it, what it covers and what is still manual is in [`roadmap/release-rehearsal.md`](roadmap/release-rehearsal.md); change both together.

**Handling.** The copy holds real participant and business data and may hold live
credentials. Keep it outside the repo and only in the local Mongo, in its own
database (for example `isoplus-prod-copy`); never commit it; delete the dump, any
extracted files and the database when the rehearsal is signed off. Do not copy, log
or use any credential found in it.

1. **Restore into a separate database, explicitly.** Do not put the dump in `seed/`:
   `npm run seed` restores the newest `*.gz` there into the shared development
   database with `--drop`, and only restores a database named `isoplus`. Use
   `mongorestore --nsFrom=<production db>.* --nsTo=isoplus-prod-copy.*`.
   If the copy is an **Atlas snapshot download** (a `.tgz` of raw storage files),
   extract it, open it with a throwaway `mongod` of a compatible version started
   with no network and no published port, dump from that, and restore as above. Find
   the version first: the snapshot's `WiredTiger.turtle` names the storage engine
   release, and the cluster page shows the MongoDB version.
2. **Scrub before the backend ever starts against the copy**, then check it with
   count queries. Offline mode does not cover Xero, so the only protection is that
   no token exists. Unset `businesses.xeroTokens`; drop or clear `sessions`; clear
   `oauthtickets.accessToken` and `xeroconnecttickets`; set `enabled: false` on every
   `scheduledjobs` row and every `AutomationSettings`; clear queued delivery state;
   treat `users` (real emails and password hashes) as sensitive and replace or remove
   them where the rehearsal does not need them. The reviewed script is
   [`scripts/rehearse/scrub.js`](../scripts/rehearse/scrub.js); `npm run rehearse` runs it
   and stops unless every count afterwards is zero. Anything it does not clear is not
   scrubbed: add to the script, do not work around it.
3. **Run the backend fully offline**: `ISOPLUS_OFFLINE=1`, `AUTOMATION_ENABLED`
   unset, the offline email backend. Nothing may reach ISO+, S3 or SES. Point the
   backend at the copy with a Compose override kept outside the repo (the recipe in
   [`testing-kan10-end-to-end.md`](testing-kan10-end-to-end.md) shows the shape).
4. **Run the migrations as production will**: `list`, then each pending migration
   with `--single`, oldest first, timing each one. The unique index in
   `1787186180650-pdflink-invoice-period` refuses to build if the copy holds
   duplicate rows; if it does, that is the finding.
5. **Test each `down` on a separate throwaway restore**, never on the copy the rest
   of the rehearsal uses. Several `down`s delete data (see the migration table), and
   re-running `up` does not bring it back. Drop the throwaway restore afterwards.
6. **Run the audit** (next section) and read every category.
7. **For a release that ships the invoice ledger**: set `INVOICE_LEDGER_WRITE=on`,
   run the backfill script's dry run, then `--apply`, then run it again (it must
   create nothing), then `--undo` on a throwaway restore; check the invariants; set
   `INVOICE_LEDGER_READ=shadow` and generate statements and generator lists for a
   sample of real workspaces. The only differences allowed are the classes in the
   design (section 7), with counts matching the audit.
8. **Do not run the Backend unit suite or the e2e suites against the copy.** The unit
   suite starts its own in-memory database and replaces the connection string, so it
   never sees the copy; the e2e suites load fixtures into workspace 55390 and would
   pollute it. They run as usual on a normal checkout.
9. **Write the result** to a file under `docs/ongoing/` (migration timings, the audit
   report, any differences and what explained them) and link it from the release note.

**Pass criteria.** Every migration runs in order and rolls back; the audit is
understood; the backfill is idempotent and reversible; the invariants hold; every
difference between old and new statements and lists is in a known class; production
timings can be estimated.

## Invoice ledger rollout

Applies only to the release that ships the invoice ledger (KAN-302). Nothing in
this section is built yet; the commands marked *(to be written)* are finalised
with the code. The design, the phases and the reasoning are in
[`2026-10-04-invoice-source-of-truth-design.md`](superpowers/specs/2026-10-04-invoice-source-of-truth-design.md).

Phases 0 to 4 are reversible by turning a flag off. Phase 5 is not, which is why
it is its own later release. **Customer statements change at phase 4**, in the
ways listed in the design (section 6.6), and that has to have been accepted
beforehand (decision D3).

### Phase 0: audit production, read only

Run the queries below on the rehearsal copy first. On production, run them against
a secondary or off-peak: their lookups are not indexed, so each scans the items or
the ledger per number. They read only, and they work today on the existing
collections. In an interactive `mongosh` session paste each as is; from a script
file wrap each in `printjson(... .toArray())`.

```js
// 1. Markers with no ledger row for an invoice document: the invoice exists only
// as a marker on its items (INV-3 and INV-6 on dev). Xero-only markers
// ("(Xero)") appear here by design. A ledger row of another type, a soft-deleted
// row, or one whose number differs only by a suffix also shows up here, so read
// each result before treating it as marker-only.
db.items.aggregate([
  { $match: { invoicedBy: { $type: 'string', $not: /^pending:/ } } },
  { $group: { _id: { w: '$workspaceId', n: '$invoicedBy' }, items: { $sum: 1 } } },
  { $lookup: { from: 'pdflinks', let: { w: '$_id.w', n: '$_id.n' },
      pipeline: [
        { $match: { type: { $in: ['NDIS Invoice', 'Participant Tax Invoice'] }, isDeleted: { $ne: true } } },
        { $match: { $expr: { $and: [{ $eq: ['$workspaceId', '$$w'] },
                                     { $eq: ['$invoiceNumber', '$$n'] }] } } },
        { $limit: 1 }],
      as: 'ledger' } },
  { $match: { ledger: { $size: 0 } } },
  { $project: { _id: 0, workspaceId: '$_id.w', marker: '$_id.n', items: 1 } },
  { $sort: { workspaceId: 1, marker: 1 } },
])

// 2. Stale log numbers: in the old per-item log, on no item and in no ledger row
// (INV-22 on dev). The Invoice Generator shows these. The log keeps only the
// latest number per item, so this proves nothing about earlier invoices.
db.invoicenumbers.aggregate([
  { $match: { type: 'PDF' } },
  { $group: { _id: { w: '$workspaceId', n: '$invoiceNumber' }, rows: { $sum: 1 } } },
  { $lookup: { from: 'items', let: { w: '$_id.w', n: '$_id.n' },
      pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$workspaceId', '$$w'] },
                                              { $eq: ['$invoicedBy', '$$n'] }] } } },
                 { $limit: 1 }], as: 'marked' } },
  { $lookup: { from: 'pdflinks', let: { w: '$_id.w', n: '$_id.n' },
      pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$workspaceId', '$$w'] },
                                              { $eq: ['$invoiceNumber', '$$n'] }] } } },
                 { $limit: 1 }], as: 'ledger' } },
  { $match: { marked: { $size: 0 }, ledger: { $size: 0 } } },
  { $project: { _id: 0, workspaceId: '$_id.w', number: '$_id.n', rows: 1 } },
  { $sort: { workspaceId: 1, number: 1 } },
])

// 3. Provisional claims still held. A fresh one belongs to a live run; one older
// than an hour is stale and needs a person to decide.
db.items.aggregate([
  { $match: { invoicedBy: /^pending:/ } },
  { $group: { _id: '$workspaceId', tokens: { $sum: 1 }, oldest: { $min: '$invoicedAt' } } },
])

// 4. Items on more than one invoice number in the ledger (the KAN-289 double
// billing). This sees only double billing that reached the ledger.
db.pdflinks.aggregate([
  { $match: { type: { $in: ['NDIS Invoice', 'Participant Tax Invoice'] },
              invoiceNumber: { $type: 'string' }, isDeleted: { $ne: true } } },
  { $group: { _id: { w: '$workspaceId', item: '$itemId' }, numbers: { $addToSet: '$invoiceNumber' } } },
  { $match: { 'numbers.1': { $exists: true } } },
  { $project: { _id: 0, workspaceId: '$_id.w', itemId: '$_id.item', numbers: 1 } },
])

// 5. Items whose marker differs from the number the old log holds for them. This
// catches the double billing that never reached the ledger (manual Age Care, Xero)
// and any marker that drifted from the log. It uses the unique itemId index.
db.invoicenumbers.aggregate([
  { $match: { type: 'PDF' } },
  { $lookup: { from: 'items', localField: 'itemId', foreignField: 'itemId', as: 'item' } },
  { $unwind: '$item' },
  { $match: { $expr: { $and: [
      { $ne: [{ $ifNull: ['$item.invoicedBy', null] }, null] },
      { $not: [{ $regexMatch: { input: '$item.invoicedBy', regex: '^pending:' } }] },
      { $ne: ['$item.invoicedBy', '$invoiceNumber'] } ] } } },
  { $project: { _id: 0, workspaceId: 1, itemId: 1, marker: '$item.invoicedBy', logNumber: '$invoiceNumber' } },
])
```

These were checked on 2026-10-04 against a throwaway database holding one of each
case: each reported exactly its case (query 1 also reported a marker whose only
ledger row was a statement and one whose row was soft-deleted, as described), and
each reported nothing on the clean local test database. The wrapper
`npm run invoice-audit -- --workspace <id>` (or `--all`, from `Backend/`) checks the invariants
per workspace, prints each violation and each reported case, and exits 1 if there is a
violation (read only). Read every row before continuing: the backfill treats each category
differently (design section 6).

### Running the invoice backfill

`Backend/scripts/invoice-backfill.mjs`, from `Backend/`:

```bash
npm run invoice-backfill -- --workspace <id>            # DRY RUN, the default: writes nothing, prints a plan hash
npm run invoice-backfill -- --all --report-file /tmp/backfill.json
npm run invoice-backfill -- --workspace <id> --apply --plan <hash> --ack double-billed=3 --ack stale-legacy=1
npm run invoice-backfill -- --workspace <id> --undo              # PREVIEW only
npm run invoice-backfill -- --workspace <id> --undo --apply      # does it
npm run invoice-audit -- --workspace <id>                        # read only
```

* It reads the item markers, the document ledger and the old log and prints what a real run
  would create (by reason: `ledger`, `marker-only`, `log-only`, `xero-only`, `xero-later`) and every
  category that needs a person: `unplaceable` (with the reason: `board-unknown`,
  `participant-unknown`, `date-unknown`, `total-underivable` and why), `unplaceableLedgerRows`,
  `staleLegacy`, `doubleBilled`, `duplicateNumbers`, `xeroSpansInvoices`, `xeroConflicts`,
  `supersededByXero` (each item whose later Xero invoice replaced a portal invoice) and
  `supersededPortalInvoices` (a portal invoice every item of which moved to a Xero invoice),
  `pendingTokens`, `deletedItems`, `deletedDocuments`, `markerMissing` and the others in the
  report. Each category printed shows the exact `--ack` flag, and the dry run prints a
  **plan hash**.
* A real run (`--apply`) needs **the plan hash of the dry run you read** (`--plan <hash>`) and
  **every category found acknowledged with its exact count**. If the stores or the invoices
  changed since the dry run it refuses and asks for a new dry run. It plans each workspace
  again immediately before writing it and stops if that workspace no longer matches; every
  planned record is validated before the first write; it prints each workspace as it is
  written, and if it stops part way, says which workspaces were done (re-running finishes the
  rest). It refuses without the `invoice-ledger-indexes` migration, and refuses to take over a
  number a live invoice now holds.
* It only adds: invoices, `invoiceId` on ledger rows, `activeInvoiceId` on items (only where the
  item still has the pointer it had when planned), a Xero number on an invoice that lacks one.
  It never edits a marker, a log row or any other old field. Running it again creates nothing.
* `--undo` only previews until `--apply` is added. It removes the invoices it made
  (`origin: backfill`) and the stamps and pointers that name them, never a live-issued invoice,
  and **leaves alone, and lists, any backfilled invoice live code has updated since** (a Xero
  stamp, an adopted number) because deleting it would lose what it recorded. **Undo is only
  safe while `INVOICE_LEDGER_READ` is `off`**: once readers use the new record, a rollback is
  the flag, not a deletion.
* Totals for invoices with no printed total are derived with the generators' own functions
  (NDIS rows, priced per participant profile; Age Care contribution, or the full amount on Low
  Cat) and marked `totalDerived`. A test pins each kind against real generated invoices. The
  derivation **never calls ISO+**: a pricing rule that cannot be read from the service plan is
  reported as `total-underivable`, not assumed. An NDIS item that builds no rows contributes 0.
* The participant of an invoice comes from the item's `Participant Full Name`, else from the
  participant profile the item references. An item with no profile reference cannot be priced
  by the generators and its invoice is reported `unplaceable` with that reason, not guessed.
* Safety: it refuses a database that is not local unless `--allow-remote` is given (a tunnel to
  production on localhost passes that check, so check where `MONGODB_URI` really points before
  every run). Name the workspaces with `--workspace` (repeatable) or pass `--all`; nothing runs
  by default. The scripts do not write log entries to the database they work on. The
  `--report-file` holds participant names: it is written readable by its owner only, and should
  be deleted when it has been read.

### Before enabling automation: backfill the item markers

Found on the production copy (2026-10-04, see
[`docs/ongoing/2026-10-04-prod-copy-rehearsal.md`](ongoing/2026-10-04-prod-copy-rehearsal.md)):
**no production item has `invoicedBy`**, because production runs the code from
before the marker existed. Items invoiced by hand are recorded only in
`invoicenumbers`. Today both scheduled paths already skip an item with a `PDF`
log row (they list items with status `pending`, which the log decides), so the
exposure is items whose **only** log row is `Xero`: 16 on the copy, all in one
workspace, none logged since 28 August. The markers still have to be backfilled
before automation is enabled, because the invoice-ledger work removes that log
filter, after which all 368 existing logged items (149 PDF only, 16 Xero only,
203 both) would be exposed, and because the marker is the guard that works when
the log is not read.

Keep `AUTOMATION_ENABLED` off, and every workspace's Invoice and Statement
Automation toggle off, until the markers are backfilled. The audit query:

```js
// 6. Items that the old log says were invoiced, that still exist, and that carry
// no marker. Must be empty before automation is enabled.
db.invoicenumbers.aggregate([
  { $lookup: { from: 'items', localField: 'itemId', foreignField: 'itemId', as: 'item' } },
  { $unwind: '$item' },
  { $match: { $or: [{ 'item.invoicedBy': null }, { 'item.invoicedBy': { $exists: false } }] } },
  { $group: { _id: { w: '$workspaceId', t: '$type' }, items: { $addToSet: '$itemId' } } },
  { $project: { _id: 0, workspaceId: '$_id.w', type: '$_id.t', unmarkedItems: { $size: '$items' } } },
  { $sort: { workspaceId: 1, type: 1 } },
])
```

The backfill is `Backend/scripts/invoice-marker-backfill.mjs`, from `Backend/`:

```bash
npm run invoice-marker-backfill -- --workspace <id>                    # DRY RUN, the default; prints a plan hash
npm run invoice-marker-backfill -- --all
npm run invoice-marker-backfill -- --workspace <id> --apply --plan <hash>
npm run invoice-marker-backfill -- --workspace <id> --undo             # PREVIEW; add --apply to do it
```

It sets `invoicedBy` to the logged number **exactly as stored** (including its `(ISO+™)` or
`(Xero)` suffix, which is what the readers already accept) and `invoicedAt` to the log row's
`createdAt`, on every logged item that exists and has no marker. **It never overwrites a marker**
(a pending claim included), and the write itself only takes an item that still has none, so a
live claim that lands after the dry run is never overwritten. Where an item has both a `PDF` and
a `Xero` row (206 on the copy) the **later row is the marker** (decision D9, KAN-315; D8 had said
the PDF number always wins). A Xero row strictly later than the PDF row means the Xero invoice is
the current one for that item, so the marker is the Xero number; a PDF row that is later, or an
equal or unusable date, keeps the PDF number and D8 (the Xero number lives on the portal
invoice). The invoice backfill makes the same choice per item, so marker and pointer agree. Among several rows of one type
(an item that changed board) the **latest** row wins, because the invoice backfill points an item
with no marker at the latest invoice that lists it, so marker and pointer agree. A row with a
number but no usable creation date still marks the item (a missing marker would make it
billable again); its date falls back to the row's last update, then to when the row was written,
and is counted approximate. The log keeps one row per item
per type and 446 of its 597 rows were revisited after creation, so a row's `createdAt` can
belong to an earlier invoice than its number; the dry run counts them (270 on the copy) and
`invoicedAt` from such a row is approximate. It sets `invoicedPeriodKey` to `backfill-from-log`
so `--undo` clears exactly what it set (a live claim overwrites that field, so an item a claim
has since taken over is left alone). The plan hash, the per-workspace re-plan before writing,
the per-workspace progress and the refusal of a non-local database work as in "Running the
invoice backfill". `--undo --apply` is only safe **before scheduled selection stops reading the old
log**: after that, clearing these markers makes all 368 items billable again. A marker that
`repairInvoice` has since confirmed is no longer the backfill's and undo leaves it. Items whose
logged number has no invoice record (the invoice backfill's `unplaceable` list) are marked too,
which is right (they were billed), and the audit then reports them under `markerWithoutInvoice`.

**Order:** run the invoice backfill first, then this, so each item's pointer and marker agree.
Both must be done before automation is enabled.

**On the production copy (2026-10-05):** 368 items to mark (352 from PDF rows, 16 from Xero rows;
149 PDF only, 203 both, 16 Xero only: the same 368 as query 6), 23 log rows belong to deleted
items. After applying, query 6 returned 0 and 368 items carried a marker; a second run marked
nothing; `--undo` returned the items collection to a hash identical to before. The audit then
reports `markerWithoutInvoice` for 66 items: exactly the items on the 8 invoices the invoice
backfill reported `unplaceable` (see its report). Those are the list for a person to work
through; the markers themselves are right (those items were billed).

### Phases 1 to 5

| Phase | Do | Check before the next | Back out |
|---|---|---|---|
| 1. Ship, flags off | Deploy. `INVOICE_LEDGER_WRITE` and `INVOICE_LEDGER_READ` are unset or `off`. | Release checks in section 4. Behaviour is unchanged | Roll back the code (section 5) |
| 2. Dual write, then backfill | Backup first. **Run the `invoice-ledger-indexes` migration** (`commitInvoice` refuses to write without its unique index). Set `INVOICE_LEDGER_WRITE=on` **first**, outside a scheduled slot (changing a property restarts the environment's processes). Then the backfill script's dry run, `--apply` with each category acknowledged, and a second run (it must create nothing), as in "Running the invoice backfill". Write comes first so nothing issued during the backfill is missed | The audit invariants hold for every workspace; counts match the dry run; the second run creates nothing | Set `INVOICE_LEDGER_WRITE=off`; run the script with `--undo`, which removes only backfilled invoices |
| 3. Shadow read | Set `INVOICE_LEDGER_READ=shadow`. The old answer is served; each difference is logged with a class | The agreed soak (a full week and a full statement cycle) with every difference in a known class, class counts matching the audit, and none unclassified | Set `INVOICE_LEDGER_READ=off` |
| 4. Switch | Set `INVOICE_LEDGER_READ=on`. **Statements change here**, as accepted. Watch the first scheduled run and the first statement after it | Statements and generator lists for workspaces whose numbers are known; the expected changes and nothing else | Set it back to `shadow` or `off`. The old stores are still complete because dual write continues |
| 5. Contract | A later release: stop writing the old log, remove the old read paths | Phase 4 stable for a full cycle | Redeploy the previous release. The old log is stale from here on, so this is the point of no easy return |

If `INVOICE_LEDGER_WRITE` is turned off after it has been on, invoices issued
while it was off exist only in the old stores: run the backfill again before turning
`INVOICE_LEDGER_READ` back on.

Environment flags are Elastic Beanstalk properties, set by hand. Changing one
restarts the environment's processes, so set them outside a scheduled slot.

What a flag change cannot undo: invoices already issued, PDFs already written,
emails already sent, and invoices already pushed to Xero. If the release touched
billing, list what was issued after each phase in the rollback note.

## Hotfix

A `hotfix/<TICKET>_<description>` branch is cut from `origin/main` and its PR
targets `main` ([`CLAUDE.md`](../CLAUDE.md)). It deploys the same way as a
release, so sections 3 to 5 apply (step 0 of section 3 only if the hotfix needs a migration), with section 1 shortened to: scope is the
hotfix commit only, CI green, a rollback target recorded. Because `main` and
`develop` have drifted, make sure the fix also reaches `develop`, or the next
release will undo it.

## To confirm

Fill these in and delete this list.

- The production MongoDB version. The KAN-292 backfill uses an update with an
  aggregation pipeline, which needs 4.2 or later and does not work on Amazon
  DocumentDB.
- Who sets up Google sign-in for production, and when a support admin will
  confirm it works. It gates the release.
- Whether SES, SQS and EventBridge will be set up for production at all in this
  release, or in a later stage.
- Whether the three hotfix commits on `main` (KAN-22 and KAN-28) are still
  needed in the form they were written, or have been superseded in `develop`.
- How the frontend is built and deployed to production, and how to roll it back.
- The production backend host and the production frontend host.
- How to take and restore a production database backup, and whether the production
  cluster has point-in-time recovery.
- Who supplies the production database copy for the rehearsal, how it is delivered
  (it contains real data), and who signs the rehearsal off. Not done until this has
  an owner.
- Who holds production AWS and database credentials, and how a migration is run
  against production in practice (from a laptop, a bastion, a CI job).
- Whether there is a release window, a change-approval step or a release note
  that has to be sent.
- Whether Elastic Beanstalk keeps every application version or prunes old ones
  (rollback depends on the previous version still existing).

### Notes for switching the readers (KAN-309, KAN-313)

* `INVOICE_LEDGER_READ=shadow` and `on` read the invoice record by `lines.itemId`: the
  `invoice-ledger-indexes` migration (index `invoice_line_item`) must be applied in that
  environment first, or those reads scan the collection.
* Shadow logs one line per difference class per list, export or statement, with a count and a few
  example ids. The classes marked unexpected (`legacy_only_invoice`, `total_differs`,
  `date_differs`, `payment_no_longer_applied`, `closing_differs`, `pdf_link_legacy_only`,
  `pdf_link_differs`, `list_invoiced_legacy_only`, `list_number_differs`, `list_link_differs`)
  are warnings and stop the switch; the rest are informational.
* With the read `on`, an item with a PDF row in the old log and no marker and no record still reads
  as invoiced (the guard stays until 4c). Run the marker backfill (after the invoice backfill) before switching the readers on anyway.
