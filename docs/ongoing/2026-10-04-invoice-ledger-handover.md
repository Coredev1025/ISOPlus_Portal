# Invoice ledger (KAN-302): handover

For whoever picks this up in a new session. Read this first, then the design. **Updated
with every PR in the series; if it disagrees with the code, the code wins and this
file is stale.** Delete when the work is merged and the old stores are retired.

Last updated: 2026-10-04 (evening, after PR 964 merged).

## What this is

An invoice's identity lives in three places that disagree (the item marker
`items.invoicedBy`, the document ledger `pdflinks`, the old per-item log
`invoicenumbers`). That is the root cause of KAN-296 (statement and generator show
different numbers) and KAN-297 (a payment dropped from a statement). The fix is one
`invoices` collection plus one writer (`issueInvoice()`) and one reader module
(`invoiceLedger`), rolled out behind two flags so behaviour does not change until they
are switched on.

* **Design (read this):** [`docs/superpowers/specs/2026-10-04-invoice-source-of-truth-design.md`](../superpowers/specs/2026-10-04-invoice-source-of-truth-design.md)
* **Production procedure:** [`docs/release-runbook.md`](../release-runbook.md): "Rehearsing on a copy of production", "Invoice ledger rollout", the audit queries, "Before enabling automation: backfill the item markers".
* **Findings from the production copy:** [`2026-10-04-prod-copy-rehearsal.md`](./2026-10-04-prod-copy-rehearsal.md)

## Decisions (Masoud, 2026-10-04)

* Build the **full ledger**, not a quick fix ("the best solution, not the quick and dirty one").
* D1 full ledger; D2 new `invoices` collection; D3 customer statements change at go-live is accepted; D4 re-invoicing (KAN-289) stays deferred, the model allows it; D5 leave stale log rows; D6 keep both invoices of a double-billed item; D7 the assistant runs the audit and backfill on the production copy; **D8 decided: an item with both a PDF and a Xero entry is one billing**.
* KAN-292 1000-counter businesses (83 of 95 in production) read as initialized after the migration: **accepted**, a support script resets one on request.
* D2, D3, D5, D6 and D7 were assumed from the design's recommendations when the user said to implement; flag it if any is wrong.
* Merge **one PR at a time**: build, independent review (a different model), green CI, merge, next.
* Target: release tomorrow evening (2026-10-05). The code and the prefill can be ready; the comparison period before switching reads on cannot be skipped, so the *switch* follows it. Say so to the client.

## The PR series

Every PR keeps behaviour identical until `INVOICE_LEDGER_WRITE` / `INVOICE_LEDGER_READ` are switched on. Each producer PR starts with a commit that characterizes that producer's current behaviour.

| # | Ticket / branch | What | State |
|---|---|---|---|
| 1 | KAN-303 (PR 964) | 59 tests in `Backend/test/characterization` pinning today's writes and reads, a lettered case list, a case-to-test table and the known gaps | **Merged** (3717ae13) |
| 2 | to create | `invoices` model, index migration, `invoiceLedger` reader, `issueInvoice()` writer, the two flags (not wired to anything) | Not started |
| 3 | to create | Producers onto `issueInvoice()`: scheduled runs; manual NDIS + webhooks; manual Age Care + Xero + draft push (`stampXero`) | Not started |
| 4 | to create | Readers onto `invoiceLedger` with READ off / shadow / on and the shadow comparator | Not started |
| 5 | to create | Marker backfill, invoice backfill (dry run, apply, undo, report), audit script, scrub script | Not started |
| 6 | to create | Dev fixtures write invoices, Playwright tests (including the row highlight and the "Invoiced" badge in the table and the pop-up), docs and runbook finalised | Not started |

Related docs-only PR: **961** (design, runbook, rehearsal notes, this handover).

## Rules for this work

* Test first; characterize before you move (the repo rule, [`docs/full-stack-engineering.md`](../full-stack-engineering.md)). Run the **whole** Backend suite before every push (`cd Backend && npx vitest run`).
* Cognitive complexity < 15 per function (CLAUDE.md). No unrequested refactors. No AI attribution anywhere, no em dashes, human commit messages.
* Never push to `develop` or `main`; branch `<type>/<TICKET>_<snake_case>`; PRs target `develop`.
* Jira: one ticket per PR; log time as a comment (rounded up to 15 minutes, with a warranty note); keep KAN-302 updated.
* Local Mongo has no transactions: the design relies on a claim, an explicit commit point and invariants, not on a database transaction.

## Local state on Masoud's machine (not in the repo)

* Progress and resume notes: `~/Documents/work/isoplus/ledger-build-progress.md` (the assistant's own checklist).
* **Production snapshot** (an Atlas download of 2026-10-03, MongoDB 8.0): `~/Documents/work/isoplus/prod-db-backup/` holds the `.tgz`, an `extracted/` copy, and `copy-premigration.archive.gz` (the scrubbed copy before the migrations). Outside the repo, and it must stay out.
* Containers: `prod-snap` (mongo:8 on the extracted files, no network) and `prod-copy-db` (mongo:8 on the `isoplus-net` network, database `isoplus-prod-copy`, scrubbed). Do not remove them until Masoud signs off the rehearsal; then `docker rm -f prod-snap prod-copy-db` and delete the files above.
* **Standing permission:** restore a fresh copy of the snapshot into a NEW local database whenever a test needs it, and run the app and tests against it, **offline** (`ISOPLUS_OFFLINE=1`, automation off, offline email), **scrubbed before anything connects** (Xero tokens, users, sessions, board hook secrets; verify with count queries), never copying, logging or using a credential from it, dropping the copy afterwards.
* Running migrations against a copy without tripping the "not local" guard: a one-off container that shares the copy's network, so the URI is `localhost`:
  `docker run --rm --network container:prod-copy-db -e MONGODB_URI=mongodb://localhost:27017/isoplus-prod-copy -e JWT_SECRET=x -e SESSION_SECRET=x -e NODE_ENV=development -v <repo>/Backend/migrations:/app/migrations:ro -v <repo>/Backend/scripts:/app/scripts:ro -v <repo>/Backend/src:/app/src:ro -v <repo>/Backend/migrate.json:/app/migrate.json:ro isoplus-portal-backend node scripts/migrate.mjs <list|up <bare-name> --single|down <bare-name> --single>`
* The Mac is kept awake with `caffeinate`; a session-only cron job re-prompts every 30 minutes (it dies when the session ends).

## Production facts that shape the work (snapshot of 2026-10-03)

* MongoDB **8.0** (local dev stack is 7.0). Database name `iso-plus`.
* 517,206 items, **none** with `invoicedBy`; `pdflinks` has 25 rows and none has an invoice number; `invoicenumbers` has 597 rows (374 PDF = 31 distinct invoices, all `(ISO+™)` suffixed; 223 Xero), and 446 of them were revisited after creation. No automation tables exist.
* So in production the old log is the **only** record of what was billed. The invoice prefill is built from it, and the item markers are backfilled from it before automation is enabled.
* 368 existing logged items have no marker: 149 PDF only, 16 Xero only, 203 both. Both scheduled paths already skip items with a PDF log row, so only the 16 Xero-only items are exposed today.

## Open items and what is waiting on people

* Google sign-in, `main` versus `develop` reconcile (three hotfix commits only on `main`, six conflicting files), and a confirmed production backup procedure all gate the real release (runbook "To confirm"). Not part of this series.
* The client was told the release is held until statements are fixed properly. Message drafts are in the conversation, not in the repo.
* KAN-296 and KAN-297 close when reads are switched on after the comparison period.

## How to resume

1. Read this file and the design. Check `gh pr list` for the series and `docs/ongoing/` for newer notes.
2. Pick the next row in the table. Create its Jira ticket and branch, characterize first, then build.
3. Update the table, the state lines and "Last updated" in this file in the PR you open.
