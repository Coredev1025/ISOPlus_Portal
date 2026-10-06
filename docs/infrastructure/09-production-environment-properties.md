# Production environment properties: what is set and what is missing

The Elastic Beanstalk environment properties that `isoplus-be-prod-blue` has today, compared with what the
`develop` code reads (`Backend/.env.example`, the code, and the release runbook's table). Property names
only; no values are recorded here. Compared on 2026-10-05 from a list of the key names supplied by the team.

Setting any property restarts the environment, so make the whole set of changes for a stage in one update.

## What production has (30 keys)

`Admin_API_Key`, `ALLOWED_ORIGINS`, `AUTHORIZATION_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_BUCKET`,
`AWS_BUCKET_PUBLIC`, `AWS_REGION`, `AWS_SECRET_ACCESS_KEY`, `BACKEND_URL`, `CALLBACK_URL`, `CLIENT_ID`,
`CLIENT_SECRET`, `HTTPS_URL`, `JWT_SECRET`, `MONGODB_URI`, `NODE_ENV`, `PERSONAL_ACCESS_TOKEN`, `PORT`,
`REDIRECT_URL`, `REDIS_CLUSTER`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_TLS`, `SENTRY_DSN`, `SESSION_SECRET`,
`TOKEN_ENDPOINT`, `USER_INFORMATION_ENDPOINT`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URL`.

That is the full set the `main` branch needs. Every one is a plain text property.

This list was first written as 29 keys; it is **30**. Counted from the environment's property names on
2026-10-06: 30 original plus the 11 added for stage 1 gives the 41 properties production has now.

## What is missing

### Stage 1: before the release (hard blocker)

Without these no support admin can sign in, because password sign-in is removed on `develop`. Full
procedure and placeholders in [`07-google-signin.md`](07-google-signin.md).

| Missing | Notes |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | The production project's OAuth client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Secrets Manager reference (`GOOGLE_OAUTH_CLIENT_SECRET_PROD`), see below |
| `GOOGLE_ADMIN_EMAIL` | The main admin account, same as dev (decided 2026-10-05, an accepted deviation: see `07`) |
| `GOOGLE_TARGET_GROUP` | The production support-admin group address. Not blank |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | **Secrets Manager reference, not plain text**, as dev does. See "Secrets in Secrets Manager" below |
| `GOOGLE_OAUTH_CALLBACK_URL` | Set explicitly to `https://portal-backend.isoplus.online/api/auth/google/callback` (the production backend host). The code would default it from `BACKEND_URL`, but the value registered with Google and the value in use must be visibly the same string |

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

## Secrets in Secrets Manager (service account JSON and Google client secret)

Decided: production holds `GOOGLE_SERVICE_ACCOUNT_JSON` and `GOOGLE_OAUTH_CLIENT_SECRET` in AWS Secrets
Manager as references, never as plain text properties, the way dev does for the service account JSON. The
service account key is the most sensitive Google value: it can act as the admin account for group lookups,
and it does not expire.

### How dev does it, and what not to copy

Dev's instance role (`isoplus-be-dev-ec2-role`, in the profile `isoplus-be-dev-instance-profile`) has three
AWS managed Elastic Beanstalk policies and one inline policy, `ElasticBeanstalkSecretsManagerAccess`:

* one statement, `ReadGoogleServiceAccountSecret`, allowing only `secretsmanager:GetSecretValue`;
* on `Resource: "*"`, which is **every secret in the account**. No KMS permission (the secret uses the
  default AWS managed key).

That works but is too broad: dev's role can read production's secrets if they share the account. Production
must not copy the wildcard. Dev's policy was narrowed to its one secret on 2026-10-06 (see the dev doc).

Applied 2026-10-05: the inline policy `ElasticBeanstalkSecretsManagerAccess` on `isoplus-be-prod-ec2-role`
allows `secretsmanager:GetSecretValue` and nothing else, on the two production secrets only. The two secrets
exist (created 2026-10-05 in `ap-southeast-2`, default `aws/secretsmanager` key, so no KMS permission is needed).
Dev's role cannot read these and production's cannot read dev's.

**Tightened 2026-10-06 to exact ARNs.** The policy first named each secret with a `-*` suffix wildcard, because
the ARNs were not known when it was written. Once the secrets existed it was changed to each secret's full ARN,
as dev's is. Verified: the role is allowed on both production secrets, denied on dev's, and denied on a look-alike
name such as `GOOGLE_SERVICE_ACCOUNT_JSON_PROD-evil`, which the wildcard would have allowed.

**Rotation rule.** A secret's ARN ends in six random characters that are fixed for the life of that secret. If
either production secret is deleted and recreated (for example to rotate by recreation), the suffix changes and
this policy **must be updated in the same change**, or the environment's next deploy or restart cannot read the
secret and fails. Updating a secret's value in place (a new version) does not change the ARN, so that kind of
rotation needs no policy change.

### Production platform (read 2026-10-05)

`isoplus-be-prod-blue` runs Node.js 22 on 64-bit Amazon Linux 2023, v6.5.1, the same platform version as
dev, state Supported, health Ok. Dev already shows secret references working on this version, so no
platform upgrade is needed. The running application version was built 2026-09-08 (the current `main`).

Observed in the environment's events the same day, outside this ticket: health moved from Ok to Severe
(96 to 98 percent of requests returned HTTP 4xx) and back several times, around 06:45, 08:45 and 19:41
local, and on 2 October. It recovers each time, so it is bursts of rejected requests rather than an outage.
Worth an owner finding out what is sending them.

### Test a secret permission with a deployment, not a restart

Elastic Beanstalk reads a secret when it builds the environment's settings (deployment, environment update,
new instance). Whether a plain restart of the app server also re-reads it is not proven (a restart on dev
coincided with an error event). Test a permission change with a re-deploy or an environment update and then
a real sign-in, as was done on dev and production on 2026-10-06.

### Names must differ from dev's

Secret names are unique per account and region, and dev's secret is named exactly
`GOOGLE_SERVICE_ACCOUNT_JSON`. Production uses a `_PROD` suffix:

| Secret name | Holds |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON_PROD` | The whole service account key file |
| `GOOGLE_OAUTH_CLIENT_SECRET_PROD` | The client secret (ends `nRj_`) |

### Steps

1. Create each secret in `ap-southeast-2`, type "Other type of secret" / plain text, from the local file or
   the password manager. Do not paste either into a chat, ticket or the repository. Delete the local file
   afterwards.
2. In the production environment's properties, add `GOOGLE_SERVICE_ACCOUNT_JSON` and
   `GOOGLE_OAUTH_CLIENT_SECRET` with the source set to **Secrets Manager** and each secret's ARN as the
   value. The property names stay the same; only the value is the ARN. The application still reads
   `process.env.X` and sees the secret text.
3. Allow the production environment's EC2 role to read exactly those two secrets. The role is
   `isoplus-be-prod-ec2-role` (found from EC2 > the `isoplus-be-prod-blue` instance > Security > IAM role,
   2026-10-05; dev's is `isoplus-be-dev-ec2-role`). Add an inline policy like this, replacing the placeholders:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadProductionGoogleSecrets",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": [
        "arn:aws:secretsmanager:ap-southeast-2:<AWS_ACCOUNT_ID>:secret:GOOGLE_SERVICE_ACCOUNT_JSON_PROD-<SUFFIX>",
        "arn:aws:secretsmanager:ap-southeast-2:<AWS_ACCOUNT_ID>:secret:GOOGLE_OAUTH_CLIENT_SECRET_PROD-<SUFFIX>"
      ]
    }
  ]
}
```

   `<SUFFIX>` is the six random characters Secrets Manager appends to every secret's ARN; read each secret's
   full ARN with `aws secretsmanager describe-secret --secret-id <name> --query ARN` rather than typing it. If the
   policy must be written before the secrets exist, end each name in `-*` and tighten it to the exact ARN as
   soon as they do.
4. Set the new properties in one environment update (it restarts the environment). If the role permission
   is missing the update fails or the property is empty.
5. Confirm after the restart: `GET /api/auth/google/redirect` redirects to Google instead of answering 503.

## Applied to production

On 2026-10-06 (00:40 Sydney) the stage 1 properties were applied to `isoplus-be-prod-blue` with
`aws elasticbeanstalk update-environment --option-settings`: the two Secrets Manager references
(`aws:elasticbeanstalk:application:environmentsecrets`) and nine plain properties (`...:environment`),
11 settings in all. The update finished Ready and Green, so Elastic Beanstalk read both secrets through the
role policy. Secret ARNs were looked up with `aws secretsmanager describe-secret` (metadata only) and never
typed by hand.

Result seen afterwards: `GET /api/healthcheck` 200, and `GET /api/auth/google/redirect` **404**. The 404 is
expected: production still runs the 8 September build from `main`, which has no Google sign-in route. The
properties are inert until the release. The real test, a group member signing in and a non-member refused,
is run immediately after the release and gates it.

Rollback of this change removes only what it added (`aws elasticbeanstalk update-environment
--options-to-remove` for the two `environmentsecrets` options and the nine plain ones).

Policy check, 2026-10-06 (`aws iam simulate-principal-policy`, read-only): production's role is allowed on
both `_PROD` secrets and implicitly denied on dev's; dev's role is allowed on dev's secret and denied on both
production secrets. The environment update that followed also finished Ready and Green, so Elastic Beanstalk
read both secrets in practice.

## Verified 2026-10-06

A read-only audit of production, from the AWS account and public endpoints. Nothing was changed by it.

| Check | Result |
|---|---|
| Environment `isoplus-be-prod-blue` | Ready, load balancer target healthy, listeners 443 and 80, 8 September build |
| Properties | 41 in total: 30 original, 9 new plain, 2 new Secrets Manager references. None missing, none unexpected. `AUTOMATION_ENABLED` is `false` |
| Absent on purpose | `ISOPLUS_OFFLINE`, `LOCAL_FILE_ROOT`, `XERO_SCOPES`, `SESSION_COOKIE_SAMESITE`, plus the stage 2 properties (`EMAIL_FROM`, `EMAIL_BACKEND`, `SES_EVENTS_QUEUE_URL`, the scheduler keys) |
| Secrets | Each has exactly one current version; the service account secret also holds an older previous version |
| Role policy | Exact ARNs (see above); simulator results as above |
| Application IAM user `isoplus-app` | One policy (S3 on the production buckets), one active key. It has **no** SES or queue permission yet: stage 2 adds it |
| Google OAuth client | Google accepts the production callback, rejects a made-up one, and rejects dev's callback (the client holds no leftover dev URI) |
| Delegation and group lookup | Tested earlier the same day with the production key: member true, non-member false |
| TLS certificate | `*.isoplus.online`, issued, valid to February 2027, renewal eligible |
| Redis, S3 buckets | Available (daily snapshot kept one day), both production buckets reachable |
| MongoDB backup | Ran on 5 October (about 49 MB), no errors in three days |
| **Stage 2 resources** | **None exist yet:** SES identity and configuration set, both SNS topics, both queues, the alarms, the scheduler rules and their role. The same checks do find dev's counterparts |
| Terraform | `validate` passes; the production plan is 29 to add, 0 to change, 0 to destroy (30 with two alert recipients) |

Stage 2 monitors, compared with dev: the two queue alarms are identical in design (same metrics, periods,
missing-data handling, alarm and recovery notifications), with the stalled threshold tighter in production (600 s
against 900 s), and production adds the SES bounce-rate and complaint-rate alarms. Those read the whole account;
the account's rates on 6 October (bounce about 0.04 percent, complaint 0) are far below their thresholds, so they
will not fire when created. Not covered by any alarm in dev or production: the scheduler stopping, the backup
job failing, and the environment's health (KAN-331).

## Checklist

* [x] Stage 1: `GOOGLE_*` properties set (2026-10-06), group created
* [x] Role policy tightened to exact ARNs (2026-10-06)
* [ ] Stage 1: a support admin has signed in (after the release)
* [x] Stage 1: the client secret (ends `nRj_`) and the service account JSON are in Secrets Manager
* [x] Stage 1: the local copies of both files are deleted (2026-10-06)
* [x] Stage 1: `AUTOMATION_ENABLED=false`, `FRONTEND_URL` and `GOOGLE_OAUTH_CALLBACK_URL` set
* [x] Stage 1: the three `BOARD_SYNC_*` written out
* [ ] Stage 2: `EMAIL_BACKEND=ses`
* [ ] Stage 2: SES identity verified, `EMAIL_FROM` set
* [ ] Stage 2: events queue exists, `SES_EVENTS_QUEUE_URL` set
* [ ] Stage 2: both scheduler keys set and the same keys in the EventBridge rules
* [ ] Application AWS user has the SES and SQS permissions
* [ ] `XERO_SCOPES`, `ISOPLUS_OFFLINE`, `LOCAL_FILE_ROOT` and `SESSION_COOKIE_SAMESITE` still absent
