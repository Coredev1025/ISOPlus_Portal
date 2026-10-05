# Release rehearsal: an automated regression run on production data

Status: **in progress** (KAN-316, 2026-10-05). Agreed by the owner (who runs it, on the owner's Mac, a copy of the production database is handed to other developers). Stages 0 to 3 are built and run; stages 4 to 8 are not. The plan below is the target; the build order is at the end.

## How to run it (stages 0 to 3)

Needs Docker, and the backend image built from this checkout: `npm run dev:build` (in a worktree
it is `<COMPOSE_PROJECT_NAME>-backend`; the run refuses an image whose `package-lock.json`
differs from `Backend/package-lock.json`). The production snapshot comes
from the owner (a copy of the Atlas download); keep it outside the repo.

```bash
# 1. Atlas snapshot download (.tgz, or the extracted folder) to a dump archive. Once per snapshot.
npm run rehearse -- prepare --input ~/path/Cluster0-....tgz --out ~/path/prod.archive.gz --db iso-plus   # production's database name; the download also holds sample databases

# 2. The rehearsal: restore, scrub, migrate, backfill, audit, second run, undo, compare.
npm run rehearse -- run --archive ~/path/prod.archive.gz --source-db <database name printed by prepare>

# A different snapshot has different numbers: write a draft expectations file to review and commit.
npm run rehearse -- run --archive ... --source-db ... --learn

npm run rehearse -- down     # remove the throwaway MongoDB and prepare containers if a run was interrupted
```

It prints one line per stage and ends with a pass or fail; the full report (JSON, mode 0600) is
written under `~/isoplus-rehearsal-runs/`. A run uses a throwaway MongoDB container on an internal Docker network (no published port and
no route out, which also isolates the Backend scripts that share it), and removes the container,
its volumes (they hold the dump as restored, before the scrub) and the network at the end,
unless `--keep` is given, and also if the run crashes or is stopped with Ctrl-C. `--keep` is
ignored, with a message, when the run stops before the scrub has finished: an unscrubbed copy
is never left running. `prepare` likewise removes its container and extracted files on a
failure or Ctrl-C. `--out` is the archive file for `prepare`
but a report directory for `run`. `--source-db` is required for `run`. An already extracted
snapshot folder is opened read-write by `mongod`: copy it first.
Stage 1 applies the pending migrations one at a time (`up <name> --single`, oldest first, as
the runbook does) and records each one's seconds under `migrations.timings` in the report.
The expectations are in `scripts/rehearse/expectations.2026-10-03.json`, each with its reason;
a drift is printed with that reason. A backfill reason or category, or an audit violation
category, that no expectation names fails the run as a new one to explain. A `--learn` draft
for a fresh snapshot is reviewed and signed off by the release owner before it is committed. On the 2026-10-03 snapshot a run takes about 25 seconds.
The logic that needs no Docker is unit tested (`npm run test:scripts`).

## The redacted copy (safe to share)

The raw production dump must not be passed around. Make a redacted copy once and share that:

```bash
npm run rehearse -- redact --archive ~/path/prod.archive.gz --source-db iso-plus --out ~/path/prod-redacted.archive.gz
npm run rehearse -- run --archive ~/path/prod-redacted.archive.gz --source-db isoplus-redacted   # the rehearsal on it
```

`redact` restores into the throwaway MongoDB, runs `scripts/rehearse/scrub.js` (tokens, sessions, hook
secrets, OAuth tickets, users, enabled schedules) and then `scripts/rehearse/redact.js`:

* Names, phone numbers, addresses, ABNs, bank details and identifiers of participants, their billing
  contacts, workers and businesses become deterministic pseudonyms: **the same original always gives the
  same replacement in every collection**, so a participant keeps one name across items, document rows and
  logs and statements still match by name. Business and Xero organisation names, addresses and contact
  details are replaced too. Free-text notes and care notes, attachments, photos and document links are
  replaced or cleared.
* **Emails that the operations tests must receive are the owner's plus-addresses**: a participant's
  email becomes `masoud+participant@isoconsultingservices.com.au`, a billing email
  `masoud+billing@isoconsultingservices.com.au`, a business email `masoud@isoconsultingservices.com.au`,
  so each message identifies its recipient and purpose. Set the copy and reply-to addresses of the
  workspace under test to `masoud+cc@` and `masoud+replyto@` in its automation settings. Every other
  email becomes a random `user<hash>@example.com`; no other `isoconsultingservices.com.au` address survives.
* **Proof, not trust:** every original value that is replaced is recorded, and the command exports every
  collection of the redacted copy and searches it for each recorded email, phone, address, identifier,
  person name and business name. If any survives it fails and writes nothing. The numbers in
  `expectations.2026-10-03.json` hold on the redacted copy (the pseudonyms are consistent), which is
  checked by running the rehearsal on it.
* **What it cannot promise:** personal data in a place no rule names (for example a name typed into
  a free-text field that is not on the replaced list, or a name that was never recorded as a name). The
  proof covers every value the script replaced, not every value in the data. Treat the redacted copy
  as sensitive until a person has read it, share it only inside the team, and report anything found so
  the script can be extended. A user collection is removed entirely (sign in with `npm run dev:login`).

The finished copies are kept in the private repository `ISO-Consulting-Services/isoplus-portal-prod-redacted-db`
(naming convention, how to make one, and `HOW-TO-TEST-APP.md`: restore a copy into an isolated worktree, run the
release steps, turn the ledger on and walk the app). Use that guide to test new code on real shapes of data.

What the run does not do yet: the `down` of each migration on a separate restore, the read
comparison with the ledger flags off, shadow and on (stage 4), the booted app and end-to-end
tests (5), the writers on real shapes (6), the rollback rehearsal (7) and the committed report (8).

## Why

Merging to `main` deploys the backend to production, and migrations and backfills are run
by a person, not by the deploy. Dev data is small and damaged differently from production,
so the only trustworthy check is a rehearsal of the **whole release** on a restored copy of
production: same database version, same volumes, same scripts, same order as
[`docs/release-runbook.md`](../release-runbook.md). Until now that was done by hand with
throwaway shell helpers. Repeating it by hand for every release candidate is slow, easy to
get wrong, and expensive in assistant time. The aim is one command that does it, ends in a
pass or fail with a short report, and can be re-run on every release candidate.

## Principles

1. **Deterministic scripts run the rehearsal, not a conversation.** The harness is plain
   Node under `scripts/` (the repo rule: no shell scripts, no platform-specific binaries). An
   assistant is used to *write* it and to *interpret a failure*, never to push buttons.
2. **Fresh restore every run, throwaway databases.** The rehearsal never reuses a dirty
   database; it restores the snapshot into a new one, so a pass means "from the real data,
   from scratch".
3. **Exactly the runbook.** The harness calls the same `npm run migrate`, `invoice-backfill`,
   `invoice-marker-backfill`, `invoice-audit` commands with the same flags an operator would
   (plan hash, acknowledgements), in the runbook's order. If the runbook changes, the harness
   changes in the same pull request.
4. **Expectations are data, committed.** What a good run looks like (counts, categories, the
   audit's known findings, the money total) lives in a committed expectations file with a
   reason next to each number. A drift is a failure to explain, not a number to update
   silently. The file is reviewed like code.
5. **Offline and scrubbed.** No egress (ISO+, Xero, S3, SES): run the containers on a network
   with no outbound route and assert it. Scrub tokens, users, sessions and hook secrets
   before anything connects, and verify with count queries. The copy stays outside the repo
   and is deleted at sign-off (handling rules in the runbook).
6. **Fail fast, report short.** The run stops at the first stage that breaks, writes full
   detail to a file, and prints at most a few dozen lines. The report is machine-readable
   (JSON) with a one-page summary.
7. **Runs on a trusted machine, never in public CI.** Production data must not enter shared
   CI. CI keeps running the Backend and Frontend suites; the rehearsal runs on the release
   owner's machine, or a locked-down runner the company controls, and is a gate on the
   release checklist.

## The stages

Each stage has a pass condition. A failed stage stops the run.

0. **Restore and scrub.** Restore the snapshot into `isoplus-rehearsal-<run id>` on MongoDB
   8.0 (production's version). Scrub. Record the baseline: collection counts, `dbHash` of the
   old stores, and the invariants. *Pass:* counts match the snapshot manifest; scrub checks
   return zero.
1. **Migrations.** `migrate list`, then up in order with timings, then each `down` on a
   separate throwaway restore (newest first) and up again. *Pass:* all apply, all roll back,
   durations recorded for the maintenance window.
2. **Backfill replay.** Dry run, compare the plan to the expectations file (invoice counts by
   reason, every category and its count, plan hash recorded); apply with exactly those
   acknowledgements; marker backfill the same way. *Pass:* the plan equals the expectations;
   the audit shows only the known findings; query 6 returns 0.
3. **Idempotence and undo.** A second run creates and marks nothing; undo (markers, then
   invoices) returns the old collections to the baseline hash exactly.
4. **Read comparison, ledger flags off, shadow, on.** For every participant with a backfilled
   invoice, generate the statement in each mode; for every board, call the list, both CSV
   exports and the pdf-link lookup in each mode. *Pass:* shadow reports only the expected
   difference classes (counts equal to the expectations); `on` totals equal the sum of the
   invoice totals; every difference between `off` and `on` is in a committed allow-list with a
   reason (for example the D9 label change), anything else fails.
5. **Application boot and end to end.** Boot the backend and frontend offline against the
   copy, sign in through the one-time ticket, run the Playwright suites (KAN-10, KAN-11 and
   the ledger spec) once with the reads off and once with them on. *Pass:* all green.
6. **Writers on real shapes.** With the write flag on, run the scheduled and manual producers
   for a designated test workspace against the copy with the outbound services stubbed (the
   repo already has msw mocks). *Pass:* each produces its invoice record, the audit stays
   clean, a replay creates nothing.
7. **Rollback rehearsal.** Flags off, backfills undone, migration down: hash identical to the
   baseline.
8. **Report.** One JSON file and a one-page summary: stage results, timings, expectation
   diffs, the production-copy facts used. Committed (without data) to `docs/ongoing/` for
   the release record.

Stages 0 to 4 and 7 are pure database work and take minutes. Stage 5 is the slow one and is
the only one that needs a browser. Stage 6 needs the most new test code.

## Using AI tokens efficiently

* **No separate agents are needed to run tests.** A script run costs the same whether an
  assistant or a person starts it, and the harness does the work. Spawning agents to "run" a
  stage only adds the cost of loading context into each of them.
* **Run it in the background and read only the summary.** Start the harness as one background
  command and wait for its completion notice; do not poll or tail logs. The assistant reads
  the short report, and opens a detail file only for a failing stage.
* **Cache the expensive parts.** Keep the restored, scrubbed, migrated baseline as a dump
  archive and restore from it for stages 2 to 7, instead of repeating the restore and the
  migrations each time. Re-restore from the raw snapshot only for a release candidate.
* **Use agents where they add something:** an independent review of a change before it is
  merged (a different model has no stake in the code), and triage of a failing stage when the
  cause is not obvious. Both are bounded, read-only jobs with a clear question.
* **Keep the context small between sessions.** The handover and the runbook are the memory.
  A new session reads those two files, not the history.

## What was agreed to start (KAN-316)

* The snapshot and its handling rules are agreed (the Atlas download of 2026-10-03 is
  the current one; a fresh snapshot is taken for the release candidate).
* The expectations file is agreed with the product owner: the numbers in the 2026-10-05
  rehearsal (55 invoices over 302 items; 200 items on a later Xero invoice; 368 markers;
  the same 66 audit findings; the statements totalling the same money) are the starting
  point, each with its reason.
* Where it runs, and who owns it: on the release owner's Mac, run by the release owner.

## Build order (each its own pull request, test first)

1. **Harness skeleton** in Node: restore, scrub, baseline, report writer. **Done** (KAN-316, with
   `prepare`). The no-egress assertion is still to do. Replaces the shell helpers used so far.
2. **Runbook replay** (stages 1 to 3) and the expectations file. **Done** (undo is tested on the
   same database and then re-applied; the migration `down` tests are still to do).
3. **Read comparison** (stage 4), with the allow-list.
4. **Application boot and end to end** (stage 5), reusing the worktree-stack recipe.
5. **Writers on real shapes** (stage 6) and **rollback** (stage 7).
6. **Report and release checklist hook**; the runbook points at the one command.

Open questions: the real size of stage 6 (how many producers can run fully offline), whether
a locked-down runner is worth setting up, and how often a fresh snapshot is needed.
