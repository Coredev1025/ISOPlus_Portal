# Release rehearsal: an automated regression run on production data

Status: **proposed** (KAN-316, 2026-10-05). Not built yet. This is the plan; the harness
comes in the pull requests listed at the end, one at a time.

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

## What would have to be true to start

* The snapshot and its handling rules are agreed (the Atlas download of 2026-10-03 is
  the current one; a fresh snapshot is taken for the release candidate).
* The expectations file is agreed with the product owner: the numbers in the 2026-10-05
  rehearsal (55 invoices over 302 items; 200 items on a later Xero invoice; 368 markers;
  the same 66 audit findings; the statements totalling the same money) are the starting
  point, each with its reason.
* Where it runs, and who owns it, is decided.

## Build order (each its own pull request, test first)

1. **Harness skeleton** in Node: restore, scrub, baseline, report writer, no-egress check.
   Replaces the shell helpers used so far (their commands are in the handover).
2. **Runbook replay** (stages 1 to 3) and the expectations file.
3. **Read comparison** (stage 4), with the allow-list.
4. **Application boot and end to end** (stage 5), reusing the worktree-stack recipe.
5. **Writers on real shapes** (stage 6) and **rollback** (stage 7).
6. **Report and release checklist hook**; the runbook points at the one command.

Open questions: the real size of stage 6 (how many producers can run fully offline), whether
a locked-down runner is worth setting up, and how often a fresh snapshot is needed.
