# ---------------------------------------------------------------------------
# EventBridge scheduler
#
# Drives the invoicing and statement ticks by calling an authenticated HTTP
# endpoint on a fixed schedule.
#
# Each rule gets its own connection, so the two keys can be rotated
# independently and a leak of one does not expose the other.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_connection" "scheduler" {
  for_each = var.enable_scheduler ? var.scheduler_rules : {}

  name               = "${var.name_prefix}-scheduler-${each.key}"
  description        = each.value.description
  authorization_type = "API_KEY"

  auth_parameters {
    api_key {
      # The endpoint expects the bare key with no Bearer prefix.
      key   = "Authorization"
      value = each.value.api_key
    }
  }

  # EventBridge stores this in Secrets Manager automatically and manages the
  # secret's lifecycle. Do not create a secret for it yourself.
}

resource "aws_cloudwatch_event_api_destination" "scheduler" {
  for_each = var.enable_scheduler ? var.scheduler_rules : {}

  name                             = "${var.name_prefix}-tick-${each.key}"
  description                      = each.value.description
  invocation_endpoint              = var.scheduler_endpoint
  http_method                      = "POST"
  invocation_rate_limit_per_second = 10
  connection_arn                   = aws_cloudwatch_event_connection.scheduler[each.key].arn
}

resource "aws_cloudwatch_event_rule" "scheduler" {
  for_each = var.enable_scheduler ? var.scheduler_rules : {}

  name                = "${var.name_prefix}-scheduler-${each.key}"
  description         = each.value.description
  schedule_expression = each.value.schedule_expression
  state               = var.scheduler_rules_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "scheduler" {
  for_each = var.enable_scheduler ? var.scheduler_rules : {}

  rule     = aws_cloudwatch_event_rule.scheduler[each.key].name
  target_id = "${each.key}-tick"
  arn      = aws_cloudwatch_event_api_destination.scheduler[each.key].arn
  role_arn = aws_iam_role.eventbridge_tick[0].arn

  # No input block. The endpoint needs no body, it reads what is due from the
  # database. Keeping the payload empty means the schedule carries no business
  # logic and the rules never need changing when cadences change.
}

# ---------------------------------------------------------------------------
# Invocation role
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "eventbridge_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "eventbridge_tick" {
  count = var.enable_scheduler && length(var.scheduler_rules) > 0 ? 1 : 0

  name               = "${var.name_prefix}-eventbridge-tick"
  assume_role_policy = data.aws_iam_policy_document.eventbridge_assume.json
}

data "aws_iam_policy_document" "eventbridge_tick" {
  statement {
    effect    = "Allow"
    actions   = ["events:InvokeApiDestination"]
    resources = [for d in aws_cloudwatch_event_api_destination.scheduler : d.arn]
  }
}

resource "aws_iam_role_policy" "eventbridge_tick" {
  count = var.enable_scheduler && length(var.scheduler_rules) > 0 ? 1 : 0

  name   = "invoke-api-destination"
  role   = aws_iam_role.eventbridge_tick[0].id
  policy = data.aws_iam_policy_document.eventbridge_tick.json
}
