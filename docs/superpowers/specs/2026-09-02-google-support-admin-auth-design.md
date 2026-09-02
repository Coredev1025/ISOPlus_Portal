# Google Support Admin Authentication

**Status:** Implemented  
**Date:** 2026-09-02

## Summary

Support agents sign in with Google OAuth instead of email/password. After Google verifies the user's identity, the backend uses a service account with Domain-Wide Delegation to confirm membership in a designated Google Workspace group before issuing a portal session.

## Architecture

1. **Frontend** — "Support agent sign-in" → "Sign in with Google" → backend redirect URL
2. **Google OAuth** — user authenticates; callback returns authorization code
3. **Backend callback** — exchange code, verify `email_verified`, check group via Admin SDK
4. **OAuth ticket** — one-time ticket handoff to frontend (same pattern as ISO+ OAuth)
5. **Session** — `POST /api/auth/oauth-exchange` creates `support_admin` JWT session

## Security properties

- **Fail closed** — Admin SDK errors and non-membership return 403 / redirect with `group_denied`
- **Verified email only** — rejects Google profiles where `email_verified !== true`
- **Signed OAuth state** — JWT state with flow `google-support-login`; ISO+ state rejected on Google callback
- **No secrets in repo** — OAuth client secret and service account key via env only
- **Group as source of truth** — access managed in Google Workspace, not DB allowlists
- **Password login removed** — `POST /api/auth/login` returns 404

## Environment variables

See `Backend/.env.example`. Required for support sign-in:

| Variable | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Web OAuth client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Web OAuth client secret |
| `GOOGLE_OAUTH_CALLBACK_URL` | Defaults to `${BACKEND_URL}/api/auth/google/callback` |
| `GOOGLE_ADMIN_EMAIL` | Workspace admin impersonated for DWD |
| `GOOGLE_TARGET_GROUP` | Group email used for access control |
| `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Service account credentials |

## Local development

- Add your local/ngrok callback URL to the Google OAuth client's authorized redirect URIs
- Ensure your Google account is in the target Workspace group
- E2E tests use `Backend/scripts/e2e-support-ticket.mjs` (inserts a one-time ticket in local Mongo — not an app auth bypass)

## Changes since approval

N/A — initial implementation.
