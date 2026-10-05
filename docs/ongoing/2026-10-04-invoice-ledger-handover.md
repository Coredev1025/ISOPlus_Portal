# Invoice ledger (KAN-302): handover

For whoever picks this up in a new session. Read this first, then the design. **Updated
with every PR in the series; if it disagrees with the code, the code wins and this
file is stale.** Delete when the work is merged and the old stores are retired.

Last updated: 2026-10-05 (midday): every step of the series is merged (KAN-303 to 315); 4c is deliberately deferred. What is left is the release itself: an automated rehearsal on production data (plan: [`docs/roadmap/release-rehearsal.md`](../roadmap/release-rehearsal.md), KAN-316), then the shadow comparison period, then the decisions and people listed under "Open items".

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
* D1 full ledger; D2 new `invoices` collection; D3 customer statements change at go-live is accepted; D4 re-invoicing (KAN-289) stays deferred, the model allows it; D5 leave stale log rows; D6 keep both invoices of a double-billed item; D7 the assistant runs the audit and backfill on the production copy; **D8 decided: an item with both a PDF and a Xero entry is one billing**; **D9 (KAN-315): for each item the later of its PDF and Xero timestamps is the current invoice** (a strictly later Xero row makes the item a Xero invoice, otherwise D8 stands).
* KAN-292 1000-counter businesses (83 of 95 in production) read as initialized after the migration: **accepted**, a support script resets one on request.
* D2, D3, D5, D6 and D7 were assumed from the design's recommendations when the user said to implement; flag it if any is wrong.
* Merge **one PR at a time**: build, independent review (a different model), green CI, merge, next.
* Target: release tomorrow evening (2026-10-05). The code and the prefill can be ready; the comparison period before switching reads on cannot be skipped, so the *switch* follows it. Say so to the client.

## The PR series

Every PR keeps behaviour identical until `INVOICE_LEDGER_WRITE` / `INVOICE_LEDGER_READ` are switched on. Each producer PR starts with a commit that characterizes that producer's current behaviour.

| # | Ticket / branch | What | State |
|---|---|---|---|
| 1 | KAN-303 (PR 964) | 59 tests in `Backend/test/characterization` pinning today's writes and reads, a lettered case list, a case-to-test table and the known gaps | **Merged** (3717ae13) |
| 2 | KAN-304 (PR 965, merged f198a82d) | `invoices` model, index migration `1791102300000-invoice-ledger-indexes`, `invoiceLedger` reader (`utils/invoiceLedger/read.js`), `issueInvoice()`/`commitInvoice()`/`repairInvoice()` (`issue.js`), the two flags (`flags.js`), number parsing (`numbers.js`), the invariant audit (`audit.js`), per-attempt claim token. Not wired to any producer or reader yet | **Merged** |
| 3a | KAN-305 `feature/KAN-305_scheduled_runs_issue_invoice` | Scheduled NDIS and Age Care runs call `issueInvoice()` (`generateDocuments.js`), with line amounts from the selected rows (`utils/invoiceLedger/lineAmounts.js`). Flag off: unchanged; flag on: an `invoices` record per invoice, ledger rows linked, items pointed at it | Merged (PR 966) |
| 3b | KAN-306 `feature/KAN-306_manual_ndis_and_webhooks_issue_invoice` | Manual NDIS generator route, `/invoicendis` and `/invoice` webhooks write the invoice record through `recordIssuedInvoice()` (`utils/invoiceLedger/issue.js`), behind the write flag. These producers generate the document first and claim per item afterwards, so there is no claim for `issueInvoice` to wrap: the record is added after their own writes, never throws, and points only items whose marker already names the invoice. Generator returns `lineAmounts` from the rows it printed. New invoice kind `job` for the `/invoice` webhook. Dates come from the operator's original UTC values | Merged (PR 967) |
| 3c | KAN-307 `feature/KAN-307_manual_age_care_and_xero_issue_invoice` | Manual Age Care route (`/invoiceparticipanttax`, `utils/webhookParticipantTaxPdfHelpers.js`) writes the invoice record through `recordIssuedInvoice()`, behind the write flag. `buildParticipantTaxOrders` also returns `lineAmounts` (contribution, or full amount on Low Cat) from the same values the rows print. This route writes no ledger row today, so the statement still cannot see these invoices until the readers move | Merged (PR 968) |
| 3d | KAN-308 `feature/KAN-308_xero_routes_and_draft_push_issue_invoice` | The four Xero producers (`/invoice` job in `routes/xero.js`; `/invoicendis`, the Invoice Generator and the participant tax route in `utils/xeroNdisRouteHandlers.js`) call `recordXeroInvoice()` (`utils/invoiceLedger/recordXero.js`) after their own writes, behind the write flag. Items already on one portal invoice that lists them all: the Xero number is attached to it with `stampXero` (D8), nothing new is billed. Items on several portal invoices, or only some of one: nothing recorded, warned (`xero-spans-invoices`). Items marked as billed by an invoice the ledger does not hold yet: nothing recorded (`xero-on-unrecorded-invoice`; backfill places them). A portal invoice already carrying a different Xero number is not overwritten (`xero-already-attached`). Items on none: a Xero-source invoice (number plain, legacy `(Xero)` form). The scheduled draft push calls the same handlers, so it stamps with no code of its own. Participant for Age Care is the person billed for, not the billing contact | Merged (PR 969) |
| 4a | KAN-309 `feature/KAN-309_statement_reads_invoice_ledger` | The statement of account reads the invoice record behind `INVOICE_LEDGER_READ`. `off`: the old stores, unchanged. `shadow`: the old answer is served and every difference from the invoice record is logged as `Shadow difference` with a class (`ledger_only_invoice`, `payment_newly_applied`, `unapplied_payment`, `duplicate_number`, `due_date_differs` are the expected ones and log at info; `legacy_only_invoice`, `total_differs`, `date_differs`, `payment_no_longer_applied`, `closing_differs` are unexpected, log as warnings and stop the switch; a `Shadow summary` info line per participant gives both closing balances). `on`: the invoice record, payments matched by item through the invoice's lines, not by the text of a number. New: `utils/invoiceLedger/{statementSource,shadow}.js`. Not in this PR: the printed "unapplied payments" line (they are still only logged, as today) | Merged (PR 970) |
| 4b | KAN-313 `feature/KAN-313_pdf_link_and_generator_lists_read_ledger` | The pdf-link lookup (`utils/invoiceLedger/pdfLinkLookup.js`), the NDIS and Age Care Invoice Generator lists and the two CSV exports (`utils/invoiceLedger/listMaps.js`, one reader that gives both builders their item-to-number and item-to-link maps) on `INVOICE_LEDGER_READ`. `off`: the old log, exactly as before (the Age Care CSV still reads rows of every type). `shadow`: old answer served; differences logged (`pdf_link_ledger_only`, `list_invoiced_ledger_only` expected; `pdf_link_legacy_only`, `pdf_link_differs`, `list_invoiced_legacy_only`, `list_number_differs`, `list_link_differs` unexpected). `on`: the invoice record; an item on any issued invoice (Xero-only included) or carrying a real marker with no record reads as invoiced; the pdf-link resolves every form of a number on its board. Response shapes unchanged. `test/setup.js` now clears both flags before every test | Merged (PR 974) |
| 4c | to create | Scheduled selection: drop the old log guard (only after the marker backfill) | Deferred: see below |
| 5a | KAN-310 `feature/KAN-310_invoice_backfill_planner` | The invoice backfill **planner**, pure (`utils/invoiceLedger/backfill/*.js`, `planBackfill`): turns the three old stores into the invoices the new record should hold by design section 6 rules 1 to 9, with the report (marker-only, log-only, xero-only, duplicate-number, double-billed, xero-spans-invoices, stale-legacy, unplaceable with the reason, pending tokens, deleted items and documents, marker-missing). Inputs and outputs are in the header of `plan.js`. Reads nothing, writes nothing. Not yet: the loader, the real `deriveTotal` (the generators' own functions), the applier, `--undo`, the `--ack` gate and the script | Merged (PR 971) |
| 5b | KAN-311 `feature/KAN-311_invoice_backfill_script` | The runnable backfill: `backfill/loader.js` (reads one workspace's old stores, only the items an invoice mentions), `deriveTotal.js` (the generators' own functions, pinned by a test against real generated NDIS legacy, NDIS 2026, Age Care and Low Cat invoices; `getNdisInvoiceGeneratorContextFromMasterItems` gained `skipApprovalCheck`, default off), `apply.js` (idempotent, additive, validates everything before writing, needs the unique index) and `undoBackfill`, `acks.js` (the `--ack category=count` gate), `run.js`, `cli.js`. Scripts: `npm run invoice-backfill` (dry run by default; `--apply --ack ...`; `--undo`; refuses a non-local database without `--allow-remote`) and `npm run invoice-audit` (read only, exits 1 on a violation), both from `Backend/` | Merged (PR 972) |
| 5c | KAN-312 `feature/KAN-312_marker_backfill_from_log` | The marker backfill: `npm run invoice-marker-backfill` (`utils/invoiceLedger/markers/*`, `scripts/invoice-marker-backfill.mjs`). Sets `invoicedBy` to the logged number as stored and `invoicedAt` to the log row date on logged items with no marker, never overwriting one (the write is conditional); PDF number preferred over Xero (D8); `invoicedPeriodKey = backfill-from-log` marks what it set so `--undo` (preview until `--apply`) clears exactly that. Dry run default, plan hash, per-workspace re-plan. Rehearsed on the production copy: 368 items, query 6 empty, undo exact | Merged (PR 973) |
| 5d | KAN-315 `feature/KAN-315_latest_invoice_wins_per_item` | Decision D9: per item the later of the PDF and Xero timestamps is the current invoice. Marker backfill takes the later row; the invoice backfill puts an item whose Xero row is strictly later on a `xero-later` Xero invoice and not on the portal invoice; new report categories `supersededByXero` and `supersededPortalInvoices`. Rehearsed on the production copy (55 invoices, 200 items superseded, money unchanged). | Merged (PR 979) |
| 6 | to create | Dev fixtures write invoices, Playwright tests (including the row highlight and the "Invoiced" badge in the table and the pop-up), docs and runbook finalised | Merged (KAN-314, PRs 975 and 976) |

Related docs-only PR: **961** (design, runbook, rehearsal notes, this handover).

## Wiring notes for the next producers (3c and after)

* Scheduled producers use `issueInvoice()` (claim first). Manual producers generate the document first and claim per item afterwards (`saveInvoiceNumber`), so they call `recordIssuedInvoice()` after their own writes. It never throws and does nothing with the flag off.
* Pass the operator's original UTC date strings, not the zone-stripped ones the handlers build for the PDF (a zoneless string reads differently per server timezone).
* Line amounts must come from the rows the document printed (the generators), keyed by the id the marker uses. Scheduled runs still use the list rows (known gap, `commitInvoice` warns on mismatch).
* The `/invoice` webhook is kind `job` (billed to a client). Its ledger rows carry no invoice number, so they are never linked by `invoiceId`; the audit and backfill must treat `job` explicitly.
* The write flag needs the `invoice-ledger-indexes` migration first. Backfill must run before `INVOICE_LEDGER_READ` is switched on, or an item whose earlier invoice has no record can show a re-posted duplicate as active.
* Placeholder participant names (`Participant`, `Client`) differ from the empty string the old ledger rows carry; the shadow comparator will report that as a known difference.
* Concurrent manual claims for one participant (case o) are still open; fix with per-attempt tokens when manual producers move onto a claim-first flow.

## Rules for this work

* Test first; characterize before you move (the repo rule, [`docs/full-stack-engineering.md`](../full-stack-engineering.md)). Run the **whole** Backend suite before every push (`cd Backend && npx vitest run`).
* Cognitive complexity < 15 per function (CLAUDE.md). No unrequested refactors. No AI attribution anywhere, no em dashes, human commit messages.
* Never push to `develop` or `main`; branch `<type>/<TICKET>_<snake_case>`; PRs target `develop`.
* Jira: one ticket per PR; log time as a comment (with a warranty note); keep KAN-302 updated.
* Local Mongo has no transactions: the design relies on a claim, an explicit commit point and invariants, not on a database transaction.

## Local state on Masoud's machine (not in the repo)

* Progress and resume notes: `~/Documents/work/isoplus/ledger-build-progress.md` (the assistant's own checklist).
* **Production snapshot** (an Atlas download of 2026-10-03, MongoDB 8.0): `~/Documents/work/isoplus/prod-db-backup/` holds the `.tgz`, an `extracted/` copy, and `copy-premigration.archive.gz` (the scrubbed copy before the migrations). Outside the repo, and it must stay out.
* Containers: `prod-snap` (mongo:8 on the extracted files, no network) and `prod-copy-db` (mongo:8 on the `isoplus-net` network). Databases in `prod-copy-db`: `isoplus-prod-copy` (scrubbed, before the migrations) and `isoplus-rehearsal` (scrubbed, the eight migrations applied, **no backfill applied**: the baseline for every rehearsal run). Also `reh-redis`, and two leftover backend containers `reh-off` and `reh-on` from the real-app check (old code; remove them). Do not remove the rest until Masoud signs off the rehearsal; then `docker rm -f prod-snap prod-copy-db reh-redis reh-off reh-on`, drop `isoplus-prod-copy` and `isoplus-rehearsal`, and delete the files above.
* The shell helpers used for the manual rehearsals (`reh.sh`, `hash.sh`, `reh-stmt.sh`, `stmt.mjs`) lived in a temporary directory and are gone with it. What they did: run a Backend script in a one-off container that shares `prod-copy-db`'s network (the `docker run` line below), compute `dbHash` of the old stores before and after to prove an undo, and generate a statement for every participant with an invoice in each read mode. They are replaced by `npm run rehearse` (`scripts/lib/rehearse.mjs`, `scripts/rehearse/`): see [`docs/roadmap/release-rehearsal.md`](../roadmap/release-rehearsal.md) for how to run it.
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
* **People to resolve:** the 8 invoices the backfill cannot place (66 items, listed by the audit as `markerWithoutInvoice`, the reasons are in the rehearsal note) need someone who knows the client's records to say what they are.
* **Customer-visible changes to announce with the switch:** statements change (D3); invoices keep their own due date, so ageing can differ; the NDIS CSV claim reference for a Xero-only or marker-only item is the stored number; and under D9 the number shown for an item that has both a portal and a Xero invoice is the later one (on the production copy 200 items change from the portal number to the Xero number, which also changes the Invoice Generator and the Age Care export).
* **Decision still open:** whether a live Xero push after go-live should follow D9 too (see "D9 follow-up" below).
* **Cleanup, after sign-off only:** the containers, databases and files under "Local state".

## Real-app check on the production copy (2026-10-05)

Backend run offline against a scrubbed copy with both backfills applied, once with `INVOICE_LEDGER_READ` unset and once with `on`, signed in through the one-time ticket. Across the 12 boards that have ledger invoices:

- NDIS invoice export (`invoice-csv-ndis`): identical, ignoring the `exportDurationMs` timing field.
- pdf-link for all 49 ledger invoices: same status either way (34 found, 15 not found).
- Age Care export (`invoice-csv`): 8 of 12 boards differ, 200 cells in total, every one `INV-N (Xero)` becoming `INV-N (ISO+™)`. These are the items that have both a PDF and a Xero row (decision D8): the portal number is shown and the Xero number is kept on the invoice. This is a customer-visible change to announce with D3 and the due-date/ageing change.

Step 6, part 1 (KAN-314): the dev fixture loader takes an `invoices` section (ledger rows, `--list`/`--remove` aware), `care-management-55390-full.json` carries the ledger rows for INV-1002/1003, and the e2e reset clears `invoices`. Part 2 adds `Frontend/e2e/invoice-ledger-invoiced-state.spec.ts` (list and pdf-link for the seeded invoiced item, passes with reads off and on). Not covered by e2e: the row highlight and Invoiced badge (the NDIS board renders from a list needing live ISO+ budget data offline) and the producers themselves (they call ISO+ / Xero); both stay covered by the Backend integration tests. This spec shares workspace 55390 with `care-management-automation.spec.ts`, whose reset deletes the workspace's invoice rows, so run them with one worker (`npm run e2e:automation` does). Running e2e needs the worktree's own stack with `GOOGLE_TARGET_GROUP` blank, `ISOPLUS_OFFLINE=1`, a placeholder `PERSONAL_ACCESS_TOKEN`.

Deferred: 4c (dropping the old-log filter from scheduled selection). It stays as a second guard until the contract phase; with reads on the log is still consulted as a fallback guard.

## D9 follow-up: the live Xero path

`recordXeroInvoice` (a Xero push for items already on a portal invoice) still follows D8: it attaches the Xero number to the portal invoice and never makes a second charge. The backfill (D9) treats a later Xero invoice as the current one. For data created after go-live the two rules can disagree for an item that has both. Decide whether a live Xero push should supersede the portal invoice for its items (it would need the same item-level move and a void of an emptied portal invoice) or stay as D8 until KAN-289 (re-invoicing) is decided.

## Practical notes from the build

* **Tickets:** KAN-302 (the epic, keep updated), KAN-303 characterization, KAN-304 model and writer, KAN-305 scheduled runs, KAN-306 manual NDIS and webhooks. 3c and later get their own. Jira transitions in project KAN: 11 To Do, 21 In Progress, 31 In Review, 41 Done, 42 Test failed.
* **Worktrees:** one per PR from `origin/develop`. A worktree has no `node_modules`; symlink the main checkout's `Backend/node_modules` to run tests, and **remove the symlink before `git add`**.
* **Full Backend suite takes about 5 minutes locally and 12 in CI.** Some tests fail now and then under load and pass alone: a `pdfLink.route` 401, `business.xero-mapping.route` "saves line-item mapping", `systemHealth.route` "enqueues a manual run", `workspace.automation-settings.route` "turning one block off". Re-run the single file before suspecting your change.
* **Complexity:** the gate is per function (< 15). `eslint-plugin-sonarjs` is not installed in the repo; install eslint 8 with sonarjs 0.25 in a scratch directory to score changed functions. `processWebhookNdisInvoicePdfItem` is at 14, so extract helpers before adding to it.
* **Timezones:** run date-sensitive tests under `TZ=UTC` as well as your local zone; production is UTC and a laptop is not.
* **Reviews:** each PR gets an independent review by a different model, then fixes, a full run, green CI, merge. Do not merge several PRs at once.
* **Production copy cleanup, only after the rehearsal is signed off:** `docker rm -f prod-snap prod-copy-db`, then delete `prod-db-backup/extracted`, `copy-premigration.archive.gz`, and last the `.tgz`. Until then do not remove them.
* **Do not bypass sandbox blocks.** If a command is refused, stop and ask the owner instead of finding another way. Never put a production connection string in chat or in the repo.

## How to resume

1. Read this file, the design, the runbook's "Invoice ledger rollout" section and [`docs/roadmap/release-rehearsal.md`](../roadmap/release-rehearsal.md). Check `gh pr list` and `docs/ongoing/` for newer notes.
2. The series is built. The next work is, in order: the release rehearsal harness (KAN-316 and its pull requests), the shadow comparison period on dev, then the decisions under "Open items". For any new change: create its Jira ticket and branch, test first, update this file in the same PR.
3. Update the table, the state lines and "Last updated" in this file in the PR you open.
