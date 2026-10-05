# ---------------------------------------------------------------------------
# CloudWatch alarms
#
# Both point at the alerts topic, never the events topic. An alarm published to
# the events topic would be delivered to SQS, fail the consumer's JSON parse,
# retry five times and land in the DLQ.
#
# Both set ok_actions so a recovery notification arrives too. Without it an
# alarm that clears itself is silent and you are left wondering.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "queue_stalled" {
  alarm_name        = "${var.name_prefix}-ses-events-stalled"
  alarm_description = "SES event queue not being consumed. Oldest message older than ${var.stalled_queue_threshold_seconds / 60} minutes."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateAgeOfOldestMessage"
  statistic   = "Maximum"

  dimensions = {
    QueueName = aws_sqs_queue.events.name
  }

  comparison_operator = "GreaterThanThreshold"
  threshold           = var.stalled_queue_threshold_seconds
  period              = 300
  evaluation_periods  = 2 # two periods, so a single slow batch does not page anyone

  # An empty queue emits no datapoints. Without this the alarm sits in
  # INSUFFICIENT_DATA forever instead of OK.
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "dlq_nonempty" {
  alarm_name        = "${var.name_prefix}-ses-events-dlq-nonempty"
  alarm_description = "Messages landed in the SES events DLQ. Something failed ${var.max_receive_count} times running."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  statistic   = "Maximum"

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 1 # a single message in the DLQ is already worth knowing about

  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# ---------------------------------------------------------------------------
# Reputation alarms
#
# Not present in dev. Strongly recommended for production: crossing the bounce
# or complaint thresholds gets the account's sending paused by AWS, which takes
# down every application in the account, not just this one.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "bounce_rate" {
  count = var.environment == "prod" ? 1 : 0

  alarm_name        = "${var.name_prefix}-ses-bounce-rate"
  alarm_description = "SES bounce rate approaching the 5 percent threshold at which AWS pauses sending."

  namespace   = "AWS/SES"
  metric_name = "Reputation.BounceRate"
  statistic   = "Average"

  comparison_operator = "GreaterThanThreshold"
  threshold           = 0.03 # alarm well before the 0.05 enforcement point
  period              = 3600
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "complaint_rate" {
  count = var.environment == "prod" ? 1 : 0

  alarm_name        = "${var.name_prefix}-ses-complaint-rate"
  alarm_description = "SES complaint rate approaching the 0.1 percent threshold at which AWS pauses sending."

  namespace   = "AWS/SES"
  metric_name = "Reputation.ComplaintRate"
  statistic   = "Average"

  comparison_operator = "GreaterThanThreshold"
  threshold           = 0.0005
  period              = 3600
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}
