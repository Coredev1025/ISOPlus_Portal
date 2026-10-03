# Production release runbook

How a change gets to production, what has to be done by hand around it, and how
to undo it. Written from `.github/workflows/cicd.yml`, `docs/migrations.md` and
`docs/scheduling.md`. Anything that could not be confirmed from the repository
is in "To confirm" at the end and marked **(to confirm)** where it appears: fill
those in rather than guessing.

Ticket: KAN-295. Branching, tickets and commit rules are in
[`CLAUDE.md`](../CLAUDE.md); this file does not repeat them.

## What a release is here

- **A push to `main` deploys the backend to production.** The `CICD` workflow
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
  which builds, tests and deploys the backend. The AWS steps only act when it is
  run on `main` (production) or `develop` (dev).
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

1. **Agree the scope.** `main` and `develop` have drifted: on 2026-10-04,
   `develop` was 525 commits ahead of `main` and `main` was 20 ahead of
   `develop`. Promoting `develop` ships everything in it, so look before you
   promote:

   ```bash
   git fetch origin
   git log --oneline origin/main..origin/develop     # what would ship
   git log --oneline origin/develop..origin/main     # what main has that develop lacks
   ```

   Read the second list: those commits must be understood before a merge
   overwrites or conflicts with them.
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
7. **Take a database backup or snapshot and note its time.** How is **(to
   confirm)**. A migration is effectively irreversible without one.
8. **Pick the time.** Avoid the scheduled automation slots of the workspaces that
   matter most, and avoid starting a deploy while a run is in flight. Slot times
   are per workspace in the `scheduledjobs` collection.
9. **Name who is doing it and who can roll it back.** Whoever holds the production
   database and AWS credentials is **(to confirm)**.
10. **Record the version currently running**, so rollback has a target:

    ```bash
    aws elasticbeanstalk describe-environments \
      --environment-names isoplus-be-prod-blue --region ap-southeast-2 \
      --query 'Environments[0].VersionLabel'
    ```

## 2. Migrations

Migrations are files in `Backend/migrations/`, run by hand with
`Backend/scripts/migrate.mjs`. Full detail in [`docs/migrations.md`](./migrations.md).
For a production release:

1. **Look at the data first.** A migration is a claim about what is stored.

   ```bash
   cd Backend
   MONGODB_URI='<production uri>' npm run schema -- <collection>
   ```

2. **See what has run and what is pending.** `list` works without the remote
   flag:

   ```bash
   MONGODB_URI='<production uri>' npm run migrate -- list
   ```

3. **Run it deliberately.** The wrapper refuses a database that does not look
   local unless you pass `--allow-remote`. Typing it is the point. Run from
   `Backend/` natively; the root `npm run migrate` execs into the local Docker
   container and would hit the local database, not production.

   ```bash
   MONGODB_URI='<production uri>' npm run migrate -- up <migration-name> --allow-remote
   ```

   Pass the bare name (`backfill-document-numbering-initialized`), not the file
   name. Do not write the connection string into a file or a commit, and clear it
   from your shell history afterwards.
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
| `backfill-document-numbering-initialized` | KAN-292 (PR #953) | After the backend deploy that includes KAN-292, and **before users start setting their first document numbers**. Safe at any time. Idempotent. | Stores every missing document numbering counter and prefix (older businesses lack `statementOfAccount` and `statement`) and the `documentNumberingInitialized` flag, so a stale `save()` cannot write defaults back over numbers the user chose. Never changes a value that is already there. The flag is true where any of invoice, purchase order, quote or statement of account has moved off 1, otherwise false. | Before and after: `npm run schema -- businesses`. Then in the database: `db.businesses.countDocuments({documentNumberingInitialized: {$exists: false}})` must be `0`, and `db.businesses.countDocuments({"documentNumbering.statementOfAccount.nextNumber": {$exists: false}})` must be `0` (same for `statement`, `invoice`, `purchaseOrder`, `quote`). Open Finance Settings for one workspace that has issued invoices: the number fields must be read-only. | `npm run migrate -- down backfill-document-numbering-initialized --allow-remote` removes the flag only. The backfilled counters equal what Mongoose would have supplied and stay. Without the flag the app still treats a business as set when any counter has moved. |

If this release also ships KAN-293 (PR #952): it needs no migration and no
environment change. See "After the deploy" for what to watch.

## 3. The deploy

1. Open a PR from `develop` to `main` (hotfixes go from `hotfix/...` to `main`,
   see "Hotfix"). Check the diff is the scope you agreed.
2. Merge. The `CICD` workflow starts on the push to `main`.
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
6. Run the migrations that belong after the deploy (section 2).

## 4. After the deploy

Do these before calling it done, and write down the result of each.

- **Health.** `GET /api/healthcheck` on the production backend host returns
  `{"status":"OK"}`. The production backend host is **(to confirm; the webhook
  documentation uses `portal-backend.isoplus.online`)**.
- **Boot warnings.** Check the deployment log for `Bootstrap:` warnings, in
  particular `SCHEDULER_API_KEY is not set`, which means no schedule will ever
  run and nothing else says so.
- **The scheduler is still ticking.** `SchedulerHealth.lastTickAt` keeps
  advancing. A stale value means the EventBridge rule or `SCHEDULER_API_KEY` is
  missing. See `docs/scheduling.md`, "What to alert on".
- **Sign in** and open a workspace: dashboard, a board, Finance Settings.
- **Errors.** Sentry and the in-app Application Logs show no new error class
  since the deploy.
- **The specific change.** Each change in the release has its own check. For
  KAN-292: a workspace that has issued documents shows read-only number fields,
  and a workspace whose counters are all 1 and whose flag is unset shows editable
  fields with examples. For KAN-293: after the first scheduled invoice run, the
  `AutomationRun` for a board with participants succeeded, the logs show no
  "multiple participant profiles detected", and any `Billable items left out: no
  Participant Profile` warning lists item ids worth a look.
- **Watch the next scheduled run** of a workspace you can verify, and the emails
  it sent, before leaving.

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
  redeploy the bad version.
- **A migration.** Run its `down` (the table says what each does). Check first
  that the older code can run against the migrated data, and the reverse.
- **What cannot be rolled back.** Documents already issued: invoice and statement
  numbers that were claimed, PDFs written to S3, emails already sent, invoices
  pushed to Xero. A bad release that runs the automation can create these. If the
  release touched billing, say so in the rollback note and list what was issued
  after the deploy.
- **The database.** Restoring from backup loses everything written since, so it is
  the last resort and a decision for more than one person.

## Hotfix

A `hotfix/<TICKET>_<description>` branch is cut from `origin/main` and its PR
targets `main` ([`CLAUDE.md`](../CLAUDE.md)). It deploys the same way as a
release, so sections 3 to 5 apply, with section 1 shortened to: scope is the
hotfix commit only, CI green, a rollback target recorded. Because `main` and
`develop` have drifted, make sure the fix also reaches `develop`, or the next
release will undo it.

## To confirm

Fill these in and delete this list.

- How the frontend is built and deployed to production, and how to roll it back.
- The production backend host and the production frontend host.
- How to take and restore a production database backup, and whether the Atlas
  cluster has point-in-time recovery.
- Who holds production AWS and database credentials, and how a migration is run
  against production in practice (from a laptop, a bastion, a CI job).
- Whether there is a release window, a change-approval step or a release note
  that has to be sent.
- Whether Elastic Beanstalk keeps every application version or prunes old ones
  (rollback depends on the previous version still existing).
