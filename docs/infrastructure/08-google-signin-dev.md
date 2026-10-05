# Google sign-in: the dev environment as built

What exists in Google for the **dev** environment, read from the consoles on 2026-10-05. This is a
record of a working setup, kept apart from production on purpose. The steps to build one are in
[`07-google-signin.md`](07-google-signin.md); production is described there, not here.

Nothing was changed while reading. No client secret, key, client id or member email is recorded.

## What exists

| Piece | Dev |
|---|---|
| Google Cloud project | ISO Plus Portal - DEV |
| Consent screen audience | Internal |
| OAuth client | "ISO Plus Portal - SSO - DEV", Web application, created 2 Sep 2026, last used 1 Oct 2026 |
| Authorized JavaScript origins | The dev frontend host, and `http://localhost:3000` |
| Authorized redirect URIs | The dev backend `/api/auth/google/callback`; an ngrok tunnel callback; `http://localhost:3001/api/auth/google/callback` |
| Service account | `workspace-group-checker`, in the same project |
| Domain-wide delegation | One entry, "ISO+ Portal - DEV", with the single scope `admin.directory.group.readonly` |
| Workspace group | ISO Plus Portal - Support Admin - DEV, 4 direct members |

Dev is wired exactly as the guide describes: one project, Internal consent, one Web client, a
service account delegated with the read-only group scope, and a group that gates access.

## Things that are right for dev and must not be copied to production

* **The localhost and ngrok redirect URIs and the localhost origin.** They let a developer sign in
  against a local or tunnelled backend. Production's client has only the production callback.
* **The ngrok entry is a temporary tunnel address.** It will stop working when the tunnel does and
  can be removed.
* **The same Workspace domain holds dev and production.** The Internal audience therefore does not
  separate the two; the separation is the project, the client and the group.

## How dev's environment is configured (Elastic Beanstalk `isoplus-be-dev-blue`)

Read from the console on 2026-10-05. Values that are secrets are not recorded.

| Property | What it is in dev |
|---|---|
| `GOOGLE_ADMIN_EMAIL` | A shared admin mailbox on the Workspace domain, not a named person's address (the recommended pattern) |
| `GOOGLE_TARGET_GROUP` | The dev support-admin group address |
| `GOOGLE_OAUTH_CALLBACK_URL` | Set explicitly to the dev backend callback (it matches `BACKEND_URL`) |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | The DEV project's client, held as plain text environment properties |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | **Held in AWS Secrets Manager** and referenced by the environment, not pasted in |

So the service account key is already in Secrets Manager in dev. The OAuth client secret and every other
credential in the environment (database, session, JWT, Xero, ISO+ and the scheduler keys) are plain text
properties, readable by anyone who can open the environment configuration. For production, hold the
secrets in Secrets Manager the way the service account key is.

Other facts about the environment: Node.js 22 on Amazon Linux 2023, load balanced, 1 instance
(minimum and maximum), `AUTOMATION_ENABLED` is `true`, Redis is ElastiCache Serverless in cluster mode,
and the buckets are `isoplus-portal-dev` and `isoplus-portal-dev-public`.

## Not recorded here

* Who holds the dev client secret outside AWS (the console shows it, so a copy may not exist elsewhere).
* Whether dev's secrets have been rotated since being readable in the environment configuration.

## Another project in the organization

The organization also has a project named **ISO Plus Portal** (no suffix). It has one Web client,
created 27 Aug 2026, whose only redirect URI is the dev backend callback, and no service account.
It is older than the DEV client and does not do the group lookup, so it is not what dev uses today.
Whether it is the intended production project or leftover is a decision for the production build,
recorded in [`07-google-signin.md`](07-google-signin.md).
