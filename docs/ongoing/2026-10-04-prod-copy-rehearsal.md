# Production copy rehearsal: first pass (2026-10-04)

Handover for work in flight. Delete when the rehearsal is signed off. Records what
was done, what was found, and what local state a successor needs. The procedure is
in [`docs/release-runbook.md`](../release-runbook.md) ("Rehearsing on a copy of
production"); the design is
[`2026-10-04-invoice-source-of-truth-design.md`](../superpowers/specs/2026-10-04-invoice-source-of-truth-design.md).

**No personal data is recorded here.** Only counts and workspace ids.

## What was done

* **Source.** An Atlas snapshot download of production, `Cluster0-2026-10-03T09-53-36.744Z.tgz`
  (345 MB, taken 2026-10-03 09:53 UTC), supplied by Masoud. Raw storage files, not a `mongodump`.
* **Opened** with a throwaway `mongo:8` container (`prod-snap`) with no network and no
  published port, on an extracted copy of the files. `mongo:7` refused it: the snapshot's
  feature compatibility version is 8.0. **Production is MongoDB 8.0.** The local dev
  stack runs 7.0.
* **Copied** the `iso-plus` database (228 MB; the cluster also holds Atlas sample databases,
  ignored) into a second container, `prod-copy-db` (`mongo:8`, on the `isoplus-net` network, no
  published port), as database `isoplus-prod-copy`. `sessions` and `logs` were left out.
  522,438 documents restored, 0 failed.
* **Scrubbed before anything connected to it**, and checked with count queries:
  `xeroTokens` unset on 28 businesses (0 left); 159 users anonymised (0 real-looking emails, 0
  passwords left); board `hookSecret` and `hookId` cleared (0 left). There are no
  `scheduledjobs`, `automationsettings`, `oauthtickets` or `xeroconnecttickets` in production.
* **Audited** read-only with the runbook's queries.
* **Migrations rehearsed** (second pass, same day): all seven pending migrations ran in order on
  the copy, each in well under a second (the largest collections they touch are `audittrails`,
  2,688 rows, and `pdflinks`, 25 rows). The `migrations` collection did not exist and all seven
  were pending, as expected. A pre-migration dump of the scrubbed copy
  (`prod-db-backup/copy-premigration.archive.gz`, outside the repo) was restored into a separate
  throwaway container; there every `down` ran newest first and removed exactly what it should
  (indexes gone, flag unset, item and ledger counts unchanged), and `up` ran again cleanly.
  The throwaway container is gone.
* **Not done yet:** no backfill exists to run; the application has not been started against the copy.

## What production holds

| Fact | Value |
|---|---|
| Items | 517,206; **none has `invoicedBy` or `invoicedAt`** |
| Businesses | 95, all with `documentNumbering`, none with `documentNumberingInitialized` |
| `pdflinks` | 25 rows (19 `NDIS Invoice`, 1 `Invoice`, 4 `Quote`, 1 `Purchase Order`), **none with an invoice number**, only the `_id` index |
| `invoicenumbers` | 597 rows: 374 `PDF` (31 distinct invoices, all `(ISO+™)` suffixed, all with a `pdfLink`, 352 of their items still exist) and 223 `Xero` (all `(Xero)`). 2025-12-22 to 2026-09-28 |
| Per workspace (PDF / Xero log rows) | 55369: 169 / 105. 55390: 199 / 101. 55397: 5 / 0. 55470: 1 / 17 |
| Automation tables, `migrations` collection | None exist |
| Items with synced `Generated Invoice Number` / `Generated NDIS Invoice Number` | 50 / 18 |

## Audit results on the copy

| Query | Result |
|---|---|
| 1. Markers with no ledger row | 0 (there are no markers) |
| 2. Log numbers with no marker and no ledger row | 31 numbers, all in workspace 55369, all suffixed (for example one number on 55 rows). **Not stale**: in production the log is the only record |
| 3. `pending:` tokens | 0 |
| 4. Items on more than one number in the ledger | 0 (the ledger has no numbers) |
| 5. Marker differs from the log | 0 (there are no markers) |
| 6. Logged items that exist and carry no marker | **368 items**: 149 PDF only, 16 Xero only (all 55470), 203 with both. The query's per-workspace, per-type counts are 55369 PDF 162, Xero 102; 55390 PDF 184, Xero 101; 55397 PDF 5; 55470 PDF 1, Xero 16 (an item with both types is counted once per type). 8 existing PDF-logged items were logged since 2026-08-28; the log filter already excludes them. 446 of the 597 log rows were updated more than a minute after creation |

## Findings that change the plan

1. **Markers should be backfilled before automation is enabled, but the exposure today is small.**
   Both scheduled paths already skip an item that has a `PDF` log row, because they list items
   with status `pending` and the log decides that. Only an item whose sole log row is `Xero`
   looks unbilled to the scheduler: 16 items on the copy, all in workspace 55470, logged 16 June
   to 2 July 2026, none since 28 August. The backfill is still needed, because the design
   removes the log filter from selection, after which all 368 existing logged items (149 PDF
   only, 16 Xero only, 203 both) would be exposed. Added to the runbook ("Before enabling
   automation: backfill the item markers") and the design (section 2.6).
2. **The old log is the primary source for the invoice prefill in production**, not stale
   data. The design's rule for unmatched log rows now distinguishes the two cases.
3. **Statements have nothing to read.** No ledger row has a number, so the new statement of
   account would list none of the 31 old invoices until they are prefilled.
4. **Production is MongoDB 8.0, local is 7.0.** The rehearsal copy runs on 8 for that reason.
   The runbook's open question about the production version is answered.
5. The unique-index migration (`pdflink-invoice-period`) will build without trouble:
   production has no `periodKey` on any row, so there are no duplicates to refuse on.
6. **DECIDED 2026-10-04 (Masoud): accepted as is.** A business that asks to choose its own starting numbers
   is updated by a small support script run for that workspace (to be written when the first request
   arrives: reset its counters and unset the flag). Nothing is changed in the migration or the runtime check.
   The finding, for the record: the KAN-292 backfill flags almost every production business as initialized, probably wrongly.
   It sets `documentNumberingInitialized: true` when any of the four user-set counters is not 1,
   on the assumption that a counter above 1 means documents were issued. In production the old
   default start was **1000**: 83 of 95 businesses hold invoice, PO, quote and statement-of-account
   counters of 1000, 1000, 1000 and 1 and have most likely issued nothing. After the migration
   they all read as initialized (93 flagged true, 2 false), so the first-numbers screen
   (KAN-292) is read-only for them and they cannot choose their own starting numbers. Ten
   businesses have values that suggest documents really were issued. **Decision needed** (not
   changed). **Changing only the migration would not unlock them**: the runtime check
   (`isDocumentNumberingInitialized`) also treats any counter other than 1 as initialized, and
   `uninitializedFilter` requires all four stored counters to equal 1. The old default of 1000 is
   what production (`main`) still has; commit 9594f76a (27 August 2026) changed it to 1 and is on
   `develop` only. So the decision must cover the runtime check as well, or have the migration
   reset those counters to 1 (a data change with its own `down`), or accept the lock. Rehearsal
   numbers: counters only 1 or 1000: 83; any other value: 10; all 1: 2.

## Local state to clean up when the rehearsal is signed off

* Containers `prod-snap` and `prod-copy-db` (`docker rm -f prod-snap prod-copy-db`).
* `~/Documents/work/isoplus/prod-db-backup/extracted/` (726 MB of extracted production
  files) and, last, the `.tgz` next to it. Both are outside the repo.
* The `mongo:8` image can stay or go.

## Next steps

1. Write the marker backfill, the invoice backfill and the scrub script as reviewed code, and run
   them on the copy.
3. Start the application against the copy (offline) and compare statements and generator lists
   old versus new for the production workspaces.
4. Take the Atlas snapshot or point-in-time restore for the real release backup; this copy is
   not it.
