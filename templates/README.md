# Statement of account template

Section 6 of
[`docs/superpowers/specs/2026-08-20-invoice-item-selection-and-statements-design.md`](../docs/superpowers/specs/2026-08-20-invoice-item-selection-and-statements-design.md)
names `templates/statement-pdfme-template.json`, `templates/statement-sample.pdf`
and `templates/render-sample.mjs`. None of those was ever created — this
directory did not exist until now. **The live template was, and remains,**
[`Backend/src/assets/statementOfAccount.json`](../Backend/src/assets/statementOfAccount.json),
loaded and rendered by
[`Backend/src/utils/statementOfAccountPdf.js`](../Backend/src/utils/statementOfAccountPdf.js).

**Do not create a second copy of the template here.** Two templates that can
drift apart is worse than one committed in a directory the spec didn't
anticipate. This README instead documents the layout constraints the live
template has to keep, and `render-sample.mjs` renders a sample **from the live
template**, so an edit can be checked without a second file to keep in sync.

Everything below was verified against the committed template JSON, the pdfme
source actually installed in `Backend/node_modules` (`@pdfme/common`,
`@pdfme/generator`, `@pdfme/schemas`), and
[`Backend/test/unit/utils/statementOfAccountPdf.test.js`](../Backend/test/unit/utils/statementOfAccountPdf.test.js),
which pins real pagination behaviour. None of it is inferred from the spec text
alone.

## Every schema must sit inside the padding box — this is not cosmetic

`basePdf.padding` is `[20, 20, 20, 20]` (top, right, bottom, left, in mm; A4 is
210×297mm). Every schema on the page — `title`, `provider`, `headerRule`,
`recipient`, and so on, not only the two tables — has a `position.y` at or
below the top padding (the highest is `title`/`provider` at `y: 21`/`21`,
against a 20mm top padding).

That is not a style choice, it is load-bearing. `@pdfme/common`'s
`getDynamicTemplate` (`dist/cjs/src/dynamicTemplate.js`) computes each schema's
page as

```js
const localY = schema.position.y - paddingTop;      // normalizePageSchemas
const currentPageIndex = Math.floor(startGlobalY / contentHeight); // placeRowsOnPages
```

If any schema's `position.y` is **above** the top padding, `localY` goes
negative, `currentPageIndex` comes out negative (e.g. `-1`), the loop that
grows the `pages` array (`while (pages.length <= currentPageIndex)`) never
runs because `0 <= -1` is false, and the very next line does
`pages[currentPageIndex].push(newSchema)` against `pages[-1]` — `undefined`.
That throws `Cannot read properties of undefined (reading 'push')` the moment
generation runs the dynamic-table pass, and it does so **even for a single
transaction row** — it is not an overflow problem, so no amount of testing the
input *shapes* (as `buildStatementInputs`'s own tests do) will ever catch it.
This is exactly the regression
[`test/unit/utils/statementOfAccountPdf.test.js`](../Backend/test/unit/utils/statementOfAccountPdf.test.js)'s
`'renders a PDF from the committed template'` case (a **1-row** statement)
guards against, per its own comment: "a schema above the top padding makes the
dynamic-table pass compute a page index that does not exist."

**Rule:** when moving or adding a schema, keep `position.y >= basePdf.padding[0]`
(20). There is nothing in pdfme that validates this for you at template-author
time — it only surfaces when the document is actually generated.

## The transaction table is what grows, and it pushes everything below it down

`transactions` (`type: "table"`, positioned at `y: 122`) is a pdfme dynamic
table: it has more than one possible row height, so
`repeatHead`-aware pagination applies to it and to nothing else on the page.
As the participant's transaction list grows, this table's rendered height
grows with it, and pdfme's dynamic-height pass (the same `getDynamicTemplate`
call above) pushes every schema positioned **after** it — `ageingLabel`,
`ageing`, `payRule`, `paymentLabel`/`paymentLabels`/`paymentValues`,
`totalDueLabel`/`totalDue`, `notice` — down the page to make room, wrapping
them onto a second page once they no longer fit. That is confirmed behaviour,
not a guess: the test suite's `'paginates when the transaction list outgrows
one page'` case renders a 40-row statement and asserts
`doc.getPageCount()` is greater than 1 via `@pdfme/pdf-lib`, specifically
because grepping the raw PDF bytes cannot show page count (pdfme compresses
its objects into streams).

`repeatHead: true` is what carries the transaction table's header onto page
two. **It is not stored in the committed JSON** — check `transactions` in
`statementOfAccount.json` and it is absent. It is set at render time by
[`enableRepeatHeadOnTables`](../Backend/src/utils/invoicePdfSupport.js), called
from `renderStatementOfAccountPdf` before every `generate()` call. Anyone
rendering the raw template JSON through some other path (a pdfme design tool,
a one-off script) will not get the repeating head unless they set
`repeatHead: true` on the table schema themselves.

## Style properties that must not be omitted

Both `headStyles` and `bodyStyles` on the `transactions` (and `summary`,
`ageing`) table schemas carry `padding` and `borderWidth` as full
`{ top, right, bottom, left }` objects, e.g.:

```json
"padding": { "top": 3, "right": 2, "bottom": 3, "left": 2 },
"borderWidth": { "top": 0, "right": 0, "bottom": 0.4, "left": 0 }
```

Do not drop either of these to a bare number or omit them. `@pdfme/schemas`
reads them by side name in two places that will throw, not silently fall back,
if the object is missing:

- `Cell.padding(name)` (`dist/cjs/src/tables/classes.js`) does
  `this.styles.cellPadding[name]` while computing a cell's content height.
  `mapCellStyle` (`dist/cjs/src/tables/tableHelper.js`) sets `cellPadding` from
  `style.padding` verbatim — there is no numeric fallback merged in for a
  missing `padding`, so an omitted `padding` leaves `cellPadding: undefined`
  and the very first `.padding('top')` call throws
  `Cannot read properties of undefined (reading 'top')`.
- `renderLine` in `dist/cjs/src/tables/cell.js` destructures
  `borderWidth.top` / `.right` / `.bottom` / `.left` directly when drawing a
  cell's border. An omitted `borderWidth` throws the same way.

**`tableStyles.borderWidth` is a different shape on purpose** — it is a bare
number (`0` in this template), read as `schema.tableStyles.borderWidth` and
used as `tableLineWidth`, the width of the outer table border. Do not confuse
the two: the *table-level* border width is a number, the *head/body-style*
border width is a per-side object. Copying one shape into the other's slot
either throws (object where a number is read as a truthy check) or silently
draws a border on every side alike (number where per-side variation was
wanted).

`headWidthPercentages` on `transactions` — `[12, 14, 40, 11.5, 11.5, 11]` —
sums to 100. That is not enforced by pdfme either; each percentage is
multiplied by the schema's declared `width` (170mm) independently
(`columnStylesWidth` in `tableHelper.js`), so a set that does not sum to 100
will not throw, it will just make the table narrower or wider than the 170mm
its `position`/`width` declare, drifting from the 20mm side margins the rest
of the page uses.

## Version

The template's own `pdfmeVersion` field reads `"5.5.6"`. That field is
optional metadata only — `dist/cjs/src/schema.js` declares it
`z.string().optional()`, and nothing in `@pdfme/generator` reads or enforces
it — so the mismatch against what is actually installed does not affect
rendering. What actually matters is `Backend/package.json`, which pins
`@pdfme/common`, `@pdfme/generator` and `@pdfme/schemas` all to `^5.5.8`
(`node_modules` currently resolves that to `5.5.10`, the newest `5.5.x`).
Keep the template's `pdfmeVersion` string roughly current when you touch the
template, but do not treat a mismatch there as a defect on its own.

## Producing a sample PDF

There is deliberately no committed `statement-sample.pdf` — a generated binary
in version control drifts from the template that produced it with no diff to
show, and reviewers cannot meaningfully review a PDF. Render one yourself:

```bash
node templates/render-sample.mjs
```

from the repo root (needs `Backend/node_modules`, i.e. `npm install` or
`npm ci` inside `Backend/` at least once). It writes
`templates/statement-sample.pdf`, which is gitignored
(`templates/.gitignore`) — regenerate it rather than reviving an old copy.

The script imports `renderStatementOfAccountPdf` and its helpers straight from
`Backend/src/utils/` by relative path, so it always renders the exact template
the app ships — never a second copy — and needs no `node_modules` of its own:
Node resolves each module's bare imports (`@pdfme/generator` and friends)
relative to that module's own file location, not the location of whatever
imported it, so those resolve against `Backend/node_modules` regardless of
where `render-sample.mjs` itself lives.

The sample statement it builds has enough transaction rows to exercise the
pagination behaviour described above (verified locally to render 2 pages),
plus a payment row and a refund row, so it exercises every column and both the
"charge" and "payment" money paths — not just a trivial one-row case.
