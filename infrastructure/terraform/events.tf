# ---------------------------------------------------------------------------
# SNS
#
# Two topics on purpose.
#
#   events - SES delivery and bounce notifications, consumed by the app
#   alerts - CloudWatch alarm notifications, read by humans
#
# Do not merge them. Alarm payloads are a different JSON shape and would fail
# the application's event parser, fail five times, and fill the DLQ.
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "events" {
  name = var.name_prefix
}

resource "aws_sns_topic" "alerts" {
  name = "${var.name_prefix}-alerts"
}

data "aws_iam_policy_document" "events_topic" {
  statement {
    sid     = "AllowSesPublish"
    effect  = "Allow"
    actions = ["SNS:Publish"]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    resources = [aws_sns_topic.events.arn]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "events" {
  arn    = aws_sns_topic.events.arn
  policy = data.aws_iam_policy_document.events_topic.json
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# SQS
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name_prefix}-ses-events-dlq"
  message_retention_seconds = var.queue_retention_seconds
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "events" {
  name                       = "${var.name_prefix}-ses-events"
  message_retention_seconds  = var.queue_retention_seconds
  visibility_timeout_seconds = var.queue_visibility_timeout
  receive_wait_time_seconds  = 20 # long polling, keeps request cost near zero
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

# Lets the DLQ redrive messages back to the main queue from the console.
resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.events.arn]
  })
}

data "aws_iam_policy_document" "events_queue" {
  statement {
    sid     = "AllowSnsDeliver"
    effect  = "Allow"
    actions = ["sqs:SendMessage"]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    resources = [aws_sqs_queue.events.arn]

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.events.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "events" {
  queue_url = aws_sqs_queue.events.id
  policy    = data.aws_iam_policy_document.events_queue.json
}

# ---------------------------------------------------------------------------
# Subscriptions
# ---------------------------------------------------------------------------

resource "aws_sns_topic_subscription" "events_to_sqs" {
  topic_arn            = aws_sns_topic.events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.events.arn
  raw_message_delivery = true

  # raw_message_delivery = true puts the SES event JSON directly in the message
  # body. With it false the consumer has to unwrap an SNS envelope first.
  # Changing this breaks the consumer.
}

resource "aws_sns_topic_subscription" "events_to_email" {
  count = var.subscribe_email_to_events ? 1 : 0

  topic_arn = aws_sns_topic.events.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_sns_topic_subscription" "alerts_to_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email

  # Email subscriptions are created PendingConfirmation. Terraform reports
  # success but nothing is delivered until a human clicks the link in the
  # confirmation email. Verify after apply, see the runbook.
}
