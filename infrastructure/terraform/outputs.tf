output "sending_domain" {
  description = "SES domain identity."
  value       = aws_sesv2_email_identity.this.email_identity
}

output "mail_from_domain" {
  description = "Custom MAIL FROM domain."
  value       = local.mail_from_domain
}

output "configuration_set_name" {
  description = "Config set, attached to the identity as its default."
  value       = aws_sesv2_configuration_set.this.configuration_set_name
}

output "dkim_tokens" {
  description = "DKIM tokens. Create three CNAMEs from these if manage_dns is false."
  value       = aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens
}

output "dns_records_required" {
  description = "Every DNS record needed. Create these by hand when manage_dns is false."
  value = {
    dkim_cnames = [
      for t in aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens : {
        name  = "${t}._domainkey.${var.sending_domain}"
        type  = "CNAME"
        value = "${t}.dkim.amazonses.com"
      }
    ]
    mail_from_mx = {
      name  = local.mail_from_domain
      type  = "MX"
      value = "10 feedback-smtp.${var.aws_region}.amazonses.com"
    }
    mail_from_txt = {
      name  = local.mail_from_domain
      type  = "TXT"
      value = "v=spf1 include:amazonses.com ~all"
    }
  }
}

output "events_queue_url" {
  description = "Set as SES_EVENTS_QUEUE_URL in the application environment."
  value       = aws_sqs_queue.events.url
}

output "dlq_url" {
  description = "Dead letter queue URL, needed for the redrive procedure."
  value       = aws_sqs_queue.dlq.url
}

output "events_topic_arn" {
  value = aws_sns_topic.events.arn
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "app_user_name" {
  description = "IAM user the application authenticates as."
  value       = aws_iam_user.app.name
}

output "app_access_key_id" {
  description = "Only populated when create_app_access_key is true."
  value       = var.create_app_access_key ? aws_iam_access_key.app[0].id : null
}

output "app_secret_access_key" {
  description = "Only populated when create_app_access_key is true. Present in state, treat state as a secret."
  value       = var.create_app_access_key ? aws_iam_access_key.app[0].secret : null
  sensitive   = true
}

output "scheduler_rule_names" {
  description = "Scheduler rules and whether they are currently firing."
  value = {
    for k, r in aws_cloudwatch_event_rule.scheduler : k => {
      name     = r.name
      schedule = r.schedule_expression
      state    = r.state
    }
  }
}

output "post_apply_checklist" {
  description = "Things Terraform cannot do for you."
  value = compact([
    var.manage_dns ? null : "Create the DNS records listed in dns_records_required, then wait for verification.",
    "Confirm the SNS email subscription. Check the inbox for ${var.alert_email} and click the link.",
    var.create_app_access_key ? "Move the access key into the application secret store, then consider removing it from state." : "Create an access key for ${aws_iam_user.app.name} in the console and store it in the application secret store.",
    var.scheduler_rules_enabled ? null : "Scheduler rules are DISABLED. Enable once the endpoint is deployed and returning 2xx.",
    var.environment == "prod" ? "Confirm production sending access is granted on the account, and review the recipient allowlist is empty." : null,
  ])
}
