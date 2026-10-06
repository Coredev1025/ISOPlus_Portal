# ---------------------------------------------------------------------------
# EventBridge scheduler
#
# Drives the invoicing and statement ticks by calling an authenticated HTTP
# endpoint on a fixed schedule.
#
# Each rule gets its own connection, so the two keys can be rotated
# independently and a leak of one does not expose the other.
# ---------------------------------------------------------------------------

# The variable carries the API keys, so Terraform treats the whole map as
# sensitive, and a sensitive value cannot drive for_each or count. The rule
# names ("invoice", "statement") are not secret, so they are unmarked here.
# Only the key itself stays sensitive; the schedule and description are
# unmarked below so a plan shows them.
locals {
  scheduler_rule_names = var.enable_scheduler ? nonsensitive(toset(keys(var.scheduler_rules))) : toset([])
}

resource "aws_cloudwatch_event_connection" "scheduler" {
  for_each = local.scheduler_rule_names

  name               = "${var.name_prefix}-scheduler-${each.key}"
  description        = nonsensitive(var.scheduler_rules[each.key].description)
  authorization_type = "API_KEY"

  auth_parameters {
    api_key {
      # The endpoint expects the bare key with no Bearer prefix.
      key   = "Authorization"
      value = var.scheduler_rules[each.key].api_key
    }
  }

  # EventBridge stores this in Secrets Manager automatically and manages the
  # secret's lifecycle. Do not create a secret for it yourself.
}

resource "aws_cloudwatch_event_api_destination" "scheduler" {
  for_each = local.scheduler_rule_names

  name                             = "${var.name_prefix}-tick-${each.key}"
  description                      = nonsensitive(var.scheduler_rules[each.key].description)
  invocation_endpoint              = var.scheduler_endpoint
  http_method                      = "POST"
  invocation_rate_limit_per_second = 10
  connection_arn                   = aws_cloudwatch_event_connection.scheduler[each.key].arn
}

resource "aws_cloudwatch_event_rule" "scheduler" {
  for_each = local.scheduler_rule_names

  name                = "${var.name_prefix}-scheduler-${each.key}"
  description         = nonsensitive(var.scheduler_rules[each.key].description)
  schedule_expression = nonsensitive(var.scheduler_rules[each.key].schedule_expression)
  state               = var.scheduler_rules_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "scheduler" {
  for_each = local.scheduler_rule_names

  rule      = aws_cloudwatch_event_rule.scheduler[each.key].name
  target_id = "${each.key}-tick"
  arn       = aws_cloudwatch_event_api_destination.scheduler[each.key].arn
  role_arn  = aws_iam_role.eventbridge_tick[0].arn

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
  count = length(local.scheduler_rule_names) > 0 ? 1 : 0

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
  count = length(local.scheduler_rule_names) > 0 ? 1 : 0

  name   = "invoke-api-destination"
  role   = aws_iam_role.eventbridge_tick[0].id
  policy = data.aws_iam_policy_document.eventbridge_tick.json
}
