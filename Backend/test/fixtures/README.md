# Test fixtures

Committed, invented data that reproduces a real ISO+ scenario locally.

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

Workspace `55369` / board `eNiJpH14PN3` ("Care Management (NDIS) 2026 Pricing"),
the Quotes folder, and the four ISO+ webhook bodies that reach the Portal from
it. Structure was read live on 2026-08-06; every person, address and contact
value is invented.

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
