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

## Cross-check of dev against the guide (2026-10-05)

Each item the guide asks for, and what dev shows. Used to check the production build for gaps.

| Guide step | Dev | Matches the guide |
|---|---|---|
| 1 Project per environment | "ISO Plus Portal - DEV" | Yes |
| 2 Admin SDK API enabled | Enabled, and in use: 17 requests in the 24 hours read, median latency about 200 ms | Yes |
| 3 Internal consent screen | Internal | Yes |
| 4 Web OAuth client | One, with dev, localhost and ngrok redirect URIs | Yes, plus dev-only extras |
| 5 Service account | `workspace-group-checker` | Yes |
| 6 Domain-wide delegation | One entry, scope `admin.directory.group.readonly` only | Yes |
| 7 Group | 4 direct members | Yes |
| 8 Admin mailbox | The main Super Admin account, set as `GOOGLE_ADMIN_EMAIL` | **No.** Works, but over-privileged (see below) |

Observations worth following up, not copying:

* **The Admin SDK showed a 70% error rate over the 24 hours read (17 requests).** A group lookup for a
  person who is not a member can legitimately end as an error response, so this may be normal, or it may
  be a real fault. The portal's Application Logs under `Google-Directory` separate the two: a plain
  "not a member" is an expected deny, a `verify_error` is a fault. Check before assuming dev is the
  reference for a healthy setup.
* **The project came with about 23 default APIs enabled** (BigQuery, Cloud Storage, Logging and others).
  Only the Admin SDK API is needed. A new production project should enable the Admin SDK API and leave
  the rest as Google provides them; do not enable more.
* **The older project "ISO Plus Portal"** also has the Admin SDK API enabled, but showed no traffic over
  30 days. This supports it being unused for sign-in.

Read from the console on the same day:

| Item | Dev |
|---|---|
| Consent screen data access scopes | Exactly `openid`, `userinfo.email` and `userinfo.profile`. No sensitive or restricted scopes. Matches the guide |
| Project IAM | Two people, both organization administrators (inherited); one is also project Owner. The service account holds **no** project roles, which is what the guide wants |
| Service account keys | **Two active keys**, created 2 Sep and 8 Sep 2026, neither with an expiry date |

Findings for the production build:

* **Two active keys is one more than needed.** One is in use (it is the value in Secrets Manager); the
  other is probably left from setup. An unused key is still a working credential. Find out which one the
  environment uses, then delete the other. For production, create one key and keep it to one, except
  briefly during a rotation (see "Rotation and offboarding" in [`07-google-signin.md`](07-google-signin.md)).
* **Dev impersonates a Super Admin.** Delegation limits what the service account may *call* (group read
  only), but the calls are made *as* the impersonated user, who here is the organization's Super Admin
  and a login people use. That is more identity than the lookup needs, and it ties dev's Directory activity
  to a human-used account in the audit log. Production deliberately does not copy this (its own dedicated
  groups-read user, see [`07-google-signin.md`](07-google-signin.md)). Whether to tighten dev the same way
  is a separate change: create a dedicated user, give it a groups-read role, change dev's
  `GOOGLE_ADMIN_EMAIL`, and check sign-in still works.
* **Dev's role could read every secret in the account, and was narrowed on 2026-10-05.** Its inline policy
  `ElasticBeanstalkSecretsManagerAccess` allowed `secretsmanager:GetSecretValue` on `Resource: "*"`. It now
  names dev's one secret (`GOOGLE_SERVICE_ACCOUNT_JSON`, by ARN). Only `Resource` changed. Rollback is putting
  `"*"` back. Verified 2026-10-06 with the IAM policy simulator
  (`aws iam simulate-principal-policy`, read-only): dev's role is allowed on dev's secret and implicitly
  denied on both production secrets. A dev re-deploy then confirmed it in practice (below).
* **Whether a restart re-reads secrets is unproven.** Restarting the app server on dev during the policy test left
  everything working, but an ERROR event ("Unsuccessful command execution on instance... Aborting the
  operation") was logged at about the same time, so the restart may have tried and failed to read the secret
  and kept the old settings. Treat a restart as no proof either way; a deployment or environment update is the
  test. Re-deployed dev on 2026-10-06 (same version): Ready and Green, healthcheck 200, and
  `/api/auth/google/redirect` 302 to Google, with the narrowed policy in force. A real Google sign-in then
  succeeded the same day with a member of the dev group (landed on the dashboard with the Application logs
  and System Health tabs), so the full chain works on dev: secret read, client, delegation, group check and
  session.
* Keys never expire. The date created is the only record of age, so write it down at creation.
* A Google Cloud warning on the Keys page recommends Workload Identity Federation over downloaded keys.
  That is not possible for a domain-wide delegation lookup from Elastic Beanstalk today without a change to
  how the application authenticates, so it is out of scope here; noted as an improvement.

## How dev's environment is configured (Elastic Beanstalk `isoplus-be-dev-blue`)

Read from the console on 2026-10-05. Values that are secrets are not recorded.

| Property | What it is in dev |
|---|---|
| `GOOGLE_ADMIN_EMAIL` | The organization's main admin account, "ISO CS Admin" (the `admin@` address). It holds the **Super Admin** role (all admin privileges) and is also used for interactive sign-in. **Not** the least-privilege dedicated user the guide recommends |
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

## The other project in the organization

The project named **ISO Plus Portal** (no suffix) is production's Google project. It still holds one early
Web client, created 27 Aug 2026, whose only redirect URI is the dev backend callback, and it has no service
account. It is not what dev uses. It is covered in [`07-google-signin.md`](07-google-signin.md) under
production.
