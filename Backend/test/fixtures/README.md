# Test fixtures

Committed, invented data that reproduces a real ISO+ scenario locally.

Sits alongside the Vitest suite in `Backend/test/` (`unit/`, `integration/`,
`msw/`, `real-api/`, `helpers/`). `vitest.config.js` collects
`test/**/*.test.js`, so nothing in this directory is treated as a test — import
the JSON from a test that needs it:

```js
import fixture from '../fixtures/ndis-quote-board.json' with { type: 'json' };
```

For faking ISO+ *responses* rather than seeding Portal-side documents, prefer
`test/msw/handlers.js` — it intercepts at the HTTP layer, which is the only
practical way to drive both branches of the pricing dispatch.

This is the counterpart to `seed/`. The dump in `seed/` is a real database with
real customer records — gitignored, obtained by asking the team, and whatever
board it happens to contain is not a stable thing to write code against.
Fixtures here are small, committed, and describe one scenario deliberately.

| | `seed/` | `Backend/test/fixtures/` |
|---|---|---|
| Contents | real customer data | invented |
| Committed | no | yes |
| Load | `npm run seed` (destructive) | `npm run dev:fixture` (additive) |

## `ndis-quote-board.json`

**Source: the NDIS care management board.** Workspace `55369` ("Test") / board
`eNiJpH14PN3` ("Care Management (NDIS) 2026 Pricing"), Quotes folder
(`BFMUenisoQ4`), plus the four ISO+ webhook bodies that reach the Portal from
it. Structure was read live on 2026-08-06; every person, address and contact
value is invented.

The board name is not incidental — it is where the route mount gets its name:

| ISO+ board | Backend mount |
|---|---|
| Care Management (NDIS) 2026 Pricing | `/api/care-management-ndis-pricing` → `routes/ndis.js` (`index.js:143`) |

22 of the board's 26 `Portal - ` automations point at that mount. The other 4
are `ButtonTrigger`s going to `/api/pdf` and `/api/xero`. The "2026 Pricing" in
the name is the migration that renamed `Direct Support Item Number` and broke
the dispatch — see below.

```bash
npm run dev:fixture                                  # load it
npm run dev:fixture -- --list                        # what's present, and how each item dispatches
npm run dev:fixture -- --replay quotendis --dry-run  # print a webhook body
npm run dev:fixture -- --replay quotendis            # POST it at localhost:4001
npm run dev:fixture -- --remove                      # delete just these documents
```

`--remove` is scoped to the exact ids in the fixture. A seeded database holds
real boards under the same workspace and this must not take them with it.

### Three hops, three keyings

Observed end to end on 2026-08-06, by reading quote 17 and then editing a field
on it. This is the contract the fixture records:

| Hop | Request | Keyed by |
|---|---|---|
| Read | `POST /api/{ws}/{board}/items/values` | `attribute_id` |
| UI write | `PUT /api/{ws}/values/{valueId}` | `attribute_id` |
| **Webhook, ISO+ → Portal** | `POST /api/pdf/{ws}/{board}/quotendis` | **attribute name** |
| Write-back, Portal → ISO+ | `PUT /api/v2/workspaces/{ws}/boards/{board}/items/{item}` | `attribute_id` |

Only the webhook uses names — and it is the only hop the Portal branches on.
That asymmetry is why renaming a column in the ISO+ UI silently repoints
backend dispatch with no error anywhere.

Note the UI write is workspace-scoped with no board id, carries a
client-generated value id, and upserts: `row_version: 0` means new.

### `board.attribute` is the Integration Message field

Easy to get wrong, so stated plainly: `Board.attribute.id` is **not** a pricing
field. It is where `setIntegrationMessage()` writes progress and errors
(`src/services/isoplus.js:659`), and `Board.pdfAttribute.id` is where
`handlePDFSuccess` puts the generated link. If `attribute.id` is unset every
write-back throws *"Internal message attribute not found in board
configuration"* — which is exactly the gap in the seed dump that this fixture
fills.

### Why the item data looks the way it does

`resolveNdisPricingRuleForAutomation()` (`src/utils/ndisPricingRules.js:104`)
decides between the new and legacy pricing paths by consulting, in order:

1. the webhook `values` keys,
2. the stored `Item.data` keys,
3. the board's attribute list — **fetched from the live ISO+ API**.

Step 3 cannot work offline. `getBoardAttributes()` fails, `boardUsesLegacyNdisPricing()`
swallows the failure and returns `true`, and every item resolves to `legacy` —
the opposite of what the live board does. So two of the fixture items carry a
sentinel key and settle it at step 1 or 2, before anything touches the network:

| Item | Sentinel key in `data` | Resolves to |
|---|---|---|
| `fixture-quote-new-pricing` | `Support Item Number` | `new`, offline |
| `fixture-quote-legacy-pricing` | `Direct Support Item Number` | `legacy`, offline |
| `cfd84160-…` (quote 17, as live) | neither | falls through to step 3 |

Quote 17 is kept exactly as it stands in ISO+ — opened during initial setup and
still nearly empty — because "an item with almost no values set" is a real state
the routes have to survive, and it is the state that exposes step 3.

### The rename this fixture exists to record

On the live board, `Direct Support Item Number` **no longer exists**. It was
renamed `OLD Direct Support Item Number` in the 2026 pricing migration, while
`Support Item Number` was added as a `reference`. That combination makes
`boardAttributesUseLegacyNdisPricing()` return `false`, so the live board
resolves to the **new** path — and the live automations that send
`?type=direct_support` and `?type=centre_capital_cost`, which only the legacy
path accepts, get `{"error":"Invalid type"}` back at HTTP 200.

Because `values` is keyed by attribute *name*, renaming a column in the ISO+ UI
silently changes backend dispatch. That is the failure mode worth having a
committed fixture for. See `docs/ongoing/webhooks-and-automation.md`.

### Regenerating

Change it by hand and say why in the commit. It is a contract: a diff here
should mean someone deliberately re-read ISO+ and found it different, which is
exactly the signal you want in review. Do not paste real participant data in.

## `care-management-automation.json`

**Source: workspace `55390` ("ISO+™ NDIS & SaH Demo") on portal-dev** — the
three Care Management boards the KAN-10 scheduled invoice/statement automation
fans out to, read live on 2026-08-17. Board ids, labels, participant names,
funding sources, service codes and price points are captured; every person,
address, bank and contact value is invented.

One fixture, three generator branches — chosen because `Board.label` alone
decides the branch (`utils/automationBoardFlags.js`):

| boardId | label | invoice branch | statements |
|---|---|---|---|
| `jpjztrn14pJ` | `Care Management - SaH` | Age Care (`participantTaxInvoiceAG.json`) | yes |
| `o24sGM1FoST` | `Care Management - NDIS - Certification` | NDIS, legacy pricing | yes |
| `dwV23F5WcQL` | `Care Management - NDIS - Certification` | NDIS, 2026 pricing | yes |

Unlike `ndis-quote-board.json` it also seeds `automationSettings` (both blocks
enabled) and two due `scheduledJobs` rows (`nextRunAt` = 2025-02-01 09:00
Sydney, periodKey `20250201-0900`, billing January 2025), so after loading it a
single `npm run tick -- --once` drives the whole Track A chain offline.
Re-loading the fixture resets `nextRunAt`, making tick runs repeatable.

Details that are load-bearing, learned the hard way and asserted by
`test/unit/fixtures/careManagementAutomationFixture.test.js` (which drives the
items through the real invoice row builders):

- NDIS `Participant Profile` / `Service Plan` references must be UUID-shaped
  or the generator silently drops them and then throws. itemIds here are
  synthetic UUIDs prefixed `55390000-`.
- Service Plan items carry exactly one pricing sentinel —
  `Direct Support Item Number` (legacy) or `Support Item Number` (2026) — which
  is what keeps pricing resolution off the network in offline mode.
- The NDIS master items date on `Actual Shift Start Date and Time` (the word
  "and"); the SaH and statement paths read `Actual Shift End Date & Time`
  (ampersand). Both spellings are real.
- The legacy board carries one unapproved decoy master item that must never
  bill (`Timesheet Approval: "Pending"`).
- Mike Bird's captured rows were dated 2026-06-29 on dev; they are re-dated
  into January 2025 here so one slot bills all three boards.

## `care-management-55390-full.json`

**The full local replica of workspace `55390`** — every invoice-generator row
of the three Care Management boards as portal-dev served them on 2026-08-17
(65 SaH + 43 NDIS + 3 NEW rows, verbatim ids, dates, statuses, service codes),
plus the `invoiceNumbers` entries that mark dev's already-issued INV-1002 and
INV-1003. Person, bank and billing-contact values are invented; the SaH money
columns reproduce dev's computed totals **to the cent**
(24587.50 / 22319.70 / 1216.50), and Jane Smith's January 2025 monthly
statement summary matches dev's exactly (47 services, 286.25 h).

Division of labour between the two 55390 fixtures:

| | `care-management-automation.json` | `care-management-55390-full.json` |
|---|---|---|
| Purpose | armed, billable KAN-10 slot for e2e | portal-dev look-alike for manual/dev use |
| Rows | 22 invented, all billable in Jan 2025 | 160 captured, deliberately **not** billable |
| Schedules | automationSettings + 2 due scheduledJobs | none — data only |

Both write the same Business/Board docs, so loading both is safe but the lists
then show the union of rows; `--remove` one before loading the other when you
want exact dev parity.

Replication mechanics worth knowing:

- Reference items (service plans, funding sources) live on dev's real NDIS
  Library board `t29GNU4nV2A`, because offline mode has no ISO+ folder filter
  and anything on a CM board appears as a list row. Residual count delta vs
  dev: the on-board participant profiles (+3/+5/+1 rows), which must stay on
  their boards for the participants scans.
- SaH service plans carry `Service` (the label) and `Service ID/Item ID`
  (`SERV-00xx`) — the route prefers `Service Plan ID` and strips its prefix,
  which is why that attribute is deliberately absent.
- Approved NDIS rows reference zero-priced plans, so a scheduler tick over
  this data lists rows but can never mint an invoice.

## `care-management-statement-permutations.json`

**Full Monthly-Statement-picker coverage for workspace `55390`**: one delivered
service row per (board, participant, year 2022–2026, month), 540 rows total, so
every Participant × Month × Year combination the picker offers loads a
non-empty statement on all three Care Management boards. Amounts vary
deterministically per permutation (90/10 gov/participant split).

Composable with either 55390 fixture — ids are disjoint (`55390e00-` prefix)
and its profiles/plans/funding sources are self-contained. No row carries
`Timesheet Approval`, so no invoice path can ever bill them; they do appear in
the offline invoice-generator lists (offline mode has no ISO+ folder filter).
The route only month-filters when the caller passes `startDate`/`endDate` —
the UI always does; month/year alone returns the participant's full history.
Years mirror the 2026 picker (`currentYear-4 … currentYear`); regenerate the
file when 2022 falls off the dropdown.
