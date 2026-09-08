# ISO+ Portal — Invoice Item Selection and Statement Generation

**Status:** Implemented on `feature/KAN-10_statement_of_account`, with deviations — see [Changes since approval](#changes-since-approval)
**Related:** Epic 5 (scheduler), Epic 6 (delivery and monitoring)
**Last updated:** 20 August 2026

> Committed to the repo on 2026-09-08. It had lived outside it until then, while
> a dozen code comments cited "section 4 of the invoice selection spec" by
> number — so the authority those comments appeal to was unreadable to anyone
> holding only the repo. The text below is the specification as issued; where
> the implementation has since departed from it, that belongs in a "Changes
> since approval" section rather than an edit to the sections above.

## 1. Scope

In scope, two things.

**Item selection.** When a scheduled invoice run fires for a period of X days,
decide which items belong on the invoice. Five invoice types, each with its own
date fields and qualifying statuses.

**Statements.** A periodic summary of account activity: invoices raised,
payments received, balance owing, and how overdue it is.

**Out of scope.** Invoice layout, pricing, contribution calculation and totals.
Status filtering, already implemented. Manual invoicing, already implemented.
Scheduling, which is Epic 5. Document storage, covered as background in
`05-document-storage-notes.md`.

## 2. Item selection

### 2.1 The rule

For a run covering the period `[start, end]`, include an item when both hold:

- Either of its two date fields falls within the period
- Its status is one of the type's qualifying statuses

Date is an OR across two fields. Status is a membership test. Both must pass.

Some types share identical conditions. That is expected.

### 2.2 By invoice type

| Type | Date fields | Qualifying statuses |
|---|---|---|
| Care Management — NDIS — Certification | Shift Service Date **or** Shift Delivery Date | Completed, Cancelled |
| Care Management — NDIS — Verification | Shift Service Date **or** Shift Delivery Date | Completed, Cancelled |
| Care Management — SaH | Scheduled Service Date **or** Service Delivery Date | Cancelled - To be claimed and invoiced if applicable; Delivered - To be claimed and invoiced; Adjustment (Refund) - To be claimed and invoiced.; Adjustment (Charge) - To be claimed and invoiced. |
| Care Management — SaH — Low Cat | Scheduled Service Date **or** Service Delivery Date | As per SaH above |
| IMS Job Management | To be supplied | To be supplied |

IMS Job Management conditions are not yet defined. Do not infer them from the
other four. See section 5.

### 2.3 Underlying field names

The manual invoicing code already resolves these. Reuse that logic rather than
reimplementing it.

| Type | Condition | Date field used |
|---|---|---|
| NDIS | Job Status is Cancelled | Scheduled Shift Start Date & Time |
| NDIS | otherwise | Actual Shift Start Date & Time |
| SaH | Transaction Status is `Delivered - To be claimed and invoiced.` | Actual Shift End Date & Time |
| SaH | otherwise | Scheduled Shift Start Date & Time |

Reference: `computeNdisServiceDate` in
`Backend/src/utils/ndisMasterPlanLineHelpers.js`, and
`resolveParticipantTaxRowDate` in
`Backend/src/utils/webhookParticipantTaxPdfHelpers.js`. Field name constants are
in `Backend/src/constants/monthlyStatementAttributes.js`.

Note that each type falls back to its other date field when the primary is
empty, which is consistent with the OR in 2.1.

### 2.4 Two spellings exist

The same field appears in data under two names:

```
'Scheduled Shift Start Date & Time'    'Scheduled Shift Start Date and Time'
'Actual Shift Start Date & Time'       'Actual Shift Start Date and Time'
'Actual Shift End Date & Time'         'Actual Shift End Date and Time'
```

`computeNdisServiceDate` reads both and falls back between them. Selection must
do the same. Reading only one spelling will silently miss items.

### 2.5 Date format and timezone

Dates are stored as ISO 8601 strings with an explicit offset, not as BSON dates:

```
'Scheduled Shift Start Date & Time': '2025-01-07T11:00:00.000000+11:00'
```

The offset changes with daylight saving, so plain string comparison is not safe
for range queries across a DST boundary. Parse to a date before comparing.

Day boundaries resolve against `Business.headOfficeTimezone`, which is the
existing convention in the invoicing code and in the scheduler constants. Do not
hardcode a timezone.

### 2.6 Configuration

Hold the values per type in a single configuration table rather than branching
per type.

| Type | Primary date | Secondary date | Statuses |
|---|---|---|---|
| NDIS Certification | Shift Service Date | Shift Delivery Date | Completed, Cancelled |
| NDIS Verification | Shift Service Date | Shift Delivery Date | Completed, Cancelled |
| SaH | Scheduled Service Date | Service Delivery Date | The four SaH values |
| SaH Low Cat | Scheduled Service Date | Service Delivery Date | The four SaH values |
| IMS Job Management | TBC | TBC | TBC |

Adding a type should mean adding a row, not writing new selection logic.

### 2.7 Filters applied per run

For a given type, participant and period:

- Participant
- Status is one of the type's qualifying values
- Primary date within period **or** secondary date within period
- Not already invoiced (section 3)

This query runs for every participant on every scheduled run. The OR across two
date fields is harder to index than a single-field match, so check performance
against real data volumes.

## 3. Preventing double billing

An item must appear on exactly one invoice. The date condition alone does not
guarantee this: overlapping periods, a changed cadence or a re-run after failure
will all re-select the same item.

### 3.1 What exists

Invoice generation writes a document to the `invoicenumber` collection when a
PDF is produced:

| Field | Example |
|---|---|
| workspaceId, boardId, itemId | 55369, g9n7vgdrXJX, 7110bfc9-… |
| type | PDF |
| invoiceNumber | INV-1194 (ISO+™) |
| pdfLink | S3 URL |
| createdAt, updatedAt | ISODate |

This records the output, not the inputs. It does not say which items went into
an invoice, so on its own it prevents neither duplicate invoices for a period
nor duplicate items across invoices.

Extend this collection. Do not create a parallel one.

### 3.2 What to build

Two mechanisms. Both are required.

| Mechanism | Where | Prevents |
|---|---|---|
| Period fields plus a unique constraint on participant + invoice type + period | `invoicenumber` | The same period being invoiced twice |
| An invoiced marker referencing the claiming invoice | The source item | The same item being claimed by two invoices |

The item marker cannot live in `invoicenumber`. Recording that a specific item
has been claimed requires a field on that item.

### 3.3 Manual invoicing must set the marker

Late or corrected items are handled by manually generating an invoice for them.
The operational process is that data must be current before an automated run.

That makes one thing mandatory: manual invoice generation must set the same
invoiced marker as the automated run. If it does not, the next automated run
will find those items unmarked and bill them a second time.

### 3.4 Atomicity

The invoice write and the item marking must succeed or fail together.

| Failure | Consequence |
|---|---|
| Invoice written, marking fails | The next run bills the same items again |
| Marking written, invoice fails | Those items are never billed |

If the design forces a choice, prefer leaving items unbilled. An unbilled item
is recoverable on the next run. A double-billed participant is not.

### 3.5 Empty runs

If no items qualify for a participant in a period, produce no invoice and send
no email. Log the decision. The run must still be recorded as completed so the
period is not retried indefinitely.

## 4. Statements

A period summary of account activity. It raises no new charges. Every figure
traces back to an invoice or payment already recorded.

### 4.1 Period

Configured separately from invoicing, and can be weekly or monthly.

### 4.2 Structure

| Section | Contents |
|---|---|
| Header | STATEMENT OF ACCOUNT, provider block with ABN |
| Recipient | Participant name, address, account reference |
| Meta | Statement number, statement date, period covered |
| Summary strip | Opening balance, charges, payments, closing balance |
| Transactions | Date, Reference, Description, Charges, Payments, Balance |
| Ageing summary | Current, 30, 60, 90+ days |
| Payment block | Same bank details as the invoice |

Carry the figure the invoice bills through unchanged rather than recalculating
from source items.

### 4.3 Ageing

| Bucket | Meaning |
|---|---|
| Current | Not yet due |
| 1–30 days | Overdue up to a month |
| 31–60 days | Overdue one to two months |
| 61–90 days | Overdue two to three months |
| 90+ days | Overdue more than three months, escalate |

Ageing runs from each invoice's due date, not its issue date. Manual invoicing
sets due date to issue date plus 14 days, so an invoice issued 40 days ago is 26
days overdue, not 40.

The buckets must sum to the closing balance. Check before rendering and fail the
statement if they do not.

### 4.4 Running balance

Each row shows the balance after that transaction, starting from the opening
balance.

Order by date with a stable tiebreaker such as creation sequence, so the same
statement rendered twice is identical.

The final running balance must equal the stated closing balance. Fail the
statement rather than sending one that does not add up.

### 4.5 Zero-balance accounts

If there was no activity in the period and nothing is owing, send no statement.

## 5. Open item

**IMS Job Management conditions.** Date fields and qualifying statuses not yet
defined. This is the only outstanding item and the only thing blocking a
complete build. The other four types can be built without it.

Two things to establish when the conditions arrive: which date fields it uses,
and whether it follows the same two-date OR pattern.

Note that the NDIS date logic already keys off a field called Job Status, which
may or may not be related.

## 6. Template

The statement template is `templates/statement-pdfme-template.json`, with a
rendered two-page example at `templates/statement-sample.pdf` and the script
that produces it at `templates/render-sample.mjs`.

Built for pdfme v5, matching `@pdfme/generator` 5.5.8 on the Backend. Layout
follows the existing participant invoice.

The transaction list is a dynamic table schema that grows with the data and
pushes the ageing summary, payment block and notice down. See
`templates/README.md` for the constraints this imposes and the style properties
that must not be omitted.

## 7. Build sequence

1. Build item selection from the configuration table, reusing the existing date
   resolution logic (2.3) and handling both field spellings (2.4)
2. Add period fields and the unique constraint to `invoicenumber` (3.2)
3. Build the invoiced marker on source items, atomic with invoice creation
   (3.2, 3.4)
4. Add the same marker to manual invoice generation (3.3)
5. Test double billing directly: run the same period twice, confirm the second
   run selects nothing
6. Test the manual path: manually invoice an item, then run automation, confirm
   it is not billed again
7. Build statement aggregation and the ageing calculation
8. Confirm ageing buckets reconcile to the closing balance
9. Wire to the Epic 5 scheduler
10. Wire delivery to SES, and consume bounce events so a failed statement is
    visible

Steps 3, 4, 5, 6 and 8 are what stop a wrong document reaching a participant.
They are not polish.

## Changes since approval

Recorded here rather than by editing the sections above, per the convention in
`CLAUDE.md`. Each entry says what shipped differently and why.

- **4.1, the NDIS budget statement on a non-monthly cadence.** The statement of
  account follows the configured period exactly. The older NDIS *budget*
  statement does not and cannot: its template carries fixed read-only text
  saying "the services you received in the previous calendar month", and its
  budget rows are queried by month and year, not by a date range. On any period
  that is not a single calendar month it is therefore **withheld** rather than
  rendered with a body that contradicts its own header. Before this it was
  issued every run, restating the same month each time under a fresh number. A
  weekly workspace now receives the statement of account weekly and no budget
  statement. Quarterly and yearly cadences behave the same way. This is a
  product decision as much as a technical one and is flagged on the pull
  request; making the budget statement period-aware means changing its template
  and its budget query, which is its own ticket.
- **2.3, reusing the manual date resolution — deferred.** Membership is the OR
  of 2.1 and is implemented and tested. The other half of 2.3 — selection and
  the renderers agreeing on which single date an item HAS — is not: the two PDF
  renderers still each resolve the date themselves, so an NDIS Cancelled shift
  selected on its Actual Start can print a Scheduled Start outside the billed
  period. Closing it means both renderers reading one shared resolver, which is
  a change on the PDF-generation path, and first closing two gaps in them:
  `computeNdisServiceDate` compares the status string exactly rather than
  through the alias/trailing-period normalisation selection uses, and
  `resolveParticipantTaxRowDate` has no fallback to the other field. A
  configuration-driven resolver was written during this work and then removed
  because nothing called it; an exported, tested, uncalled function that
  comments describe as load-bearing is worse than an honest gap.
- **2.7, selection as a query.** Status, date and already-invoiced predicates
  run in application code over the id list the Invoice Generator listing
  returns, not as a Mongo query. Equivalent at current volumes; the section's
  own performance question remains to be measured on real data.
- **3.2(a), the unique constraint.** It lives on `pdflinks`, keyed on
  `workspaceId + boardId + type + periodKey + itemId`, rather than on
  `invoicenumbers` keyed by participant. That is stricter than specified. Its
  partial filter (`periodKey` must be a string) means manually generated rows,
  which carry no `periodKey`, are outside it; those rely entirely on the item
  marker, which 3.3 now guarantees on every path. Closing the hole at the index
  needs its own migration.
- **3.4, the manual path's failure direction.** The shared writer now claims the
  item first and records the ledger row second. A ledger-write failure
  deliberately does **not** release the claim, because by then the document
  exists and has usually been sent; releasing would hand an already-invoiced item
  back to the next run. This is the same choice the automated path already makes.
  A failed *claim* does not skip the ledger write: both partial states are
  visible and repairable, and the ledger row is the Age Care path's own
  re-billing guard (`generateAgeCareGeneratorInvoices` drops listed rows
  carrying an `invoiceNumber`), so it is the last guard standing in exactly that
  case. Claim-first is preferred because `Item.invoicedBy` is the only guard the
  NDIS scheduled path reads.
- **6, template deliverables.** The live template is
  `Backend/src/assets/statementOfAccount.json`, not
  `templates/statement-pdfme-template.json`, and a second copy under the
  promised path would be a copy that drifts. `templates/README.md` records the
  layout constraints and points at the live file; `templates/render-sample.mjs`
  renders from it. A sample PDF is not committed, because a binary goes stale
  silently; the README says how to produce one.
