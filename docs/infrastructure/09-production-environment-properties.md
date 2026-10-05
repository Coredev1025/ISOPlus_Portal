# Production environment properties: what is set and what is missing

The Elastic Beanstalk environment properties that `isoplus-be-prod-blue` has today, compared with what the
`develop` code reads (`Backend/.env.example`, the code, and the release runbook's table). Property names
only; no values are recorded here. Compared on 2026-10-05 from a list of the key names supplied by the team.

Setting any property restarts the environment, so make the whole set of changes for a stage in one update.

## What production has (29 keys)

`Admin_API_Key`, `ALLOWED_ORIGINS`, `AUTHORIZATION_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_BUCKET`,
`AWS_BUCKET_PUBLIC`, `AWS_REGION`, `AWS_SECRET_ACCESS_KEY`, `BACKEND_URL`, `CALLBACK_URL`, `CLIENT_ID`,
`CLIENT_SECRET`, `HTTPS_URL`, `JWT_SECRET`, `MONGODB_URI`, `NODE_ENV`, `PERSONAL_ACCESS_TOKEN`, `PORT`,
`REDIRECT_URL`, `REDIS_CLUSTER`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_TLS`, `SENTRY_DSN`, `SESSION_SECRET`,
`TOKEN_ENDPOINT`, `USER_INFORMATION_ENDPOINT`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URL`.

That is the full set the `main` branch needs. Every one is a plain text property.

## What is missing

### Stage 1: before the release (hard blocker)

Without these no support admin can sign in, because password sign-in is removed on `develop`. Full
procedure and placeholders in [`07-google-signin.md`](07-google-signin.md).

| Missing | Notes |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | The production project's OAuth client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Hold in Secrets Manager |
| `GOOGLE_ADMIN_EMAIL` | Shared admin mailbox the service account acts as |
| `GOOGLE_TARGET_GROUP` | The production support-admin group address. Not blank |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | **Secrets Manager reference, not plain text**, as dev does. See "Service account JSON in Secrets Manager" below |
| `GOOGLE_OAUTH_CALLBACK_URL` | Set explicitly to `https://<backend host>/api/auth/google/callback`. The code would default it from `BACKEND_URL`, but the value registered with Google and the value in use must be visibly the same string |

### Stage 1: set with the release, automation off

| Missing | Value and why |
|---|---|
| `AUTOMATION_ENABLED` | `false`, written out. Unset also means off, but the state must be visible. Anything other than `true`, `1`, `yes`, `on` is off. Stays `false` until stage 2 |
| `FRONTEND_URL` | The production frontend origin, set explicitly. Without it the code uses the first entry of `ALLOWED_ORIGINS`, so the result would depend on the order of that list |

### Stage 2: automation (nothing here is needed to release)

| Missing | Notes |
|---|---|
| `EMAIL_FROM` | `noreply@mail.isoplus.online`, on a domain verified in SES. Also the opt-in that turns the email backend on. Needs the SES resources from the Terraform |
| `SES_EVENTS_QUEUE_URL` | The SQS queue that receives the SES events. Unset means no delivery tracking and the consumer does not start |
| `SCHEDULER_API_KEY_INVOICE` and `SCHEDULER_API_KEY_STATEMENT` | One key per EventBridge rule, so each rule can only fire its own kind. Alternatively a single `SCHEDULER_API_KEY` for one rule. Unset: the tick endpoint answers 500 and no schedule runs. Each key is also in its EventBridge rule, so create them together |

### Settings that would otherwise be implicit: set them anyway

Nothing in production relies on a default. Each of these has a built-in default, and each is set
explicitly so the running value can be read from the environment, not worked out from the code.

| Property | Value | Why this value |
|---|---|---|
| `BOARD_SYNC_ENABLED` | `true` | Default is on when unset. Armed once at boot, so a change needs a restart |
| `BOARD_SYNC_CRON` | `0 2 * * *` | The code default (daily at 02:00, Australia/Sydney). Dev uses `0 0/3 * * *`; **choose production's cadence deliberately** |
| `BOARD_SYNC_GAP_MS` | `0` | The code default: jobs back to back. Raise it to space board syncs apart |
| `EMAIL_BACKEND` | `ses` at stage 2; not set at stage 1 | Without it, `EMAIL_FROM` set means `ses`, unset means no backend. Naming it at stage 2 removes the inference. Kept on purpose, although dev does not set it: `EMAIL_FROM` alone already selects `ses`. The value must be exactly `ses`; any other name makes email delivery fail (`local-outbox` would log messages and send nothing). Do not set it before the SES resources exist |

### Deliberately not set

These stay absent because there is no value that expresses the intent. Writing one would be wrong.

| Property | Why it is absent |
|---|---|
| `XERO_SCOPES` | The scopes are defaulted in the code (`services/xero.js`) and dev does not set the property either. A scope change may need a code change as well, so the code stays the single place they are defined. Production does the same as dev |
| `ISOPLUS_OFFLINE` | The release runbook requires it unset in production. It switches the application to local, offline behaviour, so the only safe production state is absent. Production ignores it anyway (`NODE_ENV=production` wins), which is why no value, not even `0`, is needed |
| `LOCAL_FILE_ROOT` | Any value points the application at a local directory. There is no "off" value, so absent is the only safe state |
| `SESSION_COOKIE_SAMESITE` | Has no effect in production: with `NODE_ENV=production` the session cookie is always `Secure` and `SameSite=None`. A value here would suggest otherwise |
| `REDIS_PASSWORD` | Production has `REDIS_TLS` and no password. Add it only if the cache is given one, and then explicitly |

### Tunables not listed here

The code also reads many tuning values (`ISOPLUS_*` timeouts and page sizes, `LOG_*` limits,
`HTTP_*` timeouts, `OAUTH_STATE_TTL`, `WORKSPACE_*` concurrency and timeouts, `AUDIT_TTL_DAYS`,
`ENABLE_LOG_DEDUP`). They are operational tuning, not configuration the release depends on, and
production leaves them at their code defaults. If you want these explicit too, that is a separate
decision with a longer list.

## Not a property, but needed for the properties to work

* **The AWS key the application already uses.** SES sending and the SQS consumer use the same
  `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as S3. That user needs `ses:SendEmail` on the production
  identity and read and delete on the events queue before stage 2. The production Terraform sets
  `create_app_access_key = false`, so it does not make a new key; the existing user needs the policy
  attached (see [`02-terraform-runbook.md`](02-terraform-runbook.md) and `infrastructure/terraform/iam.tf`).
* **Secret handling.** Today every production secret is a readable plain text property. The new secrets
  (Google client secret, service account JSON, the scheduler keys) are the place to start using Secrets
  Manager. Moving the existing ones is a separate change with its own risk.

## Service account JSON in Secrets Manager

Decided: production holds `GOOGLE_SERVICE_ACCOUNT_JSON` in AWS Secrets Manager, the same way dev does, and
never as a plain text property. The service account key is the most sensitive Google value: it can act as
the admin mailbox for group lookups, and it does not expire.

1. Create a secret in `ap-southeast-2` named `GOOGLE_SERVICE_ACCOUNT_JSON` (dev uses this name), holding
   the whole key file as the secret string. Create it from the downloaded key file; do not paste it into a
   chat, ticket or the repository. Delete the downloaded file afterwards.
2. In the Elastic Beanstalk environment properties, add `GOOGLE_SERVICE_ACCOUNT_JSON` with the source set
   to **Secrets Manager** and the secret's ARN as the value. The application still reads
   `process.env.GOOGLE_SERVICE_ACCOUNT_JSON` and sees the JSON text.
3. Allow the environment's EC2 instance profile role `secretsmanager:GetSecretValue` on that one secret's
   ARN (and `kms:Decrypt` if the secret uses a customer managed key). Without this the environment update
   fails or the property is empty. Dev's profile is `isoplus-be-dev-instance-profile`; production's profile
   name is **to confirm**.
4. Confirm after the restart: `GET /api/auth/google/redirect` redirects to Google instead of answering 503.

The OAuth client secret is the next candidate for Secrets Manager the same way. Do it with the same change
if the instance profile permission already covers it.

## Checklist

* [ ] Stage 1: five `GOOGLE_*` properties set, group created, a support admin has signed in
* [ ] Stage 1: `AUTOMATION_ENABLED=false`, `FRONTEND_URL` and `GOOGLE_OAUTH_CALLBACK_URL` set
* [ ] Stage 1: the three `BOARD_SYNC_*` written out
* [ ] Stage 2: `EMAIL_BACKEND=ses`
* [ ] Stage 2: SES identity verified, `EMAIL_FROM` set
* [ ] Stage 2: events queue exists, `SES_EVENTS_QUEUE_URL` set
* [ ] Stage 2: both scheduler keys set and the same keys in the EventBridge rules
* [ ] Application AWS user has the SES and SQS permissions
* [ ] `XERO_SCOPES`, `ISOPLUS_OFFLINE`, `LOCAL_FILE_ROOT` and `SESSION_COOKIE_SAMESITE` still absent
