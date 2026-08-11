# Baseline test findings — defects discovered while writing unit coverage

**Branch:** `chore/epic-0-baseline-tests` · **Commit:** `a93cfbe4` · **Date:** 2026-08-10

While adding a mirrored unit test for every source file in `Backend/src` and
`Frontend/{app,lib,hooks,components}`, the tests characterized a number of
defects. **Nothing here was fixed** — the suite pins current behaviour so it
passes against unmodified source, which means fixing any of these will require
deliberately updating the corresponding expectation. That is intended, but it is
easy to misread a green test as "this behaviour is correct".

Every item below cites the file it lives in and the test that pins it.

> **This file lives in `docs/ongoing/`, which is deleted on merge.** Raise
> tickets for anything worth keeping before this branch merges.

---

## 1. Security

### 1.1 Credentials login grants support_admin to every user
`Backend/src/routes/auth.js` (~line 295)

`POST /api/auth/login` signs the session JWT with `role: 'support_admin'`
**hard-coded**, regardless of the authenticating user's stored role:

```js
const token = jwt.sign(
  { userId: user._id, email: user.email, name: user.name, role: 'support_admin', avatar: '' },
  ...
```

A user stored as `isoplus_user` who signs in through the credentials path
receives a support_admin token. This also makes every `isoplus_user` 403 gate
unreachable via that path — e.g. `GET /api/log` returns 200 for a stored
`isoplus_user`. Pinned in `test/unit/routes/log.test.js`.

**Impact:** privilege escalation on a live auth path. Highest-priority item here.

### 1.2 Secrets escape Sentry redaction
`Backend/src/utils/authSentry.js`

- `REDACT_KEYS.has(key) || REDACT_KEYS.has(key.toLowerCase())` matches only the
  exact key or its lower-cased form. `accessToken`/`clientSecret` are listed but
  `accesstoken`/`clientsecret` are not, so a payload key of `AccessToken` or
  `ClientSecret` is **sent to Sentry in the clear**.
- The OAuth `code` leaks via the request path: `requestMeta()` puts
  `req.originalUrl` into `path` as a plain string, truncated but never scrubbed,
  so `/api/auth/isoplus/callback?code=…` reaches Sentry intact even though the
  `code` *key* is on the deny list.
- Breadcrumb request metadata is unsanitized: in `authFailure`,
  `...requestMeta(req)` is spread **after** the sanitized payload, so an
  over-long `path` is stored untruncated in the breadcrumb.

### 1.3 Log sanitiser misses real streams
`Backend/src/utils/loggerSanitizeHelpers.js`

`isNonSerializableValue` matches only `constructor.name === 'Stream' | 'Socket'`.
An actual `stream.Readable` — which is what fs and HTTP streams are — returns
`false` and gets recursed into.

---

## 2. Money and invoicing

### 2.1 Legacy and 2026-27 NDIS write-backs use different formulas
`Backend/src/utils/ndisMasterPlanRouteHelpers.js`

The same two amounts are computed two different ways:

| Amount | Legacy | 2026-27 |
|---|---|---|
| Provider travel | `rate × (mileage + otherCosts)` | `rate × mileage + otherCosts` |
| Labour travel | `rate × minutes` — **no `/60`** | `rate × minutes / 60` |

Worked examples pinned in the tests:
- rate 0.80, 20 km, $2.60 other → legacy writes **18.08**, new writes **18.60**
- rate 65, 45 min → legacy writes **2925.00**, new writes **48.75**

**Impact:** a factor-of-60 disagreement on live invoicing arithmetic. Worth
looking at first among the money items.

### 2.2 Invoice rows where quantity × unit price ≠ total
`Backend/src/utils/ndisLegacyMasterPlanServiceHelpers.js`,
`ndisNewMasterPlanServiceHelpers.js`

The labour-travel row rounds quantity to 0.1 h (`round1(45/60) = 0.8`) but
reports `totalAmount` as the stored amount. A printed line of
`0.8 × $65.00 = $48.75` does not multiply out — 0.8 × 65 is $52.00. Same pattern
on `direct_support_non_time` and `non_face_to_face`.

### 2.3 String `"0"` is truthy, so $0.00 lines reach Xero
`Backend/src/utils/ndisQuoteLineHelpers.js` (`buildNdisQuoteXeroLineItems`),
`ndisNewMasterPlanServiceHelpers.js` (`buildNewMasterPlanAllowancesUpdate`)

The gates test the raw value, and ISO+ posts numeric columns as **strings**. A
quantity or price of `"0"` therefore produces a **$0.00 line on the Xero quote
and the quote PDF** instead of being skipped. Numeric `0` is correctly skipped —
only the string form leaks through.

### 2.4 Rounding
`Backend/src/utils/ageCareMasterPlanCalc.js`

- `round2` rounds negative halves toward zero: `round2(-10.555)` is `-10.55`,
  not `-10.56`. On credits and negative adjustments the participant and
  government sides can each land a cent out in the same direction.
- `round2(1.005) === 1`, not `1.01` — inherited float error.
- `computeMasterPlanContributions` rounds both sides **independently**, so they
  need not sum to the total: a total of `33.33` at 33% yields `{11, 22.33}`,
  where the participant side was rounded up from `10.9989`.

### 2.5 NaN quantity reaches the Xero payload
`Backend/src/utils/xeroParticipantTaxHelpers.js`

A non-numeric `quantity` (e.g. `'two'`) survives `Math.abs()` as `NaN` and is
placed on the Xero line item, where it serialises to `null`. `unitAmount` then
silently falls back to `unitPrice`, or to the whole line amount when
`unitPrice` is 0.

---

## 3. Crashes — unguarded dereferences that 500 a live route

| Where | What throws |
|---|---|
| `Backend/src/utils/itemTransform.js:74` | The `catch` block calls `resolveAttributeKey(valueObj)`, which is **neither defined nor imported**. Any transform failure raises `ReferenceError` instead of logging and continuing — one bad value fails the whole item inside the sync worker and webhook handlers. |
| `Backend/src/utils/webhookMonthlyStatementPdfHelpers.js:304` | `resolveFooterImage(deps)` does not take `req`, but its `catch` calls `warn(..., req ?? null)`. If `src/assets/monthly-statement-footer.png` is ever missing from a deploy, the recovery path throws `ReferenceError` and the monthly-statement route 500s. |
| `Backend/src/utils/invoiceGeneratorRouteHelpers.js:59-60` | `processInvoiceGeneratorItems` calls `getValueFromItem(participantProfileItem, ...)` with no null guard, so a `Participant Profile` reference pointing at a row absent from Mongo throws a `TypeError` and 500s `/invoice-generator`. |
| `Backend/src/utils/xeroParticipantTaxHelpers.js:8` | `resolveParticipantTaxDueDate` throws `RangeError: Invalid time value` when `invoiceDateRaw` is unparseable and no due date is supplied. The caller passes `req.body.invoiceDate` straight through. |
| `Backend/src/utils/ndisQuoteLineHelpers.js` | `buildNdisQuoteRecipientAddresses` throws on a quote with no Postcode — `NDISQuoteValues.Postcode.toString()` has no optional chaining, unlike every sibling field. |
| `Backend/src/utils/ndisMasterPlanRouteHelpers.js` | `buildLegacyMasterPlanResetPayload` throws on a value entry with no `attribute` object: the legacy finder reads `v.attribute.name` while `buildMasterPlanAttributeFinder` uses `v.attribute?.name`. |
| `Backend/src/utils/ageCareParticipantServiceHelpers.js` | `resetAgreedUnitPriceFields` throws `TypeError` if the board lacks `Agreed Unit Price ($)` or `Participant Contribution (%)`, before any request is made. |
| `Backend/src/utils/automationUrlUpdate.js` | `shouldUpdatePortalAutomation` throws `TypeError` on an automation with no `name` (`automationItem.name.startsWith`). `routes/automation.js` feeds it the raw ISO+ response, so a malformed upstream payload becomes a 500. |
| `Backend/src/utils/businessLogo.js` | `applyBusinessLogoUpdates` throws if `removals` is undefined (`removals[field]`), while `files` is guarded with `files?.`. |

---

## 4. Guards that do not guard

### 4.1 `mongoEq` throws instead of returning null
`Backend/src/utils/securityHelpers.js:77`

`mongoEq` **throws** `Invalid query value: expected a plain string, number,
boolean, or bigint` for `null`/`undefined`. Every `if (!id) { warn(); return; }`
guard downstream is therefore reachable only for the **empty string** — a
genuinely missing id rejects out of the function instead. Affects at least:

- `isoplusWebhookValueUpdateHelpers.js:52-54` (`handleWebhookValueUpdated`)
- `isoplusWebhookItemHelpers.js` (`deleteWebhookItemFromDatabase`, `fetchOrCreateWebhookItem`)
- `timeTrackSync.js` — and its callers do not await it, so the rejection would
  surface as an unhandled rejection

### 4.2 Other ineffective guards
- `Backend/src/utils/ageCareMasterPlanHelpers.js:25` — `unitPrice >= 0` is
  checked **before** the null guard. `null >= 0` is `true`, so the branch is
  entered and only then dropped downstream. Correct by accident.
- `Backend/src/utils/ageCareMasterPlanHelpers.js:19` — a single-space unit is
  skipped but an **empty-string** unit is pushed to ISO+ as an empty Unit value.
  `readAttr` returns `''` (not `' '`) for a missing attribute, so the guard does
  not catch the case it appears aimed at.
- `Backend/src/utils/itemsRouteHelpers.js:107` — `applyInvoiceStatusUpdates`
  uses `Array.prototype.some`, which **short-circuits**. The URL is written to
  `Invoice File URL` only; if that already holds the URL it *creates*
  `Invoice PDF Link` rather than recognising it as up to date. `options.required`
  is accepted and never read.
- `Backend/src/utils/webhookAggregateHelpers.js` — the `Math.abs(...) >= 0.001`
  gate means a real category value of `0.0005` is silently dropped, and an
  aggregate holding `0.0009` is treated as empty and overwritten.

---

## 5. Silent wrong results

| Where | Behaviour |
|---|---|
| `Frontend/app/workspace/[id]/pdf-output/[outputId]/page.tsx` | **The page is unreachable.** `pathname.split('/')[2]` is the *workspace* id, and the lookup is `allPdfOutputs.find(o => o.id === \`pdf-${id}\`)` — the `[outputId]` segment is never read. Separately, the `if (!output) router.push(...)` effect has no still-loading guard, so **every** visit redirects to the list on first render, before the fetch resolves. |
| `Frontend/app/workspace/[id]/pdf-output/[outputId]/page.tsx` | `createdAt` is double-formatted: the list mapper converts the ISO date to a localized `en-AU` string, then the detail page calls `new Date(...)` on that string again. V8 re-parses `04/03/2026` as *M/D/Y*, so day and month are swapped (or `Invalid Date` past the 12th). Not asserted — the output depends on host timezone. |
| `Frontend/app/workspace/[id]/board/[boardId]/export/page.tsx` | Inside `response.data.board.map(...)` the per-board request is `` `/api/boards?id=${boardId}` `` — the id from the **pathname** rather than `board.id`. Every board in the workspace gets the current board's label. |
| `Frontend/app/workspace/[id]/usage-report/page.tsx` | When `/api/usage/*` errors, the page substitutes a **hardcoded demo dataset** (Invoice 76/892/12.4, Xero API Calls 234/2892/42.6) with no user-visible error. A dead endpoint looks like real traffic. |
| `Frontend/lib/invoice-generator-helpers.ts:17-41` | `getFundingSourceCode` can never return `AS`. `FUNDING_SOURCE_CODE_MAP` is scanned in insertion order with `includes()`, and the broad key `'Assistive Technology'` (→ `AT`) sits above `'Assistive Technology - Ongoing'` (→ `AS`). An Ongoing service is claimed as `AT`. |
| `Frontend/lib/invoice-generator-export-helpers.ts` | `formatNumberForCsvExport` exports an **empty cell** for a non-numeric value — indistinguishable from a genuinely absent price in the claim CSV. |
| `Backend/src/utils/itemTransform.js` | `parseNumber` is not `parseFlexibleNumber`: it strips everything outside `[0-9.-]`, so `'(100.25)'` yields `+100.25` (accounting-negative parentheses lost) and `'12-34'` yields `12`. Two different number parsers in the same directory. |
| `Backend/src/utils/timeTrackSync.js` | The duplicate lookup is `TimeTrack.find({ boardId, itemId })` — it ignores `workspaceId`, so an entry already imported under a different workspace blocks the import for this one. |
| `Backend/src/services/isoplus.js` (via `isoplusWebhookItemHelpers`) | Refresh replaces the stored `data` object **wholesale** with the transform of the API response, so keys the API no longer returns are dropped. The attribute-name fallback path does a dot-path `$set` and preserves siblings — the two paths differ. |
| `Backend/src/utils/isoplusWebhookItemHelpers.js` | `fetchOrCreateWebhookItem(itemId, boardId, null)` silently **ignores `boardId`** — with no `workspaceId` it scans all sync-enabled boards and can bind the item to a different board than the caller named. |
| `Backend/src/utils/xeroNdisRouteHandlers.js:422` | **The error message is non-deterministic when two things are wrong at once.** `handleXeroInvoicendisInvoiceGenerator` runs the Xero auth check and the master-item lookup inside one `Promise.all`. If the workspace is unconnected *and* an item id is unknown, both reject and `Promise.all` surfaces whichever loses the race — so an operator gets `No Xero tokens found` or `Some items were not found: …` at random, run to run. This was caught by a test that asserted one of them and passed locally while failing in CI. |
| `Backend/src/routes/ndis.js` (`getNdisInvoiceGeneratorData`) | One item carrying a `Shift Status` column switches the whole board's status filter, after which items carrying only `Job Status` match no job-status filter at all. |

---

## 6. Frontend lifecycle and state

- **`monthly-statement/page.tsx` never calls `setCurrentWorkspaceId`**, unlike
  every other board-scoped page. `<SyncStatusIndicator />` therefore never polls
  while that page is open, even though the page reads `syncStatuses` from
  context and its Resync button depends on them.
- **Only 2 of the 9 workspace pages call `setCurrentWorkspaceId`** (`page.tsx`
  and `configuration/page.tsx`) — the sync indicator is dead on the other seven.
- **`xero-integration` leaks a `message` listener.** `handleConnectXero` returns
  its cleanup function to nobody, so the popup listener survives unmount and a
  late `XERO_AUTH` message still POSTs to `/api/business/xero/connect`.
- **`audit-trail` resets to page 1 for 400 ms after mount.** The search-debounce
  effect runs on mount and its timer calls `setCurrentPage(1)` unconditionally;
  clicking page 2 inside that window silently bounces back and refetches page 1.
- **`board/[boardId]/page.tsx` fetches the board twice** on a cold load: the
  effect lists `workspace` in its deps and the context object changes identity
  when `ContextProvider` hydrates from `localStorage`. The first request is
  aborted.
- **`app/page.tsx` can never show its inline `role="alert"` error.**
  `setError("Credential is not correct!")` sits in the `else` of
  `if (response.status === 200)`, but axios throws on 4xx — a rejected login
  only ever produces a toast.
- **`runEligibleRecordsLoad` leaves `loadingEligible` true on a cancelled
  request** (`invoice-generator-eligible-records-helpers.ts:206`). Deliberate
  hand-off to the superseding load, but with no successor the spinner never
  clears.
- **No client-side validation on the form pages.** `configure-business` and
  `pdf-output/configure` submit whatever is typed — an invalid email goes over
  the wire verbatim, and three signature providers can be enabled with blank
  credentials. The only errors shown come back from the server.

---

## 7. Accessibility

- **`ToastClose` has no accessible name** (`Frontend/components/ui/toast.tsx:73`).
  It renders a bare lucide `<X>` with no `aria-label`, `sr-only` text or `title`,
  so the toast close button cannot be found or announced by name.
- **`Progress` never forwards `value` to the Radix root**
  (`Frontend/components/ui/progress.tsx:11`). `value` is destructured out and
  used only for the indicator transform, so Radix emits no `aria-valuenow` and
  `data-state` stays `indeterminate`. A screen reader hears an indeterminate bar
  however full it looks.
- **The carousel region is unnamed** (`Frontend/components/ui/carousel.tsx:141`).
  `aria-roledescription="carousel"` is a role *description*, not an accessible
  name.
- **Audit-trail filter selects render with an empty accessible name** until
  opened — Radix has not mounted the item text yet.

---

## 8. Smaller notes

- `Backend/src/utils/workspaceBoardHelpers.js:3` — `mergeBoardPageResults`
  **mutates its `collected` argument** *and* returns a new array. Harmless today
  because the caller reassigns, but it violates the repo's no-mutation rule.
- `Backend/src/utils/workspaceBoardHelpers.js` — `shouldStopBoardCollection`
  hard-codes `limit <= 100` while its sibling takes `isoMaxLimit` as a
  parameter, duplicating `ISOPLUS_MAX_LIMIT` from `routes/workspace.js`.
- `Backend/src/utils/automationUrlUpdate.js:21` — `rewriteWorkflowUrl` builds a
  `RegExp` from **unescaped** URL substrings (dots match any character; regex
  metacharacters would mis-replace or throw), and replaces only the *host*, so
  an `http://` webhook pointed at an `https://` `BACKEND_URL` keeps its scheme.
- `Backend/src/utils/boardSyncActions.js` — `handleBoardSyncDisable` swallows
  errors while `handleBoardSyncEnable` rethrows. A disable failure returns
  `{ syncResult: null, error }` and `routes/board.js` ignores the `error` key,
  so the request still returns 200.
- `Backend/src/utils/exportOptimizedServicePlanHelpers.js:1-7` —
  `normalizeServiceIdString` trims **only** in the slash branch, so a padded id
  without a slash keeps its whitespace; and `normalizeServiceIdString(null)`
  returns the string `'null'`.
- `Backend/src/routes/ndis.js` — `handleLegacyMasterPlan` has **no try/catch**,
  unlike `handleMasterPlanNew`. An ISO+ failure propagates to the route instead
  of returning the 200-with-error-body that stops ISO+ retrying.
- `Backend/src/utils/businessProfileUpdate.js` — `buildBusinessUpdateData` emits
  explicit `undefined` for every absent field; assigned to a Mongoose `$set`
  those are dropped, so blanking a field via a body that omits the key is a
  no-op.
- `Frontend/lib/qr-generator-helpers.ts:188` — `downloadQrCanvas`'s
  tainted-canvas branch is **dead code**: it tests
  `error.message.includes('tainted')` (case-sensitive) while browsers throw
  *"Tainted canvases may not be exported."* with a capital T.
- `Frontend/lib/qr-clipboard-helpers.ts` — `copyQrCanvasWithFallbacks` shows
  **no toast at all** when the popup is blocked: clipboard fails, download
  throws, `openCanvasInNewTab` returns `false`, and the `if` is skipped.
- `Frontend/lib/qr-generator-helpers.ts` — `normalizeUrlForQr` prefixes
  non-http schemes: `mailto:someone@example.com` becomes
  `https://mailto:someone@example.com` and is encoded into the QR.
- `Frontend/lib/invoice-generator-helpers.ts` — `getInvoiceGeneratorBoardFlags`
  derives `isNdisBoard` from a lower-cased substring match, so **any** board
  whose label merely contains "ndis" routes to the NDIS endpoints.
- `Frontend/lib/invoice-generator-eligible-records-helpers.ts` — the
  truncated-export toast only warns when `total > items.length`, and `total`
  defaults to `0` when the server omits it, so a 1000-item response with no
  `total` claims "Loaded 1000 eligible records" — completeness it cannot know.
- `Frontend/lib/invoice-generator-export-helpers.ts:137` — singular/plural
  mismatch: one skipped record reads *"1 record were skipped…"*.
- `Frontend/lib/invoice-generator-invoice-dialog.tsx` — **Cancel** only flips
  the open flag; the selection/record reset lives in `onOpenChange`, which the
  button does not trigger. Escape and Cancel therefore behave differently. The
  dialog also lists each row by *service*, never showing the participant name.
- `Frontend/lib/monthly-statement-page-components.tsx` —
  `MonthlyStatementStatementPanel` reads `businessDetails.companyName`
  unguarded; a `null` `businessDetails` would throw. The real page always
  supplies an object, so this is latent.

---

## 9. Not a product defect — test-environment notes

Recorded here because they cost real debugging time and will bite the next
person writing tests in this repo.

- **The app logs to Mongo.** `Backend/src/utils/logger.js` has a Winston
  MongoDB transport, so any code path that logs writes rows into the `logs`
  collection *during* a test. Never assert "the collection holds exactly my N
  rows" without scoping to a marker you control — this made
  `routes/log.test.js` pass alone and fail in a full run.
- **Mongoose `timestamps` overwrites an explicit `updatedAt` on `create`.**
  Seeding ordered data needs a second write with `{ timestamps: false }`.
- **Mock `next/navigation` with ONE module-level router object.** A fresh object
  per call re-fires every effect that lists `router` in its deps — this looped
  `Header`'s session check forever and hung the whole frontend suite.
- **jsdom's `window.location` cannot be redefined** and its `href` is not
  configurable. Swap the whole accessor for the duration of one test and restore
  it; doing it globally breaks the jsdom internals MSW relies on.
- **Joi's `.email()` rejects `.test` TLDs** — use `example.com` in fixtures.
- Radix renders two nodes with the same text (styled + visually-hidden a11y
  copy), and wraps some primitives in an unstyled `[role=region]` whose
  className lives on an inner element.
