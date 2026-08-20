# Bind Invoice Generator and Monthly Statement to the tick

**Ticket:** KAN-10
**Date:** 2026-08-14
**Status:** Approved for implementation
**Branch:** `feature/KAN-10_invoice_statement_automation_full`
**Supersedes (generation contract only):** the stub / quote-line engine in
[2026-08-12-invoice-statement-automation-design.md](./2026-08-12-invoice-statement-automation-design.md).
Settings, schedules, fan-out and the outbox are unchanged.

## Goal

A claimed `invoice_automation` / `statement_automation` slot produces the same
PDFs the Invoice Generator and Monthly Statement pages would, with the same
numbering and invoiced status. On-demand UI and webhooks stay. Xero is not
called. ISO+ board sync stays on `board_sync`.

## Same pipeline

After an invoice slot, Invoice Generator for that board shows those rows as
**invoiced**, with `InvoiceNumber` type `PDF` (`{prefix}{n} (ISO+™)` on NDIS)
and the same template the page uses. After a statement slot, a Monthly
Statement PDF exists for each participant for the computed period.

The worker does **not** HTTP-call `/api/pdf/...`. It calls the extracted
service functions; the existing routes become thin wrappers.

## Defaults (ticket fields still excluded)

| Setting | Default |
|---|---|
| Invoice selection | Pending eligible rows whose **Service Delivery Date** falls in the **completed schedule period** ending at the claimed slot (`every` + timezone from the `ScheduledJob`). Sent as `serviceDeliveryStart` / `serviceDeliveryEnd` only — not AND'd with Scheduled Service Date, and not copied from leftover Invoice Generator UI filters. NDIS: approved timesheet, no `InvoiceNumber` type PDF. |
| Invoice grouping | One PDF per participant per board per slot |
| Board flavour | `label.toLowerCase().includes('ndis')` → NDIS generator; otherwise Age Care `invoiceparticipanttax` |
| Statement boards | `label` starts with `Care Management` and is not Low Cat. Other boards no-op (success). |
| Statement period | Previous complete calendar month of the claimed slot in the schedule timezone |
| Statement grouping | One PDF per participant |
| Xero | Not called |

`invoiceDate` is the slot in the schedule timezone; `dueDate` is slot plus
`Business.bankDetails.accountsReceivableTerms` (numeric days, fallback 14).

## Worker

1. **Always generate** PDFs (online and offline).
2. **Offline:** write the outbox with attachment URLs.
3. **Online:** warn that email is unimplemented; complete the job (no BullMQ
   retry against missing SES).

Fan-out stays one job per board. Participant loops run inside the worker so a
crash retries the same `jobId` and skips already-persisted participants.

## Idempotency

- Invoices: write `InvoiceNumber` type `PDF` and `PDFLink` with `periodKey`.
  Skip master items that already have `InvoiceNumber` type PDF. Same-slot
  retry reuses those URLs and does not increment numbering.
- Statements: write `PDFLink` type `Monthly Statement` + `periodKey`. Skip if
  that row exists.

## Out of scope

Xero, Invoice scope / Eligible billing items / Statement type / period UI
fields, ISO+ write-back, SES delivery.

## Changes since approval

| Designed | Shipped | Why |
|---|---|---|
| No date window on invoice selection | Previous calendar month via **Service Delivery Date** | The Invoice Generator page filters on Scheduled Service Date and/or Service Delivery Date. Copying both AND's them and can return 0 rows. The tick uses the same Service Delivery Date field as the page, for the same previous-month window statements already use. |
| Previous calendar month for invoices | Completed **schedule period** ending at the claimed slot (`every` n unit in the job timezone). Statements stay previous calendar month. | A fortnightly `ScheduledJob` must not bill the leftover Invoice Generator month. The claimed row drives the list query. |
