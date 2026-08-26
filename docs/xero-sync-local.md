---
name: xero-sync-local
description: >-
  Use when connecting the local ISO+ Portal to Xero, testing quote/invoice sync
  into a Xero organisation, verifying GST vs GST-free tax mapping (OUTPUT vs
  EXEMPTOUTPUT), debugging the Xero OAuth consent flow or callback, setting up
  a Xero developer app for local work, or when a Xero consent request is
  refused over scopes. Covers the Accounting Integrations tab, XERO_* env
  variables, and firing the board's Xero webhook against a local backend.
---

# Xero sync, locally

Verified end to end on 2026-08-14: real quotes `QU-0001` (10% GST) and
`QU-0002` (GST-free) created in a real Xero organisation from the local stack,
fired through the ngrok tunnel the way an ISO+ board automation fires.

## Env check — run this first

Every value lives in `Backend/.env` (gitignored). All four must be set:

```bash
cd <repo root>
for k in XERO_CLIENT_ID XERO_CLIENT_SECRET XERO_REDIRECT_URL XERO_SCOPES; do
  v=$(grep -E "^${k}=" Backend/.env | head -1 | cut -d= -f2-)
  [ -n "$v" ] && echo "  $k = SET (${#v} chars)" || echo "  $k = EMPTY"
done
```

Expected shapes: client id **32 chars**, secret **48 chars**,
`XERO_REDIRECT_URL` ends in `/api/xero/callback` on an **https** host (the
ngrok tunnel; Xero only allows plain http for localhost redirects). After any
change: `docker compose up -d --force-recreate --no-deps backend`.

Sanity probe — the consent URL must build without error and echo your scopes:

```bash
curl -sS localhost:4001/api/xero/redirect
# {"url":"https://login.xero.com/identity/connect/authorize?client_id=…&scope=…"}
```

## The scope trap (apps created after 2 March 2026)

Xero apps created after that date only receive the **new granular scopes**.
The code's built-in default requests the retired broad ones
(`accounting.transactions`, `accounting.reports.read`) — consent for a new app
is refused with those. `XERO_SCOPES` (space-separated) overrides the request
per environment; the default stays broad because the production app is older
and grandfathered until Sept 2027. A working granular set for the quote flow:

```
XERO_SCOPES=openid profile email accounting.settings accounting.contacts accounting.invoices accounting.attachments accounting.payments offline_access
```

## Creating the app (developer.xero.com/app/manage)

New app → **Web app** (standard auth code — what `xero-node` with a client
secret uses). Redirect URI = the tunnel callback. After creating, on
*Configuration*: **Copy** the Client id and **Generate a secret** (shown once);
both go into `Backend/.env` by hand.

## Connecting — the Portal button, never a bare consent URL

Tokens are persisted by the **backend OAuth callback** after the user completes
consent (full-page redirect; see KAN-9 handover). Open the Accounting
Integrations tab as a **workspace client or portal staff** — mapping APIs are
`authenticateToken` only, not Owner/Support Admin:

`/workspace/<id>/finance-settings?tab=accounting`

- **Connect Xero** when not integrated → approve login + organisation.
- **Reconnect Xero** when tokens are present but reconnect is required (expired
  auth / no organisation). **Disconnect is hidden** in that state so the user
  re-authorises instead of wiping the link first.
- **Disconnect Xero** when the connection is healthy.

Verify persistence:

```bash
docker exec -i isoplus-mongo mongosh business-dashboard --quiet --eval '
  const b=db.businesses.findOne({workspaceId:"55369"},{xeroIntegrated:1,xeroTenantId:1,xeroTokens:1});
  print(b.xeroIntegrated, !!b.xeroTenantId, !!b.xeroTokens?.accessToken, !!b.xeroTokens?.refreshToken)'
# true true true true
```

The tab shows **Connected**; *Test Connection* exercises the stored tokens. A
client hitting `GET /api/business/xero/account-tax-options` must **not** receive
`403` Owner/Support Admin — that gate was removed so Finance Settings mapping
works for `isoplus_user`.

## GST — how a tax rate is chosen, and how to test both

`pickGstValue(values.GST)` → `resolveSalesLineMapping(business, docType,
gstValue, accounts, lineKind)`:

- a mapping saved on the Accounting Integrations tab wins if present;
- unmapped, a GST-ish value (`10%`) resolves to **`OUTPUT`** (10% GST on
  income) and anything else to **`EXEMPTOUTPUT`** — NDIS lines are normally
  GST-free, which is why that is the fallback.

Fire both through the tunnel (the same route the board's `Portal - Xero (for
NDIS Quote)` ButtonTrigger automation calls). Offline mode must be on for the
item guard and references; the Xero half is real:

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  https://<tunnel>/api/xero/55369/eNiJpH14PN3/quotendis \
  -d '{"items":[{"id":"fixture-quote-legacy-pricing","values":{
    "Issue Date":"2026-08-14","Expiry Date":"2026-10-08",
    "Recipient of the Quote":"Sam Fixture","Recipient Email":"sam.fixture@example.test",
    "Recipient Address":"3 Sample Road","Suburb":"Testville","State":"VIC","Postcode":"3000",
    "GST":"10%",
    "Direct Support Item Number":"01_011_0107_1_1",
    "Quantity (Direct Support)":2,"Unit Price for Direct Support($)":62.17,
    "Unit (Direct Support)":"Hour"}}]}'
```

Observed with `"GST":"10%"`:

```
QU-0001  line 2 × 62.17  taxType OUTPUT       taxAmount 12.43  total 136.77
```

and with `"GST":"GST Free"`:

```
QU-0002  line 3 × 50.00  taxType EXEMPTOUTPUT taxAmount 0      total 150.00
```

Both DRAFT, in the connected organisation, contact auto-created. Verify in
Xero's UI under Business → Quotes.

**The body must carry `Recipient Email`, `Suburb`, `State`, `Postcode`** —
contact building reads them and `Postcode.toString()` is unguarded, so a
missing postcode is a crash, not a validation message.

## Traps, each hit on a real run

| Symptom | Cause |
|---|---|
| Consent refused / invalid scope | new app + broad default scopes — set `XERO_SCOPES` (see above) |
| Connected once, gone after reconnecting the browser | consent was opened as a bare URL; tokens only persist via the Portal's popup flow |
| `unauthorized_client` at consent | redirect URI mismatch — the app's registered URI must equal `XERO_REDIRECT_URL` exactly |
| Route replies "reconnect to Xero" | no `Business.xeroTokens` for the workspace, or refresh token expired (~60 days) |
| Works, then 401s after a backend recreate | it should NOT — tokens live in Mongo, not memory; if it does, check `ensureAuthenticated` found the workspace |
| `CRITICAL: Item does not exist` | ISO+ offline-mode item guard, not Xero — see `testing-kan10-end-to-end` |

## What this cannot prove

Local Xero sync is real Xero: quotes land in a genuine organisation. What it
does **not** exercise is production's token lifecycle at scale (many
workspaces), or the older broad-scope app production still uses — do not
change the built-in scope default on this evidence alone.

## Related

- `docs/testing-kan10-end-to-end.md` — offline mode, fixture, tunnel, outbox
- `activate-ngrok` skill — the tunnel the callback and webhooks ride
- `Backend/src/services/xero.js` — client, scopes, `ensureAuthenticated`
- `Backend/src/utils/xeroLineItemMapping.js` — the GST resolution table
