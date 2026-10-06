# ---------------------------------------------------------------------------
# Application identity
#
# The application sends via the AWS SDK using these credentials. There are no
# SMTP credentials anywhere in this stack and none are needed.
# ---------------------------------------------------------------------------

locals {
  create_app_user = var.existing_app_user_name == ""
}

resource "aws_iam_user" "app" {
  count = local.create_app_user ? 1 : 0

  name = "${var.name_prefix}-app"
}

# The user the application already authenticates as. Looked up, not managed: this
# stack attaches one policy to it and never creates, changes or deletes the user.
data "aws_iam_user" "existing_app" {
  count = local.create_app_user ? 0 : 1

  user_name = var.existing_app_user_name
}

locals {
  app_user_name = local.create_app_user ? aws_iam_user.app[0].name : data.aws_iam_user.existing_app[0].user_name
}

data "aws_iam_policy_document" "app" {
  # S3, only if buckets were supplied.
  dynamic "statement" {
    for_each = length(var.app_s3_buckets) > 0 ? [1] : []

    content {
      sid    = "AppBuckets"
      effect = "Allow"
      actions = ["s3:*"]
      resources = flatten([
        for b in var.app_s3_buckets : [
          "arn:aws:s3:::${b}",
          "arn:aws:s3:::${b}/*",
        ]
      ])
    }
  }

  statement {
    sid    = "SesSend"
    effect = "Allow"

    actions = [
      "ses:SendEmail",
      "ses:SendRawEmail",
    ]

    # BOTH ARNs are required. Granting only the identity produces an
    # AccessDenied that names the configuration set, which reads like an
    # unrelated permissions problem and is easy to misdiagnose.
    resources = [
      aws_sesv2_email_identity.this.arn,
      "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:configuration-set/${aws_sesv2_configuration_set.this.configuration_set_name}",
    ]

    # Recipient allowlist. Omitted entirely when the list is empty, which is
    # the expected production configuration.
    dynamic "condition" {
      for_each = length(var.recipient_allowlist) > 0 ? [1] : []

      content {
        test     = "ForAllValues:StringLike"
        variable = "ses:Recipients"
        values   = var.recipient_allowlist
      }
    }
  }

  statement {
    sid    = "ConsumeSesEvents"
    effect = "Allow"

    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility", # required by the consumer heartbeat
    ]

    resources = [aws_sqs_queue.events.arn]
  }
}

resource "aws_iam_policy" "app" {
  name        = "${var.name_prefix}-app-policy"
  description = "ISO+ portal application access for ${var.environment}"
  policy      = data.aws_iam_policy_document.app.json
}

resource "aws_iam_user_policy_attachment" "app" {
  user       = local.app_user_name
  policy_arn = aws_iam_policy.app.arn
}

# Off by default. Creating the key here writes the secret into Terraform state
# in plaintext. Prefer creating it in the console and putting it straight into
# the application's secret store.
resource "aws_iam_access_key" "app" {
  count = var.create_app_access_key ? 1 : 0
  user  = local.app_user_name
}
