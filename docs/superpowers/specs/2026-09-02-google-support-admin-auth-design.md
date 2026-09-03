# Google Support Admin Authentication

**Status:** Implemented  
**Date:** 2026-09-02  
**Updated:** 2026-09-03 (client security review)

## Summary

Support agents sign in with Google OAuth instead of email/password. After Google verifies the user's identity (ID token), the backend uses a service account with Domain-Wide Delegation to confirm membership in a designated Google Workspace group before issuing a portal session.

## Architecture

1. **Frontend** — "Support agent sign-in" does a **top-level** navigation to `GET /api/auth/google/redirect` (not XHR), so the PKCE session cookie is set on the API host Google will call back to  
2. **Backend redirect** — stores signed OAuth `state` + **PKCE** in the pre-auth session, then **302** to Google  
3. **Google callback** — bind `state` to session (CSRF), exchange code with PKCE, **verify ID token** (JWKS / `aud` / `iss` / `email_verified`)  
4. **Directory check** — Admin SDK `hasMember` (includes **nested** group membership)  
5. **OAuth ticket** → frontend `/?ticket=` → `POST /oauth-exchange` → **httpOnly** session cookie (`sameSite: 'lax'` locally / `'none'` in production)

## Access semantics (important)

| Event | Effect |
|---|---|
| User **added** to the Workspace group | Can sign in on next Google login |
| User **removed** from the group | **Not instant.** Membership is re-checked on `GET /api/auth/verify` (5-minute cache). Support-admin JWT lifetime is **4 hours**. Worst case without hitting `/verify`: up to 4h. |
| Directory API **outage** at login | Fail closed → `verify_failed` (distinct from `group_denied`), unless break-glass email |
| Directory API **outage** on `/verify` | Session kept **without** minting a new JWT (existing token expires naturally). Definitive `not_member` clears the session. |


`hasMember` resolves nested groups: adding a group as a member of the access group silently expands who can sign in.

## Security properties

- Signed OAuth `state` + PKCE session binding (login CSRF)
- ID token verification via Google JWKS; `aud` must be this app's web client ID
- User key is Google **`sub`** (`oauthId`), not email
- Fail closed on Directory errors at login; user sees `group_denied` vs `verify_failed`
- Optional `GOOGLE_SUPPORT_BREAK_GLASS_EMAILS` — only when Directory returns `verify_error`, never for definitive non-members
- Password login removed (`POST /api/auth/login` → 404)

## Config labelling (do not confuse)

| Value | What it is |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` = `xxxxx.apps.googleusercontent.com` | **Web** OAuth client (authorize URL / ID token `aud`) |
| Service account `client_id` (numeric, e.g. `106493…`) | Paste into Workspace **Domain-Wide Delegation** only |
| `GOOGLE_ADMIN_EMAIL` | DWD **subject** — prefer a dedicated Groups-Read admin account, not a personal super-admin |

## Environment variables

See `Backend/.env.example`. Prefer `GOOGLE_SERVICE_ACCOUNT_JSON` from vault/EB over a disk key file; rotate keys (they do not expire).

## Local development

- Authorized redirect URIs must include your callback (ngrok/local)
- Enable **Admin SDK API** on the GCP project that owns the service account
- Ensure DWD scope `admin.directory.group.readonly` is granted to the SA client ID
