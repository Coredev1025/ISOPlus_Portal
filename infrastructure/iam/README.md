# Dev team access to the email and scheduler resources

**Applied and verified:** 20 August 2026
**Account:** `<AWS_ACCOUNT_ID>` · **Region:** `ap-southeast-2`

---

## What was granted

Two customer managed policies, attached to the **IsoplusDev** permission set in IAM Identity Center.

| Policy | File | Purpose |
|---|---|---|
| `isoplus-dev-email-readonly` | [isoplus-dev-email-readonly.json](isoplus-dev-email-readonly.json) | View dev SES, SNS, SQS and EventBridge scheduler resources |
| `isoplus-dev-dlq-redrive` | [isoplus-dev-dlq-redrive.json](isoplus-dev-dlq-redrive.json) | Redrive the dev SES event DLQ. Purge explicitly denied |

Kept as two policies so redrive can be revoked without removing read access.

### Identity Center details

| | |
|---|---|
| Instance | `arn:aws:sso:::instance/ssoins-8259f8e2e37f3d10` |
| Permission set | `IsoplusDev`, `ps-3bfb45dd42b26ca5` |
| Provisioned to | `<AWS_ACCOUNT_ID>` (one account) |
| Resulting IAM role | `AWSReservedSSO_IsoplusDev_54cc012e6449f07d` |
| Session duration | 2 hours |

---

## How it was applied

Four steps. Step 3 is the one that is easy to miss.

### 1. Create the policies in the account

```bash
aws iam create-policy --policy-name isoplus-dev-email-readonly \
  --description "Read-only access to dev SES, SNS, SQS and EventBridge scheduler resources" \
  --policy-document file://isoplus-dev-email-readonly.json
```

```bash
aws iam create-policy --policy-name isoplus-dev-dlq-redrive \
  --description "Redrive dev SES event DLQ to its source queue. Purge explicitly denied" \
  --policy-document file://isoplus-dev-dlq-redrive.json
```

In Identity Center a customer managed policy is referenced **by name, not ARN**, and must already exist in every account the permission set is provisioned to. Identity Center does not create it. If the policy is missing, provisioning fails.

### 2. Attach references to the permission set

**Do not pass `Path`.** `Path=/` is rejected by the CLI shorthand parser with a regex ValidationException, even though `/` is the value it defaults to. Omit it.

```bash
aws sso-admin attach-customer-managed-policy-reference-to-permission-set \
  --instance-arn arn:aws:sso:::instance/ssoins-8259f8e2e37f3d10 \
  --permission-set-arn arn:aws:sso:::permissionSet/ssoins-8259f8e2e37f3d10/ps-3bfb45dd42b26ca5 \
  --customer-managed-policy-reference Name=isoplus-dev-email-readonly
```

Repeat for `isoplus-dev-dlq-redrive`.

### 3. Provision, or nothing reaches the account

Attaching a reference updates the permission set definition only. The IAM role in the account does not change until provisioning runs.

```bash
aws sso-admin provision-permission-set \
  --instance-arn arn:aws:sso:::instance/ssoins-8259f8e2e37f3d10 \
  --permission-set-arn arn:aws:sso:::permissionSet/ssoins-8259f8e2e37f3d10/ps-3bfb45dd42b26ca5 \
  --target-type ALL_PROVISIONED_ACCOUNTS
```

Then poll the returned request id until `SUCCEEDED`:

```bash
aws sso-admin describe-permission-set-provisioning-status \
  --instance-arn arn:aws:sso:::instance/ssoins-8259f8e2e37f3d10 \
  --provision-permission-set-request-id REQUEST_ID
```

In the console this is the amber "changes not provisioned" banner and its **Provision** button.

### 4. Verify against the role, not the permission set

```bash
aws iam list-attached-role-policies --role-name AWSReservedSSO_IsoplusDev_54cc012e6449f07d \
  --query "AttachedPolicies[].PolicyName" --output table
```

The IAM policy `AttachmentCount` stays at 0 until provisioning completes, so it is a useful confirmation that step 3 actually worked.

---

## Verified behaviour

Confirmed with `iam simulate-principal-policy` against the provisioned role, not assumed from the policy text.

| Action | Resource | Result |
|---|---|---|
| `sqs:StartMessageMoveTask` | dev DLQ | allowed |
| `sqs:ReceiveMessage` | dev DLQ | allowed |
| `sqs:SendMessage` | dev main queue | allowed |
| `sqs:PurgeQueue` | dev DLQ | **explicitDeny** |
| `sqs:StartMessageMoveTask` | any non-dev queue | implicitDeny |
| `sqs:ReceiveMessage` / `DeleteMessage` / `SendMessage` | any non-dev queue | implicitDeny |
| `ses:GetEmailIdentity` | `dev.isoplus.online` | allowed |
| `ses:GetEmailIdentity` | `isoplus.online` (production) | implicitDeny |
| `ses:SendEmail` | dev identity | implicitDeny |
| `ses:GetConfigurationSet` | `isoplus-dev` | allowed |
| `sns:GetTopicAttributes` | `isoplus-dev` | allowed |
| `sns:Publish` | `isoplus-dev` | implicitDeny |
| `events:DescribeRule` | `isoplus-dev-scheduler-invoice` | allowed |
| `events:EnableRule` | `isoplus-dev-scheduler-invoice` | implicitDeny |
| `events:DescribeRule` | `isoplus-mongodb-backup-daily` | implicitDeny |
| `secretsmanager:GetSecretValue` | EventBridge connection secret | implicitDeny |
| `ses:GetEmailIdentityPolicies` | `isoplus.online` (production) | implicitDeny |
| `ses:PutEmailIdentityDkimAttributes` | `isoplus.online` (production) | implicitDeny |
| `ses:DeleteEmailIdentity` | `isoplus.online` (production) | implicitDeny |
| `ses:GetConfigurationSet` | `delivery-reporting` (production) | implicitDeny |

The dev team can see and diagnose, and can redrive the dev DLQ. They cannot send email, publish to a topic, enable a scheduler rule, read the scheduler API keys, purge any queue, or touch anything outside `isoplus-dev-*`.

---

## Deliberate decisions

**`sqs:PurgeQueue` explicitly denied everywhere.** Purge sits two buttons from "Start DLQ redrive" in the console and destroys every message behind one dialog. An explicit Deny cannot be overridden by any later Allow.

**`ses:ListSuppressedDestinations` not granted.** The suppression list is account-wide and holds real client contacts. `ses:GetSuppressedDestination` is granted instead, which answers "is this address suppressed?" without exposing the rest.

**No Secrets Manager access.** `events:DescribeConnection` shows a connection exists and is authorised without revealing the API key, so nothing more is needed.

**`sqs:ReceiveMessage` is granted**, which is not strictly read-only. Without it a queue can be sized but never inspected. A receive without `--visibility-timeout 0` briefly hides a message from the consumer, which is harmless in dev. The safe form is in section 14 of [../01-developer-guide.md](../01-developer-guide.md).

**Production resource names stay visible, deliberately.** Reviewed 20 August 2026 and left as is.

The dev team's SES Identities list shows `isoplus.online` alongside `dev.isoplus.online`. That cannot be filtered: `ses:ListEmailIdentities` is an account-level operation and does not accept resource ARNs. The only lever is removing the action entirely, which breaks the Identities console page.

It was left in place because:

- Only the **name** is exposed. Every action against the production identity is denied, as the table above shows. Clicking it returns access denied
- The same constraint applies to `ses:ListConfigurationSets`, `sqs:ListQueues`, `sns:ListTopics` and `events:ListRules`. Hiding one production name while four other lists still show them conceals nothing and only breaks a page
- Broken console navigation tends to produce requests for broader access than was removed

The exposure worth controlling in this shared account is the suppression list, which holds real client addresses. That is locked down: `ses:ListSuppressedDestinations` is not granted.

If name-level separation is ever required, the fix is a separate AWS account for dev, not an IAM change.

---

## Notes

**Some statements must use `Resource: "*"`.** AWS does not support resource-level permissions on `sqs:ListQueues`, `sns:ListTopics`, `events:ListRules` or `cloudwatch:GetMetricStatistics`. Consequence: the dev team can see production resource **names** in console listings, but nothing about their contents.

**`cloudwatch:GetMetricStatistics` was previously being denied.** The existing inline policy scopes `cloudwatch:Get*` to `arn:aws:cloudwatch:*:*:alarm:*`, and that action does not accept an alarm ARN. Without the separate metrics statement the team could not graph queue depth.

**Re-authentication is not required.** Provisioning changes the policies attached to the role a live session already assumes, and IAM evaluates policy per request, so the change takes effect immediately. Verified: a redrive succeeded from an existing session with no sign-out. Re-login is only needed when the set of permission sets assigned to a *user* changes, since that alters which roles they can assume.

**Editing these policies later does not need re-provisioning.** Publishing a new default version of a customer managed policy takes effect at once, because the permission set references it by name and the role already has it attached. Only adding or removing a policy *reference* requires provisioning again.

**If a UAT account is added**, both policies must be created there with identical names before provisioning the permission set to it, or provisioning fails.

---

## Change log

**v2 of `isoplus-dev-dlq-redrive`, 20 August 2026.** `sqs:ListMessageMoveTasks` was originally scoped to the DLQ only. The SQS console calls that action with whichever queue is being viewed as the source ARN, so opening the **Dead-letter queue redrive tasks** tab on the *main* queue produced a red "Failed to load redrive task for this queue" banner.

The action was widened to both dev queues. It grants nothing meaningful: the main queue is never a move source, so the call returns an empty result rather than an AccessDenied. `StartMessageMoveTask` remains scoped to the DLQ alone, so the actual capability is unchanged.

Verified after the change:

| Action | DLQ | Main queue | Other queues |
|---|---|---|---|
| `ListMessageMoveTasks` | allowed | allowed | implicitDeny |
| `StartMessageMoveTask` | allowed | implicitDeny | implicitDeny |
| `PurgeQueue` | explicitDeny | explicitDeny | explicitDeny |
