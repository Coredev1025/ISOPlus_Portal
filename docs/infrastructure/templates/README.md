# Statement templates

| File | Purpose |
|---|---|
| `statement-pdfme-template.json` | The template. Open in the pdfme Designer, or feed to the generator |
| `statement-sample.pdf` | Rendered example, produced from the template |
| `render-sample.mjs` | Script that produces the sample, with the spec's reconciliation checks |

---

## The pdfme template

Targets the **v5+ template format**: `schemas` as an array of arrays, each field carrying a `name` string. If your Designer produces the older v4 shape (schemas as an array of objects keyed by field name), the conversion is mechanical but this file will not load as-is. Worth checking your pdfme version first.

### Why basePdf is blank rather than a branded PDF

```json
"basePdf": { "width": 210, "height": 297, "padding": [12, 12, 20, 12] }
```

This is not a stylistic choice. **Dynamic tables and automatic page breaks only work with the blank object form.** Supplying a custom PDF as the base makes pdfme keep the pages fixed and stop reflowing content.

A statement has a variable-length transaction list, so it needs the dynamic table, so it cannot use a letterhead PDF as its base.

If statements need branding, draw it with schemas (`text`, `image`, `line`, `rectangle`) or put it in `staticSchema` so it repeats on every page. Do not embed it as `basePdf`.

If the existing invoice templates use a base PDF, statements cannot follow the same pattern. Worth confirming early.

### Why the ageing summary is not a table

The layout has two logical tables, transactions and ageing. Only the transactions one is a `table` schema. The ageing summary is built from individual `text` fields over a `rectangle`.

Two reported issues with multiple table schemas informed this: overlap from a padding bug when a table spans pages, and misalignment when a new page is created. Since the ageing row is fixed at five columns and never grows, it costs nothing to lay out manually and avoids the risk.

### Reflow behaviour

Everything below the `transactions` table gets pushed down as the table grows. That includes the ageing summary, payment block and notice, which is the intended behaviour.

The table's `height: 45` is a starting value, not a cap. Positions of elements below it are therefore starting positions too.

`staticSchema` content is not pushed. It repeats on every page at a fixed position, which is why the page footer lives there.

---

## Verified by rendering

`statement-sample.pdf` was generated from this template with `@pdfme/generator` 5.5.8. `render-sample.mjs` is the script that produced it, including the reconciliation checks from the spec.

To regenerate:

```bash
npm install @pdfme/generator @pdfme/schemas
node render-sample.mjs
```

Eight transactions render on a single page, and both reconciliation assertions pass.

---

## Table style properties that are mandatory

Three properties are dereferenced by pdfme without a null guard or a sane default. Omitting them either crashes the generator or silently wrecks the layout. This cost real debugging time, so it is written down.

**`bodyStyles.characterSpacing`** — the dangerous one, because it fails *silently*. With it absent, the text-width calculation goes wrong, cells wrap far earlier than they should, row heights inflate, and the table splits across pages. Eight rows produced an eight page document. Adding `characterSpacing: 0` collapsed it back to one page with no other change.

Set it explicitly on **both** `headStyles` and `bodyStyles`, even when the value is zero.

**`columnStyles`** — crashes with `Cannot read properties of undefined (reading 'alignment')`. Must be present, `{"alignment": {}}` is enough.

**`bodyStyles.padding`** — crashes if missing.

The lesson generalises: when hand-writing a pdfme table schema, copy a **complete** style object from a template the Designer produced and change values, rather than writing a minimal one from scratch. Absent keys are not defaulted.

### Confirmed working

**`columnStyles`** is keyed by column index as a string:

```json
"columnStyles": { "alignment": { "0": "left", "3": "right" } }
```

Money columns are right-aligned in this template.

**`{currentPage}`** in `basePdf.staticSchema` renders correctly, matching the convention in `participantTaxInvoiceAG.json`.

---

## Pagination

The sample carries 25 transactions and spans two pages. That is deliberate: it demonstrates that the dynamic table splits correctly and that the ageing summary, payment block and notice **reflow onto page two** rather than being overlapped by the growing table.

The page footer renders `1/2` and `2/2` from `{currentPage}` and `{totalPages}` in `basePdf.staticSchema`, and repeats on every page without being pushed by content.

No blank trailing page is produced.

---

## Field names

These match the `{{ }}` placeholders in the HTML template, so the same data object drives both.

| Field | Notes |
|---|---|
| `providerBlock` | Multi-line. Name, ABN, address |
| `participantBlock` | Multi-line. Name and address |
| `metaLabels` / `metaValues` | Two aligned multi-line blocks, four rows each |
| `openingBalance`, `totalCharges`, `totalPayments`, `closingBalance` | Summary strip |
| `transactions` | Table. 2D array or stringified 2D array, six columns |
| `ageingCurrent`, `ageingDays30`, `ageingDays60`, `ageingDays90`, `ageingDays90plus` | Must sum to `closingBalance` |
| `paymentLabels` / `paymentValues` | Two aligned multi-line blocks |
| `amountDue` | Same value as `closingBalance` |

Currency values are passed pre-formatted, including the `$`, so rounding is decided once in the application rather than in the template.

### Transaction table columns

`Date`, `Reference`, `Description`, `Charges`, `Payments`, `Balance` at width percentages `12 / 15 / 39 / 11 / 11 / 12`.

Refunds and credits go in the Charges column as negative values, as shown in the sample row `CRN-0033`.

---

## Before this is used

The reconciliation rules in [../04-invoice-statement-generator.md](../04-invoice-statement-generator.md) are not optional:

- Ageing buckets must sum to the closing balance
- The final running balance must equal the stated closing balance

Fail the statement rather than rendering one that does not add up.
