# Webhooks and automation — endpoint map and test seed

**Status:** In progress. No ticket yet.
**Verified against:** workspace `55369` ("Test"), board `eNiJpH14PN3` ("Care Management (NDIS) 2026 Pricing"), read live on 2026-08-05 (automations) and 2026-08-06 (attributes, items, quote 17), plus backend source.
**Coverage:** one board, fully (41 automations, 511 attributes). Other boards in the workspace not yet enumerated — see [Not yet covered](#not-yet-covered).

Read-only throughout: automations, attributes and items were read; quote 17 was opened. Nothing was saved, deleted, toggled or test-triggered.

---

## Corrected system map

An earlier source-only pass found three systems. Traversing the live board showed **five** route families receive automation traffic, and the two biggest were missing.

| Family | Mount | Reached by | Auth |
|---|---|---|---|
| `/api/care-management-ndis-pricing` | `index.js:143` → `routes/ndis.js` | Board automations (22 of 26) | none |
| `/api/pdf` | `index.js:139` → `routes/webhook.js` | Board automations (2) | none |
| `/api/xero` | `index.js:137` → `routes/xero.js` | Board automations (2) | none |
| `/api/age-care` | `index.js:144` → `routes/ageCare.js` | Not on this board | none |
| `/api/webhooks/isoplus` | `index.js:140` | ISO+ platform sync events | none |
| `/api/automation` | `index.js:132` | Portal UI (management, not traffic) | session + role |

---

## How a board automation actually triggers the backend

Each ISO+ automation is a workflow of nodes. The shape, straight from `GET /api/55369/automations/eNiJpH14PN3`:

```json
{ "id": "019f02f7-…", "name": "Portal - Update Support Item Number (for ServicePlan)",
  "active": true, "board_id": "eNiJpH14PN3", "team_id": 55369,
  "workflow": [
    { "id": "019f02f8-…", "name": "ValueChange",
      "outputs": { "main": "019c9206-…" },
      "config": { "attributeId": "019efd37-866f-7266-a2d6-6de8458096c9" } },
    { "id": "019c9206-…", "name": "TriggerWebhook", "input": "019f02f8-…",
      "config": { "url": "https://portal-backend.isoplus.online/api/care-management-ndis-pricing/55369/eNiJpH14PN3/participants-service-plan?type=support" } }
  ] }
```

The trigger node has no `input`; the `TriggerWebhook` node carries `config.url`. This is exactly the structure `buildUpdatedAutomation` walks (`utils/automationUrlUpdate.js:42`) when rewriting URLs — it maps `workflow[].config.url`.

**Trigger node kinds on this board:** `ValueChange` ×25, `ButtonTrigger` ×13, `DueDateItems` ×3. So "the field that triggers the webhook" is `config.attributeId` on a `ValueChange` node — **19 distinct attribute ids** across the board. `ButtonTrigger` automations fire from a button on the item, not from any field.

**Other node kinds present** (not webhook-related): `UpdateItem`, `Filter`, `CreateComment`, `AIUpdateItem`, `Notification`, `MoveItem`, `Email`.

### Inventory: 41 automations, 26 prefixed `Portal - `

All 26 point at `portal-backend.isoplus.online` — one host, no stragglers.

**22 → `participants-service-plan`, differentiated only by `?type=`:**

| `?type=` | Automations |
|---|---|
| `update_service_plan_variables` | 3 |
| `provider_travel_non_labour_cost` | 2 |
| `direct_support` | 2 |
| `centre_capital_cost` | 2 |
| `service_area` | 2 |
| `activity_based_transport` | 2 |
| `support` | 1 |
| `labour_travel_time_cost` | 1 |
| `cancellation_cost` | 1 |

**4 → `ButtonTrigger`, different families:**

```
Portal - PDF Invoice (for MasterPlan)   → /api/pdf/55369/eNiJpH14PN3/invoicendis
Portal - PDF (for NDIS Quote)           → /api/pdf/55369/eNiJpH14PN3/quotendis
Portal - Xero Invoice (for MasterPlan)  → /api/xero/55369/eNiJpH14PN3/invoicendis
Portal - Xero (for NDIS Quote)          → /api/xero/55369/eNiJpH14PN3/quotendis
```

All four exist in the backend (`routes/xero.js:451,710`; `routes/webhook.js:1701` and the quote handlers).

**15 automations are not prefixed `Portal - `** — `Standard Shift Clock In`/`Out`, `AI-assisted Shift Notes`, `Timesheet submission for approval`, `Archived Contacts`, `Documents Renewal Review`, `Send Fund Summary Report`, `Discontinued Clients`, and others. `PUT /api/automation` skips every one of them, by design (`automationUrlUpdate.js:38`). None currently calls the Portal, so nothing breaks today — but the prefix is the *only* thing binding an automation to the rewrite.

---

## The finding that matters most

`POST /api/care-management-ndis-pricing/:ws/:board/participants-service-plan` has **two dispatch paths**, chosen per request by `automationUsesNewNdisPricing(workspaceId, boardId, items.id, itemsValues)` at `routes/ndis.js:853`. **They accept different sets of `?type=`.**

| `?type=` | New path (`ndis.js:685`) | Legacy path (`ndisRoutePricingHelpers.js:200`) | Live automations |
|---|---|---|---|
| `service_area` | yes | yes | 2 |
| `activity_based_transport` | yes | yes | 2 |
| `provider_travel_non_labour_cost` | yes | yes | 2 |
| `update_service_plan_variables` | yes | yes | 3 |
| `support` | yes | **no** | 1 |
| `labour_travel_time_cost` | yes | **no** | 1 |
| `cancellation_cost` | yes | **no** | 1 |
| `direct_support` | **no** | yes | 2 |
| `centre_capital_cost` | **no** | yes | 2 |

So of the 22 live automations on this board:

- **4** (`direct_support`, `centre_capital_cost`) return `{"error":"Invalid type"}` when the item routes to the **new** path.
- **3** (`support`, `labour_travel_time_cost`, `cancellation_cost`) return `{"error":"Invalid type"}` when the item routes to the **legacy** path.

Which path an item takes is data-dependent, so the same automation succeeds or silently no-ops depending on the item it fires for. **Every one of these returns HTTP 200**, so ISO+ records a successful delivery either way. The legacy branch even reports `"Invalid type in set-unit"` while serving `participants-service-plan` — a copy-paste artifact that makes the logs misleading.

**Confirmed on 2026-08-06: the board resolves to `new`, so the type split is a live defect, not latent.**

Read from `GET /api/55369/eNiJpH14PN3/attributes` (511 attributes):

| Sentinel in `ndisPricingRules.js` | On the live board |
|---|---|
| `Direct Support Item Number` (`:6`, legacy) | **absent** — renamed `OLD Direct Support Item Number`, still type `reference` |
| `Support Item Number` (`:7`, new) | present, type `reference` (`019efd37-866f-7266-a2d6-6de8458096c9`) |

`boardAttributesUseLegacyNdisPricing()` needs a `reference` attribute named
*exactly* `Direct Support Item Number`. The `OLD ` prefix means it finds none, so
`hasLegacy` is false, `hasNew` is true, and the board resolves to **new**. (A
second `Support Item Number` of type `text` also exists; `isReferenceAttribute()`
correctly ignores it.)

The per-item override cannot save the legacy automations either. ISO+ keys
webhook `values` by attribute *name*, so a `direct_support` automation now sends
`OLD Direct Support Item Number` — which matches neither sentinel,
`inferPricingRuleFromServicePlanData()` returns null, and dispatch falls through
to the board rule. So the **4 automations sending `?type=direct_support` and
`?type=centre_capital_cost` return `{"error":"Invalid type"}` on every fire**,
at HTTP 200, with ISO+ recording a successful delivery.

The `OLD ` rename is the whole cause. Renaming a column in the ISO+ UI silently
repoints backend dispatch, with no error anywhere. The same migration renamed
`Provider Travel - Non-Labour Cost Item Number` the same way, keeping both.

Reproduce offline: `npm run dev:fixture` (see [Using this as a test seed](#using-this-as-a-test-seed)).

### Also still open from the source pass

- **`hookSecret` is stored and never verified.** Written in three places, nulled in three, read nowhere. No HMAC, no signature header, no auth on the `/api/webhooks` mount. Anyone who can reach the host can POST a crafted `item.updated`.
- **Callback URL falls back to `http://localhost:3001`** when `BACKEND_URL` is unset (`webhookServiceHelpers.js:12`), and registration still succeeds.
- **API version skew** — registration sends `2026-04-20.morava`, write-back sends `2025-02-26.morava`.

### A trap for anyone auditing these by eye

The URL field in the ISO+ automation editor **truncates without any indication**. `?type=update_service_plan_variables` displays as `?type=update_service`, which looks like an invalid type. I nearly filed that as a bug. Click into the field and press `End`, or read `GET /api/<team>/automations/<board>`, which is authoritative.

---

## Using this as a test seed

The 26-row inventory is a ready-made contract fixture: it is the exact set of requests production actually sends. Proposed shape, smallest first.

**1. Freeze the inventory as a fixture.** Commit `Backend/test/fixtures/automations.<board>.json` — the trimmed `GET /api/<team>/automations/<board>` response (name, active, trigger kind, `attributeId`, webhook URL). No customer data: names, ids and URLs only. Regenerate deliberately, and diff it in review — a changed fixture then means someone changed an automation in ISO+.

**2. Route-coverage test (no HTTP).** Parse each fixture URL, assert an Express route exists for it. Catches an automation pointed at an endpoint that was renamed or never existed, which today fails silently at 200. Cheap, no database, no network.

**3. Type-dispatch table test.** Drive the two dispatch functions directly with all nine live `?type=` values × both paths, asserting the matrix above. This is where the split gets pinned down — and where a fix gets a regression test. Pure functions, no I/O.

**4. Payload-contract tests.** Per family, assert the documented entry conditions: missing `items[]` → `No items found in the payload`; absent `Business` → `Business not found`; unknown `?type=` → `Invalid type`. Each asserts the **body**, not the status, since everything is 200.

**5. Inbound sync-hook tests.** Post each of the eight `BOARD_WEBHOOK_EVENTS` to `/api/webhooks/isoplus` with a minimal payload, assert each is handled rather than falling to the ignore branch. Add the negative cases (`{}`, missing `payload`) for the 400. When signature verification is added, this file is where it gets tested.

**Seed data — done, 2026-08-06.** `Backend/test/fixtures/ndis-quote-board.json` plus `npm run dev:fixture` (`Backend/scripts/dev-fixture.mjs`, wired into `dev.mjs` alongside `seed`). Committed and invented, where `seed/` is gitignored and real; additive, where `seed` is destructive. It provides the board with known `attribute.id` / `pdfAttribute.id` that the dump does not, quote 17 as it actually stands, and the four ISO+ webhook bodies — replayable with `--replay <name> [--dry-run]`.

The non-obvious part, and the reason the fixture items look odd: **step 3 of `resolveNdisPricingRuleForAutomation()` cannot work offline.** It calls the live ISO+ API; `getBoardAttributes()` fails, `boardUsesLegacyNdisPricing()` swallows that and returns `true`, so locally every item resolves to `legacy` — the exact opposite of production. Anyone testing this path against a local stack and trusting the result will draw the wrong conclusion. The fixture therefore carries the sentinel keys in `Item.data` so dispatch settles at step 1 or 2, before the network. `--list` prints which rule each item takes.

**Order.** Steps 2 and 3 need no infrastructure and would have caught the type split; do those first.

**The runner prerequisite is resolved.** PR #848 added **Vitest** to `develop`, with `mongodb-memory-server`, `msw` and `supertest`, and integration tests covering `board`, `business`, `workspace`, `auth`, `webhooks` and `isoplusWebhook` routes. `npm test` in `Backend/` runs it; `npm run test:api:live` (`RUN_REAL_API_TESTS=1`) is the separate live-ISO+ config. Write the steps above as `test/**/*.test.js` — `vitest.config.js` collects that pattern only.

`msw` matters for step 3 in particular: the dispatch split turns on `getBoardAttributes()`, so the two paths can now be driven by mocking the ISO+ attributes response rather than by reaching the network or waiting on a real board.

---

## Not yet covered

- **Other boards in workspace 55369.** Only `eNiJpH14PN3` was enumerated. `/api/55369/boards` is 404; the per-board endpoint is `/api/55369/boards/<id>`, so listing needs the Boards menu or a known id. `/api/me/workspaces` confirms exactly one workspace.
- **`/api/age-care`** receives no automation traffic on this board. Its two routes may be driven from another board.
- **Whether other boards were migrated the same way.** The `OLD ` rename was found on `eNiJpH14PN3` only. Any other NDIS board carrying the same rename has the same broken automations.
- **The 18 quote items' actual values.** Only quote 17 was read in full; it is nearly empty (4 values), so it exercises the fall-through but not the populated-quote PDF path.
- The ISO+ automations endpoint only responds while the automations panel is open; a standalone fetch afterwards returns 403. Relevant to anyone scripting this.

## Before this becomes a plan

Needs a ticket. The `hookSecret` gap and the type split are arguably two separate bug tickets, independent of the documentation and the test work.
