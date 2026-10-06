# Characterization tests: invoice identity (KAN-303)

These tests record how an invoice's identity is written and read **today**, ahead of
KAN-302 (one source of truth for invoices). They pass against the code as it is. They
are not a statement that the behaviour is right: several of them pin accidents the
design removes, and those are named `KNOWN GAP`. When a later change alters one of them
on purpose, that change updates the test and says why in its PR. A red test here means
something moved that was not meant to.

Vocabulary, as in `docs/superpowers/specs/2026-10-04-invoice-source-of-truth-design.md`:
**marker** is `Item.invoicedBy`, **log** is the `InvoiceNumber` collection, **ledger** is
the `PDFLink` collection.

## The data-shape cases

The lettered cases used in the test headers and below (the same list as the KAN-303
ticket, in order):

| | Case |
|---|---|
| a | plain invoice number |
| b | legacy `(ISO+™)` suffix |
| c | `(Xero)` marker |
| d | marker with no ledger row and no log row (marker-only) |
| e | log row with no marker and no ledger row (log-only) |
| f | the same item with both a PDF and a Xero log row |
| g | one item (or one piece of work) on two invoice numbers (double billed) |
| h | ledger row with no number or total |
| i | log row overwritten by a later number |
| j | two different invoices sharing one number |
| k | item deleted by sync, log or ledger rows remain |
| l | `pending:` provisional claim |
| m | Low Cat versus other Age Care totals |
| n | legacy versus 2026 NDIS pricing |
| o | concurrent manual claims for one participant |

## Which test pins which case

| File | What it pins | Cases |
|---|---|---|
| `invoiceIdentity.writes.test.js` | `saveInvoiceNumber`: the log row is overwritten by a later number while the marker keeps the first; PDF and Xero on one item in both orders; one log row per item, board and type | c, f, g, i |
| `invoiceIdentity.statement.test.js` | The statement joins invoices to payments by exact string: suffixed, Xero and `pending:` markers leave payments unmatched; two documents for the same work; a ledger row with no number; the production shape (no numbers, no totals) lists nothing | b, c, d, g, h, l |
| `invoiceIdentity.ndisList.test.js` | The NDIS Invoice Generator list reads "invoiced", number and link from the log alone and ignores the marker; the scheduled run's `pending` status as a first guard, with Xero-only and marker-only items slipping past it | b, c, d, e, g, h, i, l |
| `invoiceIdentity.pdfLink.test.js` | The pdf-link lookup reads the log (PDF) only, appends the suffix on a miss, never strips it, and cannot see a ledger-only or marker-only invoice | b, c, d, e, g, i, j, k |
| `invoiceIdentity.scheduledRun.test.js` | A scheduled NDIS run: the three stores after the happy path; the state after a failed marker rewrite, a partial ledger write and a failed log write | happy path, failure windows (design section 2.3) |
| `invoiceIdentity.ageCareRun.test.js` | Scheduled Age Care and NDIS runs end to end on the Care Management fixture: all three stores agree, exact billed totals, Low Cat versus standard, legacy versus 2026 NDIS pricing, replay, the participant-profile guard, the log guard | a, m, n, KAN-293 |

## Not pinned here, and why

* **f** (PDF and Xero on one item) is pinned at the write level only. No reader test has a
  mixed-type item beyond what `ndisList` and `pdfLink` cover.
* **o** (concurrent manual claims): the manual generators are not pinned in this PR, and the
  scheduled path claims through a conditional update. Pinned in the producer PR that moves
  the manual generators.
* **j** on the statement side is pinned in `test/unit/utils/statementLedger.test.js` (two
  invoices with one number), not repeated here.
* The manual NDIS generator, the `/invoicendis` and `/invoice` webhooks, manual Age Care,
  the Xero routes and the Xero draft push: each gets its own characterization commit at
  the start of the PR that moves it onto `issueInvoice()`, so the pins are written against
  the code that is about to change.
* The CSV exports are covered by `test/unit/utils/exportOptimized*.test.js` and move with
  the reader PR.

## Known gaps these tests make visible

Each is named `KNOWN GAP` in the test. None is changed by this PR.

1. A failed marker rewrite leaves items `pending:` for good (nothing finishes it; only the hourly alarm reports it).
2. A partial ledger write leaves the claim pending, the log complete and the ledger partial.
3. A failed log write lets the run succeed, after which the generator list shows the items as billable and the pdf-link lookup cannot find the invoice.
4. A ledger row with a total but no number becomes a charge no payment can settle.
5. Two different invoices sharing a number resolve arbitrarily in the pdf-link lookup.
6. A zero-value row of a participant with other billable items is marked invoiced with that participant's invoice.
