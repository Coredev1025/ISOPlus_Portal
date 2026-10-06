# ISO+ Portal — Email Infrastructure Deployment Runbook

**Scope:** UAT and production
**Region:** `ap-southeast-2` (Sydney)
**AWS Account:** `<AWS_ACCOUNT_ID>`
**Last updated:** 18 August 2026

---

## 1. What this is

Terraform to build the SES sending and event pipeline in a new environment, plus the manual steps Terraform cannot perform.

**Dev is deliberately excluded.** It was built by hand and stays that way. Do not import it. If you want dev under Terraform, tear it down and rebuild it rather than importing, because imports of hand-built resources produce a state file that diverges from reality in ways you only discover during an outage.

The `environment` variable rejects anything other than `uat` or `prod` to enforce this.

### Status of this code

The Terraform has been written and reviewed but **never applied**. Terraform is not installed on the machine it was authored on, so it has not been through `validate`, `plan`, or `apply`. Expect to fix small things on the first UAT run: attribute names drift between AWS provider versions, particularly on the newer `aws_sesv2_*` resources.

Budget an hour for the first apply. Treat UAT as the proving ground, which is why it exists.

---

## 2. Prerequisites

| Requirement | Notes |
|---|---|
| Terraform >= 1.6 | `winget install HashiCorp.Terraform` |
| AWS CLI v2, authenticated | `aws sts get-caller-identity` should return account `<AWS_ACCOUNT_ID>` |
| Permissions | SES, SNS, SQS, IAM, CloudWatch, EventBridge, Secrets Manager |
| DNS access | For the sending domain. Records are created by hand unless the zone is in Route 53 |
| An alert mailbox | A real inbox someone reads |

Confirm the account before anything else. Applying to the wrong account is the expensive mistake here.

```bash
aws sts get-caller-identity
```

---

## 3. Remote state

Terraform state contains secrets. The scheduler API keys are in it, and the app secret key too if `create_app_access_key` is true. Do not keep state on a laptop and do not commit it.

Create the backend once, by hand:

```bash
aws s3 mb s3://isoplus-tfstate --region ap-southeast-2

aws s3api put-bucket-versioning --bucket isoplus-tfstate --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption --bucket isoplus-tfstate --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-public-access-block --bucket isoplus-tfstate --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws dynamodb create-table --table-name isoplus-tfstate-lock --attribute-definitions AttributeName=LockID,AttributeType=S --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST --region ap-southeast-2
```

Versioning matters. It is the only way back from a corrupted state file.

Then uncomment the `backend "s3"` block in `versions.tf` and set the `key` per environment.

---

## 4. Layout

```
terraform/
  versions.tf              provider, backend, default tags
  variables.tf             every input, documented
  ses.tf                   identity, DKIM, MAIL FROM, config set, DNS
  events.tf                SNS topics, SQS queues, subscriptions, policies
  iam.tf                   application user and policy
  monitoring.tf            CloudWatch alarms
  scheduler.tf             EventBridge connections, destinations, rules
  outputs.tf               values needed downstream, post-apply checklist
  uat.tfvars.example       copy to uat.tfvars
  prod.tfvars.example      copy to prod.tfvars
  .gitignore               keeps tfvars and state out of git
```

---

## 5. Deploying UAT

### 5.1 Configure

```bash
cd infrastructure/terraform   # from the repository root
cp uat.tfvars.example uat.tfvars
```

Edit `uat.tfvars`. The values that matter:

| Variable | Guidance |
|---|---|
| `sending_domain` | `uat.isoplus.online`. Must not collide with dev or prod |
| `recipient_allowlist` | Keep restrictive. Include `*@simulator.amazonses.com` |
| `alert_emails` | A list of real inboxes. Each address must click its own confirmation link |
| `scheduler_rules_enabled` | `false`. Always false on first apply |
| `scheduler_rules[*].api_key` | Generate with `openssl rand -base64 32` |

Keys are better supplied by environment than by file:

```bash
export TF_VAR_scheduler_rules='{"invoice":{"schedule_expression":"rate(1 minute)","api_key":"...","description":"Invoice tick"},"statement":{"schedule_expression":"rate(1 minute)","api_key":"...","description":"Statement tick"}}'
```

### 5.2 Initialise and plan

```bash
terraform init
```

```bash
terraform plan -var-file=uat.tfvars -out=uat.plan
```

Read the plan. Specifically check that every resource name carries the `uat` prefix. A `name_prefix` typo that produces `isoplus-dev-*` or `isoplus-*` will collide with or overwrite live resources, because this is a shared account.

### 5.3 Apply

```bash
terraform apply uat.plan
```

### 5.4 Read the checklist

```bash
terraform output post_apply_checklist
```

That output lists what Terraform could not do. Work through it before declaring the environment ready.

---

## 6. Manual steps

Four things Terraform cannot complete on its own.

### 6.1 DNS records

Unless `manage_dns` is true, create these by hand:

```bash
terraform output -json dns_records_required
```

Five records: three DKIM CNAMEs, one MAIL FROM MX, one MAIL FROM TXT.

Verify propagation:

```bash
nslookup -type=CNAME <token>._domainkey.uat.isoplus.online
```

```bash
nslookup -type=MX mail.uat.isoplus.online
```

Then wait for SES:

```bash
aws sesv2 get-email-identity --email-identity uat.isoplus.online --region ap-southeast-2 --query "{Verified:VerifiedForSendingStatus,Dkim:DkimAttributes.Status,MailFrom:MailFromAttributes.MailFromDomainStatus}"
```

All three must read `true` / `SUCCESS` / `SUCCESS`. Usually minutes. AWS allows up to 72 hours.

**You cannot send until this passes.** It is the most common reason a first apply looks broken.

### 6.2 Confirm the SNS subscription

Terraform reports the email subscription as created, but AWS creates it `PendingConfirmation` and delivers nothing until a human clicks the link.

```bash
aws sns list-subscriptions-by-topic --topic-arn $(terraform output -raw alerts_topic_arn) --region ap-southeast-2
```

A `SubscriptionArn` reading `PendingConfirmation` means alarms will fire silently into nothing. Find the confirmation email and click it.

This is the single most commonly missed step, and its failure mode is invisible until the day you need an alarm.

### 6.3 Application access key

With `create_app_access_key = false`, create it manually so the secret never enters state:

```bash
aws iam create-access-key --user-name isoplus-uat-app
```

Put it straight into the application secret store. Do not paste it into a file, a chat message, or a test script.

### 6.4 Production sending access

Only relevant if the account were ever in sandbox. It is not, production access was granted under case `13826337181`, and it is account-wide. UAT inherits it.

Confirm:

```bash
aws sesv2 get-account --region ap-southeast-2 --query "{Prod:ProductionAccessEnabled,Enabled:SendingEnabled,Status:EnforcementStatus}"
```

---

## 7. Verifying UAT

Work down the pipeline. Each step proves the one before it.

### 7.1 Send

```bash
aws sesv2 send-email --region ap-southeast-2 --from-email-address noreply@uat.isoplus.online --destination ToAddresses=success@simulator.amazonses.com --content "Simple={Subject={Data=UAT pipeline test},Body={Text={Data=Verifying the pipeline}}}"
```

A `MessageId` means SES accepted it.

### 7.2 Confirm the event arrived

```bash
aws sqs get-queue-attributes --queue-url $(terraform output -raw events_queue_url) --attribute-names ApproximateNumberOfMessages --region ap-southeast-2
```

Then read it without consuming it:

```bash
aws sqs receive-message --queue-url $(terraform output -raw events_queue_url) --max-number-of-messages 1 --visibility-timeout 0 --region ap-southeast-2
```

Check the `Body` is bare SES event JSON starting `{"eventType":"Delivery"...`. If it starts `{"Type":"Notification"` then raw message delivery is off and the consumer will not parse it.

### 7.3 Test a bounce

```bash
aws sesv2 send-email --region ap-southeast-2 --from-email-address noreply@uat.isoplus.online --destination ToAddresses=bounce@simulator.amazonses.com --content "Simple={Subject={Data=Bounce test},Body={Text={Data=Testing bounce handling}}}"
```

A `Bounce` event with `bounceType: Permanent` should follow within seconds.

### 7.4 Test the allowlist

```bash
aws sesv2 send-email --region ap-southeast-2 --from-email-address noreply@uat.isoplus.online --destination ToAddresses=guard-test@example.com --content "Simple={Subject={Data=Should fail},Body={Text={Data=x}}}"
```

Run this **as the application user**, not as an administrator. An admin bypasses the policy and the test proves nothing. Expect `AccessDeniedException`.

`example.com` is IANA-reserved and goes nowhere, so if the guard ever fails open, nothing reaches a real person.

### 7.5 Test the alarms

```bash
aws cloudwatch set-alarm-state --alarm-name isoplus-uat-ses-events-dlq-nonempty --state-value ALARM --state-reason "Testing notification path" --region ap-southeast-2
```

An email should arrive within a minute. If not, revisit 6.2. Then return it:

```bash
aws cloudwatch set-alarm-state --alarm-name isoplus-uat-ses-events-dlq-nonempty --state-value OK --state-reason "Test complete" --region ap-southeast-2
```

You should get a recovery email too, which confirms `ok_actions` works.

### Checklist

- [ ] Identity verified, DKIM `SUCCESS`, MAIL FROM `SUCCESS`
- [ ] SNS subscription confirmed, not `PendingConfirmation`
- [ ] Test send returns a `MessageId`
- [ ] Delivery event lands on the queue as raw JSON
- [ ] Bounce event arrives with `bounceType: Permanent`
- [ ] Allowlist rejects a non-allowed recipient **as the app user**
- [ ] Alarm fires and clears, both emails received
- [ ] Scheduler rules exist and are `DISABLED`

---

## 8. Promoting to production

Do not run this until UAT has been stable through at least one full invoicing cycle.

> **Decision 2026-10-06: UAT is skipped.** No UAT environment exists, and the owners chose to apply straight to
> production. The rule above was written for a UAT that was never built; what stands in for it is below. Read
> this before applying, because it removes a safety step.
>
> * **Dev is the reference.** Dev was built by hand and works. Every resource this Terraform creates was
>   compared with its dev counterpart and matches (see [`13-terraform-checked-against-dev.md`](13-terraform-checked-against-dev.md)).
> * **Read the plan.** `terraform plan` for production shows 29 resources to add, 0 to change, 0 to destroy. Re-run it
>   immediately before applying and confirm it still says that.
> * **Scheduler rules stay DISABLED** at apply (`scheduler_rules_enabled = false`). Enabling them is its own later
>   change, after the tick endpoint is deployed.
> * **Test with the SES simulator addresses only** (success, bounce, complaint), never a real client address.
>   Production has no recipient allowlist, and the suppression list is shared across the account.
> * **Prove both alarms** (section 7.5) once applied, since there was no UAT to prove them.
> * **Nothing existing is touched:** the plan creates a new identity on `mail.isoplus.online`, and does not change
>   `isoplus.online`, any bucket, or any existing IAM user or key.
> * If anything in the plan differs from the above, stop and do not apply.

> **Production sends from `mail.isoplus.online`, not `isoplus.online`.** The parent domain is already a verified SES
> identity used by ISO+, the main platform. Use `sending_domain = "mail.isoplus.online"` and
> `mail_from_subdomain = "bounce"`. ISO+ is expected to move to `mail.isoplus.online` later; read
> [`13-terraform-checked-against-dev.md`](13-terraform-checked-against-dev.md) first, because ISO+ sends that do not
> name their own configuration set would flood this product's event queue.

### What differs

| Setting | UAT | Production | Why |
|---|---|---|---|
| `recipient_allowlist` | Restrictive | **Empty** | Real clients are on arbitrary domains |
| `subscribe_email_to_events` | `true` | `false` | Would be thousands of emails a day |
| `stalled_queue_threshold_seconds` | 900 | 600 | Invoicing is time sensitive |
| `alert_emails` | An individual | A distribution list (or at least two people, until one exists, KAN-332) | One person on leave is not monitoring |
| Reputation alarms | Not created | Created | Only apply at production volume |

### The allowlist decision

Production sets `recipient_allowlist = []`, which removes the IAM condition entirely.

This is correct and it is worth understanding why. The allowlist is a **dev and UAT safety net**, not a security control. In production, clients are at arbitrary domains, and any allowlist would silently block legitimate invoices. Leaving a stale allowlist in production is a guaranteed outage on the first client at a new domain.

### Procedure

```bash
cp prod.tfvars.example prod.tfvars
```

```bash
terraform init -reconfigure -backend-config="key=email/prod/terraform.tfstate"
```

```bash
terraform plan -var-file=prod.tfvars -out=prod.plan
```

Read every line. Confirm:

- no resource is being **destroyed**
- every name carries the `prod` prefix
- `recipient_allowlist` produces no `Condition` block in the IAM policy
- `scheduler_rules_enabled` is false

Then apply, and repeat sections 6 and 7 against production, substituting simulator addresses throughout. **Never use a real client address as a production smoke test.**

---

## 9. Enabling the scheduler

Four stages, in order. Do not collapse them: each one produces a clear signal that the next depends on.

1. Set the application environment variables (9.1)
2. Verify the endpoint authenticates (9.2)
3. Turn the automation on (9.3)
4. Enable the EventBridge rules (9.4)

### 9.1 Application environment variables

EventBridge sends the API key in an `Authorization` header. The application needs the **same** key in its environment or every tick returns 401. On Elastic Beanstalk that means an `update-environment` call.

**Get the keys from the connection secrets rather than from a message.** EventBridge stores each connection's key in Secrets Manager, and that store is authoritative. A key copied out of chat or email is the most common source of a mismatch.

```bash
aws secretsmanager list-secrets --region ap-southeast-2 --query "SecretList[?contains(Name,'events!connection')].Name" --output text
```

```bash
aws secretsmanager get-secret-value --secret-id "events!connection/<connection-name>/<uuid>" --region ap-southeast-2 --query SecretString --output text
```

The result is JSON containing `api_key_value`.

Then set the variables. PowerShell, using variables so the keys are not inline:

```powershell
$inv  = "PASTE_INVOICE_KEY"
$stmt = "PASTE_STATEMENT_KEY"
aws elasticbeanstalk update-environment --region ap-southeast-2 --application-name isoplus-be-dev --environment-name isoplus-be-dev-blue --option-settings "Namespace=aws:elasticbeanstalk:application:environment,OptionName=SCHEDULER_API_KEY_INVOICE,Value=$inv" "Namespace=aws:elasticbeanstalk:application:environment,OptionName=SCHEDULER_API_KEY_STATEMENT,Value=$stmt" "Namespace=aws:elasticbeanstalk:application:environment,OptionName=AUTOMATION_ENABLED,Value=false" "Namespace=aws:elasticbeanstalk:application:environment,OptionName=EMAIL_FROM,Value=noreply@dev.isoplus.online"
```

Substitute the environment name for the target environment. Quote each option setting so PowerShell does not split on the commas.

**`AUTOMATION_ENABLED` starts at `false`.** Config and behaviour are switched on separately so that a key problem cannot coincide with documents being generated.

#### Things that go wrong here

| Symptom | Cause |
|---|---|
| `The system cannot find the file specified` | Placeholders such as `<KEY>` left in the command. `<` and `>` are redirection operators, so the shell tried to open a file. Nothing was sent to AWS |
| `The config profile (...) could not be found` | A `--profile` that does not exist locally. Check with `aws configure list-profiles` |
| Commas split into separate arguments | Option settings not quoted in PowerShell |
| 401 on every tick, key looks correct | Truncated key. Compare lengths against the secret before assuming anything else. A single missing trailing character is invisible by eye |

#### Verify before moving on

`--option-settings` **merges**; it does not replace. Existing variables survive. Confirm that, and that the new ones landed:

```bash
aws elasticbeanstalk describe-configuration-settings --application-name isoplus-be-dev --environment-name isoplus-be-dev-blue --region ap-southeast-2 --query "ConfigurationSettings[].OptionSettings[?Namespace=='aws:elasticbeanstalk:application:environment'].OptionName" --output text
```

Each `update-environment` restarts the application. Wait for `Ready` / `Green`:

```bash
aws elasticbeanstalk describe-environments --application-name isoplus-be-dev --environment-names isoplus-be-dev-blue --region ap-southeast-2 --query "Environments[].{Status:Status,Health:Health}" --output table
```

#### A note for production

Beanstalk environment variables are readable by anyone holding `elasticbeanstalk:DescribeConfigurationSettings`, and option-setting values appear in CloudTrail in plaintext. Acceptable in dev. Before production, decide whether the scheduler keys should be delivered this way or pulled from Secrets Manager at runtime.

### 9.2 Verify the endpoint authenticates

Do this while `AUTOMATION_ENABLED` is still `false`, so a 401 tells you something specific rather than arriving tangled up with generation errors. Send no body, which also avoids fighting shell quoting.

```bash
curl -s -i -X POST https://portal-be-uat.isoplus.online/api/scheduler/tick -H "Authorization: <the invoice key>"
```

On Windows, use `curl.exe`. In PowerShell, `curl` is an alias for `Invoke-WebRequest` and the `-H` flags will not bind. `-s` suppresses the progress meter, which PowerShell otherwise surfaces as a red error even on success.

You want a 2xx. A 401 means a key mismatch, a 404 means it is not deployed. An enabled rule against a broken endpoint retries every minute and generates noise indefinitely.

Test **both** keys. They authenticate different rules and only one may be wrong.

**Read the response body, not just the status.**

```json
{ "claimed": 0, "dispatched": 0, "failed": 0, "heldBack": 1, "capped": false }
```

`heldBack` is how much work is due but blocked by `AUTOMATION_ENABLED=false`. A 200 with `heldBack: 1` is the ideal pre-enable state: the endpoint is healthy, and you know exactly how much will fire when you switch it on. Field meanings are in section 11 of [01-developer-guide.md](01-developer-guide.md).

If `heldBack` is large, understand why before enabling. Enabling with a backlog means it all dispatches at once.

### 9.3 Turn the automation on

Only after 9.2 passes, and only once you know what it starts. Confirm with the developers whether the application has its own internal scheduler, because if it does, this flag can begin generating documents immediately, independently of EventBridge.

Do not enable it before the double-billing controls exist. See section 3 of [04-invoice-statement-generator.md](04-invoice-statement-generator.md).

```bash
aws elasticbeanstalk update-environment --region ap-southeast-2 --application-name isoplus-be-dev --environment-name isoplus-be-dev-blue --option-settings Namespace=aws:elasticbeanstalk:application:environment,OptionName=AUTOMATION_ENABLED,Value=true
```

Wait for `Ready`, then run the first tick with the recipient redirected to yourself:

```powershell
'{"bypassEmail":"you@example.com"}' | Out-File -Encoding ascii -NoNewline body.json
curl.exe -s -i -X POST "https://portal-be-uat.isoplus.online/api/scheduler/tick" -H "Authorization: <the invoice key>" -H "Content-Type: application/json" -d "@body.json"
```

`bypassEmail` replaces the resolved recipient for that tick only. Everything else runs unchanged, so this exercises selection, generation, composition, attachment and delivery end to end without mailing a participant's billing contact. Accepts a comma-separated string or an array.

**Always pass it on a manual tick.** Without it the recipient comes from the profile's Billing Email. The recipient allowlist blocks delivery outside the permitted domains, but a billing contact inside them will receive a real document.

Expect `heldBack` to fall and `dispatched` to rise. If `failed` is non-zero, turn `AUTOMATION_ENABLED` back to `false` before investigating — it is a kill switch and needs no redeploy.

### 9.4 Enable the EventBridge rules

Set `scheduler_rules_enabled = true`, plan, apply. Watch the first few invocations:

```bash
aws cloudwatch get-metric-statistics --namespace AWS/Events --metric-name FailedInvocations --dimensions Name=RuleName,Value=isoplus-uat-scheduler-invoice --start-time 2026-08-18T00:00:00Z --end-time 2026-08-18T23:59:59Z --period 300 --statistics Sum --region ap-southeast-2
```

`FailedInvocations` should stay at zero. If it climbs, disable the rule immediately:

```bash
aws events disable-rule --name isoplus-uat-scheduler-invoice --region ap-southeast-2
```

---

## 10. What is not in Terraform, and why

| Thing | Why not |
|---|---|
| DNS records, when not in Route 53 | Terraform cannot manage a zone it has no provider for |
| SNS email subscription confirmation | Requires a human to click a link |
| Application access keys | Would put the secret in state |
| Production sending access | A support ticket, granted once per account |
| Dev environment | Deliberately manual, see section 1 |
| Application environment variables on Elastic Beanstalk | The Beanstalk environments are not managed by this module. Set via `update-environment`, see section 9.1 |
| Suppression list entries | Runtime data, not configuration. Managing it as code would fight SES |
| Mail Manager | Inbound mail receiving. Not part of sending, removed from dev on 18 Aug 2026 |

---

## 11. Rollback

`terraform destroy` removes everything, including the queue and any unprocessed events in it. In production that means losing delivery and bounce records.

Prefer targeted rollback:

```bash
terraform plan -destroy -var-file=uat.tfvars
```

Read it before proceeding.

Two things resist destroy:

**The SES identity** may be referenced by other config sets. Check before removing.

**Mail Manager archives** soft delete. They enter `PENDING_DELETION` and remain listed for around 30 days. That is normal and not a failed delete. An archive referenced by a config set cannot be deleted at all until the reference is cleared, which is what blocked the dev cleanup on 18 August.

---

## 12. Known issues on first apply

Things likely to need fixing, based on how the provider handles these resources.

**`aws_sesv2_email_identity` DKIM token access.** The `dkim_signing_attributes[0].tokens` path may differ by provider version. If `terraform validate` objects, check the provider docs for your version and adjust `ses.tf` and `outputs.tf` together.

**Config set attached before it exists.** The identity references the config set, which Terraform should order correctly via the implicit dependency. If you hit a race, add `depends_on = [aws_sesv2_configuration_set.this]` to the identity.

**Route 53 record names.** When `manage_dns` is true and the zone is the apex, record names may end up duplicated (`mail.uat.isoplus.online.uat.isoplus.online`). Check the plan output.

**Empty `HttpParameters` on event targets.** The dev rules were created with an empty `HttpParameters` block. Terraform omits it entirely, which is equivalent, but produces a diff if you ever import the dev rules. Another reason not to import them.
