# KAN-9 — Accounting Integrations tab (handover)

Delete this file on merge.

## PR description (paste into gh pr create)

### Summary

Adds the Finance Settings **Accounting Integrations** tab (Epic 4): multi-provider panel with Xero
connect/test, account + tax mapping for Quote / Purchase Order / Invoice, quote line-item overrides,
and disabled future sync toggles. Replaces the old popup OAuth flow with a full-page redirect using
signed state and a one-time connect ticket — the old flow posted Xero tokens via `postMessage` to
`*` and accepted client-supplied tokens on `POST /api/business/xero/connect`.

### Ticket

KAN-9

### What's included

- **Frontend:** Accounting integrations panel, Xero connect section, account/tax mapping UI, audit
  log dialog, OAuth return handling on dashboard and finance-settings.
- **Backend:** Secure Xero OAuth redirect/callback, connect ticket model, mapping resolution wired
  into Xero document pushes, audit trail for connect events.
- **Migrations:** `remove-xero-connection-logs`, `audit-trail-workspace-category-index`.

### Blast radius

- **Apps:** Backend + Frontend.
- **OAuth flow changed:** popup + `postMessage` removed; full-page redirect with signed state +
  one-time ticket. `GET /api/xero/redirect` now requires auth. `POST /api/business/xero/connect`
  deleted. **Deploy action:** update Xero app redirect URI per environment to match
  `XERO_REDIRECT_URL` (backend callback, not frontend popup).
- **Stored data:** migrations drop `businesses.xeroConnectionLogs` (events moved to AuditTrail).
- **API responses:** audit list index added; no breaking changes to existing authenticated routes.
- **Auth / sync / PDF / Xero:** Xero OAuth and invoice/quote/PO push mapping behaviour touched.

### New dependencies

None.

### Migrations

Two migrations included. They **do not run automatically on deploy** — run deliberately:

```bash
cd Backend
npm run migrate -- up remove-xero-connection-logs --allow-remote   # if needed on remote
npm run migrate -- up audit-trail-workspace-category-index --allow-remote
```

### Verification

```text
Backend/ — npm test: 158 files, 3605 tests passed
Frontend/ — npm test: affected Xero/toast suites pass; 27 failures on Node 25 pre-existing
  (localStorage.clear is not a function in theme-toggle.test.tsx — same on origin/develop)
```

Commands run for this review pass:

```text
Backend — npm test (full suite): passed
Frontend — npm test test/unit/toast-utils-dismiss.test.ts test/unit/lib/xero-oauth-return*.ts*
  test/unit/lib/xero-account-tax-mapping-options.test.ts test/unit/lib/xero-integration-errors.test.ts: 22 passed
Backend — npm test test/unit/utils/xeroOAuth*.test.js test/unit/utils/xeroConnectHelpers.test.js
  test/unit/models/oAuthTicket.test.js: 22 passed
```

### Follow-ups / open decisions

1. **Tax rate dropdowns** list every tenant rate filtered by `canApplyToRevenue` /
   `canApplyToExpenses`, not only the four names in the PDF (GST on Income, GST Free Income, etc.).
   **Decision:** intentional — more flexible; ISO+ does not validate exotic tax types client-side.
2. **Line-item overrides** are Quote-only, matching the PDF's stated assumption. Purchase Order and
   Invoice have document-level mapping only. Confirm with client before extending.
3. **Node 25 frontend suite:** track separately — jsdom `localStorage` shadowed by Node built-in.

## Review pass (over-engineering)

Addressed at commit after a8bd86b: removed ~180 lines of indirection (toast test patches to
vitest.setup, dead backend constants, duplicated failure-message table, collapsed helpers, shared
ticket schema, single OAuth return export).
