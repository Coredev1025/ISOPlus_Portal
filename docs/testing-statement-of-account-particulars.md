---
name: testing-statement-of-account-particulars
description: >-
  Use when proving a statement of account on portal-dev shows charge rows
  (particulars) for invoices, not only an opening balance; when System Health
  Run now produced an empty particulars table; when asked to raise dated
  invoices for E2E Handover and fire a statement; when asked to run the KAN-10
  statement-of-account e2e / demo flow. This is portal-dev only — never the
  local stack, never Playwright.
---

# Statement of account particulars — portal-dev

Paste this to an assistant that should drive the proof:

> Prove statement-of-account particulars on **portal-dev** for E2E Handover.
> Follow `docs/testing-statement-of-account-particulars.md` exactly. Do not
> run this locally. Do not run Playwright. Restore automation settings when done.

## The environment — do not substitute

| | |
|---|---|
| Frontend | `https://portal-dev.isoplus.online` |
| Backend | `https://portal-be-dev.isoplus.online` |
| Workspace | `55369` |
| Board | `mXmS4j4fvQj` (NDIS) |
| Participant | **E2E Handover** |

**This journey is portal-dev.** A local tick, a fixture seed, or
`npx playwright test` answers a different question. None of them put INV rows
on the live SOA the client is looking at.

Drive every call from a browser tab signed in via SSO on the `portal-dev`
origin (`fetch(..., { credentials: 'include' })`). The session cookie is
httpOnly, so it cannot be handed to `curl`, and the frontend origin is
Cloudflare-gated against non-browser clients.

## What passing looks like

A statement of account whose **period contains the invoices you just raised**
lists those invoices as **charges / particulars**, not as opening balance.

| Symptom | Meaning |
|---|---|
| Particulars lists `INV-…`, Charges = their sum | pass |
| Particulars empty, Charges `$0.00`, Opening = those invoices, ageing 61–90 / 90+ | the invoices exist; **the period missed them** |
| No SOA at all, log `No account activity` | the PDFLink rows are missing `participant` / `boardId` / `invoiceTotal` |

Empty particulars is not "the invoices were not recorded". SOA-5 (2026-09-10)
had INV-1211–1213 as a $1,536.99 opening balance because Run now dated the
document 1–31 August and those invoices were March–May.

## Related

- [`testing-kan10-portal-dev.md`](testing-kan10-portal-dev.md) — the general portal-dev runbook for KAN-10
- [`testing-kan11-end-to-end.md`](testing-kan11-end-to-end.md) — the System Health screens this run appears on

## Do not

- Tick portal-dev with a **local** `SCHEDULER_API_KEY` (it 401s; the scoped
  keys live on Elastic Beanstalk).
- Fire `POST /api/scheduler/tick` for this proof. Use **System Health Run now**.
- Seed Mongo. Raise invoices through the Invoice Generator route.
- Send to bounce/complaint simulator addresses, or to a real client's mailbox
  that is not already on Copy to.
- Leave the statement cadence on 6 months.
- Combine two participants on one invoice.

## 1. Confirm the code under test is on portal-dev

Backend and frontend deploy separately. A green PR check is not a deploy.

```bash
gh run list --branch develop --limit 5
# the push run, not the pull_request run — Deploy Backend must have run
```

Wait until `isoplus-be-dev-blue` is on the commit that honours cadence on Run
now ([PR #906](https://github.com/ISO-Consulting-Services/isoplus-portal/pull/906)
and later). Before that merge, every manual statement is last calendar month
regardless of settings, and this proof cannot pass.

## 2. Confirm you are actually signed in

The UI can look signed in from leftover state while the session is dead.

```js
const r = await fetch('https://portal-be-dev.isoplus.online/api/auth/verify', {
  credentials: 'include',
});
await r.json();
// must be { authenticated: true, user: { role: 'support_admin', … } }
```

If it is not, stop and ask the operator to complete **Support agent sign-in**
(Google) on `https://portal-dev.isoplus.online`. Do not invent a login.

## 3. Snapshot settings so you can restore them

```js
const B = 'https://portal-be-dev.isoplus.online';
const settings = await (await fetch(`${B}/api/workspaces/55369/automation-settings`, {
  credentials: 'include',
})).json();
const snapshot = {
  invoice: settings.invoice,
  statement: settings.statement,
};
// keep snapshot.statement.every / runOn / runAt / sendCopyTo for step 8
```

Observed default for this workspace (restore to this if the GET agrees):
statement `every: { n: 1, unit: 'quarter' }`, `runOn: { month: 9, day: 10 }`.

## 4. Raise dated invoices for E2E Handover

One invoice per pending master item. The Tax Invoice button POSTs to:

`POST /api/pdf/55369/mXmS4j4fvQj/invoicendis-invoice-generator`

The body must include **`items`** (the records), not only `itemIds`. Items-only
missing yields `{ message: "No items found in the payload" }`.

```js
const B = 'https://portal-be-dev.isoplus.online';
const list = await (await fetch(
  `${B}/api/items/55369/mXmS4j4fvQj/invoice-generator-ndis`,
  { credentials: 'include' },
)).json();

const pending = (list.items || []).filter(
  (x) => x.participant === 'E2E Handover' && x.status === 'pending',
);
// group by master item id (id before ':') — one POST per master, same as the UI
```

Set `invoiceDate` to the date the charge should land in (ISO). For a six-month
window ending ~11 September, three invoices on 20 March / 20 April / 20 May
is the demonstrated set.

```js
await fetch(`${B}/api/pdf/55369/mXmS4j4fvQj/invoicendis-invoice-generator`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    itemIds,          // from buildInvoiceItemIds / the record ids
    items: records,  // required
    participantName: 'E2E Handover',
    invoiceDate: '2026-03-20',
    dueDate: '2026-04-03',
  }),
});
```

Confirm each stored row has `participant`, `boardId`, `invoiceTotal`, `invoiceDate`.
Without the first three the statement never sees the invoice; without the date
it falls back to `createdAt` (today) and every charge piles into this month.

## 5. Point the statement cadence at that window

Charges are invoices whose **`invoiceDate` falls inside the statement period**.
The period comes from `ScheduledJob.schedule`, not from the email subject.

| Cadence on Run now | Window from ~11 Sep | Mar–May invoices |
|---|---|---|
| missing `schedule.every` (pre-#906) | 1–31 of previous calendar month | opening balance |
| `every: { n: 1, unit: 'month' }` | 1–31 of previous calendar month | opening balance |
| `every: { n: 1, unit: 'quarter' }` | ~11 Jun – 10 Sep | opening balance |
| `every: { n: 6, unit: 'month' }` | ~11 Mar – 10 Sep | **particulars** |

PUT the full settings document with only the statement picker changed to
`every: { n: 6, unit: 'month' }` and a `runOn` of `10`. Do not strip Copy to.

## 6. Fire System Health Run now

```js
const res = await fetch(
  `${B}/api/system-health/workspace/55369/run?force=1`,
  {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'statement' }),
  },
);
// 202 { enqueued, periodKey } — 409 without force if that minute already ran
```

`periodKey` is the **slot minute**, not the statement window. A second run in the
same minute needs `force=1` even when the cadence changed.

This POST does **not** take `bypassEmail`. It emails the configured recipients
and Copy to. Leave Copy to as you found it.

Wait until a new Statement of Account for E2E Handover appears on
`GET /api/workspaces/55369/automation-settings` (`recentDocuments`) or
`GET /api/system-health/workspace/55369`. Fetch the PDF from `pdfUrl`.

## 7. Read the PDF — do not stop at the email subject

The email subject can say "Three-month statement of account" while the PDF
period is 1–31 August. The PDF wins.

Extract text (`pdftotext` or equivalent). Record:

- period start / end printed on the document
- Charges
- Opening / closing
- Every invoice number in the particulars table

**Pass** when the invoices from step 4 appear in particulars and Charges
equals their `invoiceTotal` sum (deduped by `pdfLink` — several item rows
sharing one URL are one charge).

**Fail, period bug** when those invoice numbers are absent from particulars,
Charges is `$0.00`, and Opening / ageing account for the same money.

## 8. Restore

PUT settings back to the snapshot from step 3. Confirm
`statement.every` / `runOn` / Copy to match the snapshot. Do not leave a
six-month cadence armed on a shared environment.

## Evidence

Paste the actual JSON from verify, the invoice POST statuses and numbers, the
Run now 202 body, the PDF period line, and the particulars lines. "Looked fine
in the UI" is not a result.
