# Bringing the code back to the invoice-selection spec

**Spec:** [`docs/superpowers/specs/2026-08-20-invoice-item-selection-and-statements-design.md`](../superpowers/specs/2026-08-20-invoice-item-selection-and-statements-design.md)
**Date:** 2026-09-08
**Branch:** `feature/KAN-10_statement_of_account`

The client reports the statement he receives is still wrong. A section-by-section
audit of the spec against the code found nine departures. Two of them bill money
incorrectly today. This plan closes them in risk order.

## Global constraints

- **Every fix starts with a failing test** that reproduces the defect, run and
  seen to fail for the stated reason before any implementation.
- **No behaviour change beyond the spec.** Where the spec and the code disagree,
  the spec wins; where the spec is silent, the code stands.
- Cognitive complexity < 15 per file. Constants in `constants/<feature>.js` with
  touchpoint comments. No hardcoded `'Australia/Sydney'`.
- Backend suite green before each commit. This repo auto-deploys on merge.

## Task 1 — Xero routes never mark an item invoiced (double billing, live)

`Backend/src/routes/xero.js:125` declares a private `saveInvoiceNumber` that
writes the `InvoiceNumber` row and nothing else. The shared one in
`utils/invoicePdfSupport.js` also calls `claimItemsForInvoice`, which is what
sets `Item.invoicedBy`. The shared module is not imported by `routes/xero.js` at
all.

The private one is used directly at `:454` and injected as the
`saveInvoiceNumber` dependency at `:474`, `:957` and `:970`, so **every** Xero
invoice path leaves the item unmarked. Selection reads `invoicedBy`
(`utils/invoiceItemSelection.js:60`), so the next scheduled run selects that item
and bills it a second time.

Spec 3.3 exists precisely to prevent this. The docstring at
`utils/invoicePdfSupport.js:74-76` claims it already covers "the Xero routes"; it
does not, and a stale claim like that gets believed.

**Fix:** delete the private function, import the shared one, correct the
docstring. Note the signatures differ — the shared one takes a sixth `pdfLink`
argument and does its own `mongoEq` sanitising, so check each call site rather
than assuming they are interchangeable.

**Test first:** an integration test that runs a Xero invoice path and asserts
`Item.invoicedBy` is set. Every existing Xero handler test injects
`saveInvoiceNumber: vi.fn()` and asserts only that it was called, which is why
CI never saw this.

## Task 2 — The date OR is implemented on one leg only (under-billing)

Spec 2.1 includes an item when **either** of its two date fields falls in the
period. `utils/invoiceItemSelection.js` implements that correctly, but it can
only *subtract* from a list produced upstream, and the upstream filters are
single-field:

- NDIS, `utils/ndisInvoiceGeneratorRouteHelpers.js:233-238`, drops any item whose
  **Actual Shift Start** is absent or outside the service-delivery window.
- Age Care / SaH, `utils/invoiceGeneratorRouteHelpers.js:110-111`, filters on
  **actualEndDate** only.

So an NDIS **Cancelled** shift — which by 2.3 is dated by its *Scheduled* Shift
Start precisely because it has no actual start — is never listed, never selected
and never billed. Same for a SaH cancelled or adjustment row with no Actual Shift
End. The configuration table cannot rescue an item the list never returned.

**Fix:** make the service-delivery window match when *either* date field falls
inside it, for both listing paths.

**Blast radius: this changes which items get billed.** It should only ever add
items the spec says belong on the invoice. The failing test must pin both
directions — a cancelled shift now selected, and no previously-billed item
selected twice.

## Task 3 — Selection and rendering disagree on which date an item has

Spec 2.3 says reuse the manual date resolution. Selection does not: it OR-s both
fields unconditionally, while `computeNdisServiceDate`
(`utils/ndisMasterPlanLineHelpers.js:516-529`) and `resolveParticipantTaxRowDate`
(`utils/webhookParticipantTaxPdfHelpers.js:99-110`) pick **one** field by status
— NDIS Cancelled takes Scheduled, SaH `Delivered - To be claimed and invoiced.`
takes Actual End.

The two can disagree on a real item: an NDIS Cancelled shift whose Actual Start
is inside the period but whose Scheduled Start is outside is selected by
automation, then dated by the renderer to a day outside the billed period. The
invoice carries a service date the period does not cover.

`resolveParticipantTaxRowDate` is not even exported, so nothing can reuse it.

**Fix:** export the resolver, and have selection agree with it. Keep the OR as
the *membership* test the spec asks for in 2.1, and use the resolved date as the
one printed. Add a test that pins selection and rendering to the same date for a
cancelled shift.

## Task 4 — The manual path fails toward double billing

Spec 3.4: if the design forces a choice, prefer leaving items unbilled.
`utils/invoicePdfSupport.js:96-122` writes the `InvoiceNumber` row first, then
marks the item, and **swallows a marker failure with a warning**. That is the
"invoice written, marking fails" row of the spec's own table, whose consequence
is double billing.

The automated path already does it the right way round
(`utils/automationInvoiceClaim.js:78-131`): claim first with a `pending:` token,
generate, write the ledger, then rewrite the marker; release the claim on
failure, and deliberately keep the token if the ledger write fails.

**Fix:** invert the manual path to claim first, write the ledger second, release
the claim if the ledger write fails.

## Task 5 — A run that bills nothing says nothing

Spec 3.5 asks for the decision to be logged. `services/automation/generateDocuments.js:249`
and `:381` return on an empty selection with no log at all, while the other early
exits at `:184` and `:220` are logged — so the omission reads as accidental. A
period that correctly had nothing to bill is indistinguishable from one that
selected nothing because a status alias was missing. This is already a recorded
field trap: "a scheduled run that selects nothing closes Succeeded and is
completely silent".

**Fix:** one `info` line at each exit, naming workspace, board, period and the
reason.

## Task 6 — SaH boards whose status column is named differently select nothing

`constants/invoiceSelection.js:92-94` aliases `Job Status` and `Shift Status` but
not `Transaction Status`, which is the field 2.3 names for SaH. A board using
that spelling yields an empty status, and `invoiceItemSelection.js:73` returns
false for every item — the whole board bills nothing, silently. This is the same
failure that was already hit once on portal-dev ("listed 5, selected 0").

**Fix:** add the alias. One row in the table.

## Deferred, with reasons

- **Spec 2.7's "query"** — status, date and invoiced predicates run in JS over an
  id list rather than in Mongo. Functionally equivalent at current volumes and
  not a correctness defect. Revisit if the OR proves slow on real data, which 2.7
  itself asks someone to measure.
- **Spec 3.2(a) literal reading** — the unique constraint lives on `pdflinks`
  keyed by `itemId`, not on `invoicenumbers` keyed by participant. The
  implemented version is stricter and better; the real hole is that its partial
  filter excludes every row without a `periodKey`, which is all manual documents.
  Closing that is its own ticket with its own migration.
