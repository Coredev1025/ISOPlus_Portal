# Google sign-in for support admins

How to set up, verify and operate support-admin sign-in in an environment (production, UAT).
Password sign-in for support admins is removed on `develop`, so **an environment without this
has no way for a support admin to sign in.** In production this is the hard blocker for the
release (stage 1 in [`README.md`](README.md)).

This guide describes what the code reads. It does not contain any secret, client id or
account identifier; those live in the Elastic Beanstalk environment properties and in Google.

## How it works

1. The login screen sends the browser to `GET /api/auth/google/redirect` on the backend. The
   backend builds a Google authorize URL with PKCE and a signed `state`, scopes `openid email
   profile`, `prompt=select_account`, and redirects (302).
2. Google returns to `GET /api/auth/google/callback`. The backend checks the state, the PKCE
   binding, exchanges the code, verifies the ID token and requires `email_verified`.
3. The backend asks the **Admin SDK Directory API** whether that email is a member of
   `GOOGLE_TARGET_GROUP`. It uses a service account with domain-wide delegation, acting as
   `GOOGLE_ADMIN_EMAIL`. A non-member is refused.
4. A member is found or created as a `support_admin` user and handed to the frontend through a
   one-time `OAuthTicket`. The session lasts 4 hours.
5. Every `GET /api/auth/verify` re-checks group membership (cached for 5 minutes), so removing
   someone from the group ends their access within minutes, not at the end of the 4 hours.

Two consequences worth knowing:

* **An existing user with the same email is promoted to `support_admin`** on a successful
  Google sign-in. Group membership is therefore the only gate. Keep the group small and review
  it.
* If the Directory lookup itself fails (as opposed to a definitive "not a member"), the user is
  refused unless their email is in `GOOGLE_SUPPORT_BREAK_GLASS_EMAILS`. That list never
  overrides a definitive "not a member".

## What you need to create in Google

Done by a Google Workspace super admin. Do production and UAT separately, each in its own
Google Cloud project with its own OAuth client and service account, so a UAT credential can
never sign anyone into production.

| # | Item | Where | Notes |
|---|---|---|---|
| 1 | A **Google Cloud project**, one per environment | Google Cloud console | Never shared between environments. |
| 2 | The **Admin SDK API** enabled | APIs and services > Library | Needed for the group lookup. |
| 3 | An **OAuth consent screen**, user type **Internal** | APIs and services > OAuth consent screen | Internal restricts sign-in to your Workspace domain. Scopes: `openid`, `email`, `profile`. |
| 4 | An **OAuth client**, type Web application | APIs and services > Credentials | Authorized redirect URI is exactly the callback URL below. Gives the client id and secret. |
| 5 | A **service account** | IAM and admin > Service accounts | No project roles needed. Create one JSON key. |
| 6 | **Domain-wide delegation** for that service account | Workspace admin console > Security > API controls > Domain-wide delegation | Client id is the service account's numeric id. Scope is exactly `https://www.googleapis.com/auth/admin.directory.group.readonly`. |
| 7 | A **Workspace group** of the people allowed in | Workspace admin console > Groups | Its address is `GOOGLE_TARGET_GROUP`. |
| 8 | A **dedicated Workspace user** to act as, one per environment | Workspace admin console > Directory > Users, then Account > Admin roles | Its address is `GOOGLE_ADMIN_EMAIL`. Delegation impersonates this user, so it needs the right to read groups, and nothing more: give it a role that can read groups (the built-in "Groups Reader" role if your edition has it, otherwise a custom role with Groups > Read), not Super Admin. One user per environment keeps each environment's Directory API calls separate in the audit log. It is never signed in to interactively. Not a person who may leave. |

The callback URL is `${BACKEND_URL}/api/auth/google/callback`, for example
`https://<backend host>/api/auth/google/callback`. It must match the redirect URI registered
on the client character for character, including the scheme.

## Production setup (read from the Admin Console on 2026-10-05)

Read-only look at Directory > Groups. Addresses and member emails are deliberately not recorded
here; the group address is the value of `GOOGLE_TARGET_GROUP` in production.

| | |
|---|---|
| Group display name | ISO Plus Portal - Support Admin |
| Direct members | 2, both owners |
| Labels | Mailing, Security |
| Access type | Custom |
| External members | Not allowed (keep it that way) |
| Admin roles on the group | None |

### Google Cloud (read from the console on 2026-10-05)

The organization has two projects: **ISO Plus Portal - DEV** (dev, see
[`08-google-signin-dev.md`](08-google-signin-dev.md)) and **ISO Plus Portal**. This section is
about the second. The console was read, nothing was changed.

| | |
|---|---|
| Consent screen audience | Internal |
| OAuth clients | One, Web application, created 27 Aug 2026 |
| Authorized redirect URI on that client | The **dev** backend callback (`https://<dev backend host>/api/auth/google/callback`) |
| Service accounts | None |

**This project is production's.** Decided 2026-10-05: production uses the project named
**ISO Plus Portal** (no suffix; the name is deliberately left as it is). It is not finished:

* Its one OAuth client ("ISO+™ Portal", Web application) was created on 27 Aug 2026 with the **dev**
  backend callback. On 2026-10-05 it was **reused for production** instead of creating a second one: the
  JavaScript origin is now `https://portal.isoplus.online` and the only redirect URI is
  `https://portal-backend.isoplus.online/api/auth/google/callback`. No localhost, no ngrok, nothing from dev.
  A new client secret was created that day and the original (created 27 Aug) has been deleted, so there is
  one secret. Verified from a fresh load of the saved client on 2026-10-05.

  | Client secret | Created | Use |
  |---|---|---|
  | ends `nRj_` | 2026-10-05 | **Production's.** The value goes in the secret store; this suffix is only for finding it |
  | ends `qrE5` | 2026-08-27 | Original. Deleted 2026-10-05 |

  Only the last four characters the console itself displays are recorded. Never write a full secret here.
* Pre-release check, 2026-10-06: Google's authorize URL for the production client and callback
  (`portal-backend.isoplus.online/api/auth/google/callback`) shows the account chooser with no
  `redirect_uri_mismatch`, so the client, its redirect URI and the consent screen are accepted. This needs no
  release and no secret; it stops at the account chooser. It does not test the delegation or the group lookup.
* Delegation and group lookup tested before the release, 2026-10-06: the production service account key was
  read from Secrets Manager into memory only (never written to disk or printed) and used to call the Directory
  API `members.hasMember` on the production group, impersonating the `GOOGLE_ADMIN_EMAIL` account, with the
  group-read scope only. Results: a group member returns `isMember = true`; an in-domain non-member returns
  `false`; an address on another domain returns HTTP 400 "Invalid Input: memberKey", which the app treats as
  not a member (`classifyDirectoryMembershipError` maps 400 and 404 to refusal). So the secret holds a valid
  key, the delegation entry and scope are right, and the admin account can read the group. Note that this
  reads the secret, so its "last retrieved" date in Secrets Manager moves.
* Its consent screen is Internal, the Admin SDK API is enabled, and its data access lists exactly the three
  basic scopes dev has (`openid`, `userinfo.email`, `userinfo.profile`) and no others (added 2026-10-05).
* Service account `workspace-group-checker` created 2026-10-05, enabled, with no project roles. Its Unique
  ID is needed for the delegation entry and is read from the account's details page; it is not recorded here.
* It has **one** key, created 2026-10-05, no expiry. The key ID begins `d6118397ea25` (the downloaded file
  is named `iso-plus-portal-<that prefix>.json`); this is only for finding the key, the private key is not
  recorded anywhere in the repository. It goes into Secrets Manager as `GOOGLE_SERVICE_ACCOUNT_JSON` and the
  local copy is deleted. Rotation is due on a schedule set by whoever owns this account; none is set yet.
* Domain-wide delegation is set up (2026-10-05): one entry named "ISO+™ Portal" for this service account,
  scope `admin.directory.group.readonly` only. It sits beside dev's own entry ("ISO+™ Portal - DEV") and an
  unrelated Letsignit entry.

Decided 2026-10-05: production uses the **same** account as dev for `GOOGLE_ADMIN_EMAIL`, the
organization's main admin account ("ISO CS Admin", Super Admin). This is an accepted deviation from step 8,
which recommends a dedicated groups-read user per environment. What it costs:

* Delegation still limits the service account to group reads, but the calls are made as a Super Admin who is
  also a human login.
* Dev and production Directory calls are made as the same user. They are distinguishable by the delegating
  service account, not by the user.
* If that account is renamed, suspended, or has its password policy changed, both sign-ins are affected.

Revisit by creating a dedicated groups-read user and changing the `GOOGLE_ADMIN_EMAIL` property; nothing else
needs to change.


## Environment properties

Set these on the Elastic Beanstalk environment (never in the repository). Setting a property
restarts the environment, so set all of them, and the other new release properties, in one change.

| Property | Value |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | From step 4 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | From step 4 |
| `GOOGLE_OAUTH_CALLBACK_URL` | Always set it. The code would default it to `${BACKEND_URL}/api/auth/google/callback`, but it is written out so the registered and the used value are visibly the same |
| `GOOGLE_ADMIN_EMAIL` | Step 8 |
| `GOOGLE_TARGET_GROUP` | Step 7 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The whole key file contents from step 5. Use this on Elastic Beanstalk; `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` is a path relative to `Backend/` and is for local use |
| `GOOGLE_SUPPORT_BREAK_GLASS_EMAILS` | Optional, comma separated. Leave empty unless you accept the risk described above |

The full set, with placeholders. Replace each `<...>`; never commit real values.

```bash
# Required
GOOGLE_OAUTH_CLIENT_ID=<client id from the environment's OAuth client>
GOOGLE_OAUTH_CLIENT_SECRET=<client secret, from the secret store>
GOOGLE_ADMIN_EMAIL=<shared Workspace admin mailbox the service account acts as>
GOOGLE_TARGET_GROUP=<address of the environment's support-admin group>
GOOGLE_SERVICE_ACCOUNT_JSON=<whole service account key JSON, from the secret store>

# Set explicitly, even though the code would default it from BACKEND_URL
GOOGLE_OAUTH_CALLBACK_URL=https://<backend host>/api/auth/google/callback

# Optional
GOOGLE_SUPPORT_BREAK_GLASS_EMAILS=<comma separated emails, or leave unset>

# Local development only, not used on Elastic Beanstalk
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=<path relative to Backend/, instead of the JSON variable>
```

On Elastic Beanstalk, `GOOGLE_SERVICE_ACCOUNT_JSON` is a Secrets Manager reference, never plain text
(production does it the way dev does; steps in
[`09-production-environment-properties.md`](09-production-environment-properties.md)), and
`GOOGLE_OAUTH_CLIENT_SECRET` should be too (dev holds the service account JSON that way already, see [`08-google-signin-dev.md`](08-google-signin-dev.md)). Do not set `GOOGLE_TARGET_GROUP`
blank in production: blank is the local offline setting and makes the group check report
`verify_error`.

The feature is on only when **all** of the client id, secret, callback URL, admin email, group
and a service account key with `client_email` and `private_key` are present. Anything missing
and `GET /api/auth/google/redirect` answers **503**.

Where the secret values are held (a vault, the Elastic Beanstalk console, a password manager)
is not decided in this repository. Record the answer in the production runtime guide when it
is written.

## Verify

Before the release, with the properties set on the target environment:

1. `GET <backend>/api/auth/google/redirect` in a browser. It must redirect to
   `accounts.google.com`, not return 503. A 503 means a property above is missing or the
   service account JSON did not parse; the backend log line "Google support redirect refused:
   not configured" lists which of them are set (never their values).
2. Sign in as a member of the group. You should land in the portal as a support admin.
3. Sign in as a Workspace user who is **not** in the group. It must be refused.
4. Remove the member from the group and call `/api/auth/verify` after the 5 minute cache
   window. The session must be revoked.
5. At least one real support admin has done step 2 and confirmed it. This is the release gate.

Do not run the release until step 5 is done; there is no password fallback.

## When it breaks

| Symptom | Likely cause |
|---|---|
| 503 from `/google/redirect` | A property missing or `GOOGLE_SERVICE_ACCOUNT_JSON` is not valid JSON (look for a pasted value that lost its newlines or quotes) |
| Google shows `redirect_uri_mismatch` | The registered redirect URI differs from `${BACKEND_URL}/api/auth/google/callback` or from `GOOGLE_OAUTH_CALLBACK_URL` |
| Signed in at Google, refused by the portal, group member | Directory lookup failing: delegation scope missing or mistyped, wrong `GOOGLE_ADMIN_EMAIL`, Admin SDK API not enabled. The log shows a `verify_error`, not a plain refusal |
| Refused and the log says not a member | The user is not in `GOOGLE_TARGET_GROUP`, or is only in a nested group the lookup did not resolve. Add them directly |
| Works, then everyone is refused | The service account key was deleted or rotated, or delegation was removed |
| Cannot sign in at all and Google is down | Add the one person to `GOOGLE_SUPPORT_BREAK_GLASS_EMAILS`, which only helps when the lookup fails, and remove them afterwards |

Logs are in the portal's Application Logs under the scope `Google-Auth`, `Google-OAuth` and
`Google-Directory`.

## Rotation and offboarding

* Service account keys **do not expire**. Rotate on a schedule: create a second key, set the
  new JSON, confirm sign-in, then delete the old key.
* The OAuth client secret can be reset in the console; update the property at the same time.
* Offboarding a support admin is removing them from the group. Their session ends within about
  5 minutes of their next request, and their `support_admin` user record stays but cannot sign in.

## Local development

Not needed. Local sign-in uses `npm run dev:login` and a blank `GOOGLE_TARGET_GROUP`; see
[`../local-development.md`](../local-development.md#logging-in-locally).
