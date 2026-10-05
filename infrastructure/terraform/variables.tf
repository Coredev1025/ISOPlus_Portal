variable "aws_region" {
  description = "AWS region. Must match the region the SES identity is verified in."
  type        = string
  default     = "ap-southeast-2"
}

variable "environment" {
  description = "Environment short name. Used as a suffix on every resource name."
  type        = string

  validation {
    condition     = contains(["uat", "prod"], var.environment)
    error_message = "This module targets uat and prod only. Dev is managed manually and must not be imported."
  }
}

variable "name_prefix" {
  description = "Prefix for all resource names, e.g. isoplus-uat."
  type        = string
}

# ---------------------------------------------------------------------------
# SES
# ---------------------------------------------------------------------------

variable "sending_domain" {
  description = "Domain to verify as an SES identity, e.g. uat.isoplus.online."
  type        = string
}

variable "mail_from_subdomain" {
  description = "Subdomain label used for the custom MAIL FROM. Produces <label>.<sending_domain>."
  type        = string
  default     = "mail"
}

variable "manage_dns" {
  description = <<-EOT
    Whether Terraform should create the DKIM and MAIL FROM DNS records in Route 53.
    Set false if DNS for the domain is hosted elsewhere. When false you must create
    the records by hand and the identity will stay unverified until you do.
  EOT
  type        = bool
  default     = false
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone ID. Required only when manage_dns is true."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Recipient allowlist
# ---------------------------------------------------------------------------

variable "recipient_allowlist" {
  description = <<-EOT
    Recipient patterns the application credentials are permitted to send to.
    Applied as a ses:Recipients IAM condition.

    Set to an empty list in production to remove the restriction entirely.
    Note ForAllValues semantics: every recipient of a send must match, so one
    bad address fails the whole call. Subdomains do NOT match a parent pattern.
  EOT
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Application identity
# ---------------------------------------------------------------------------

variable "app_s3_buckets" {
  description = "S3 buckets the application IAM user needs full access to."
  type        = list(string)
  default     = []
}

variable "create_app_access_key" {
  description = <<-EOT
    Whether Terraform should create an access key for the application user.
    Leaving this false and creating the key by hand keeps the secret out of
    Terraform state. Recommended.
  EOT
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Event pipeline
# ---------------------------------------------------------------------------

variable "event_types" {
  description = "SES event types published to SNS."
  type        = list(string)
  default     = ["BOUNCE", "COMPLAINT", "DELIVERY", "DELIVERY_DELAY", "REJECT", "RENDERING_FAILURE"]
}

variable "queue_retention_seconds" {
  description = "How long unconsumed messages survive. 14 days is the maximum."
  type        = number
  default     = 1209600
}

variable "queue_visibility_timeout" {
  description = <<-EOT
    Seconds a message is hidden after being received. Must exceed the worst-case
    handler duration or messages will be redelivered while still being processed.
  EOT
  type        = number
  default     = 30
}

variable "max_receive_count" {
  description = "Failed receives before a message moves to the DLQ."
  type        = number
  default     = 5
}

# ---------------------------------------------------------------------------
# Alerting
# ---------------------------------------------------------------------------

variable "alert_email" {
  description = <<-EOT
    Address subscribed to the alerts topic. The subscription is created in a
    pending state and a human must click the confirmation link before any
    alarm notification is delivered.
  EOT
  type        = string
}

variable "subscribe_email_to_events" {
  description = <<-EOT
    Also send raw SES events to alert_email. Useful in UAT for eyeballing the
    pipeline, noisy and unnecessary in production.
  EOT
  type        = bool
  default     = false
}

variable "stalled_queue_threshold_seconds" {
  description = "Age of oldest message that means the consumer has stopped."
  type        = number
  default     = 900
}

# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

variable "enable_scheduler" {
  description = "Create the EventBridge scheduler resources."
  type        = bool
  default     = true
}

variable "scheduler_endpoint" {
  description = "Full URL of the scheduler tick endpoint."
  type        = string
  default     = ""
}

variable "scheduler_rules" {
  description = <<-EOT
    Scheduler rules to create. Key is the short name, value carries the schedule
    and the API key.

    The API key is written to Terraform state and to Secrets Manager. Supply it
    via environment variable (TF_VAR_scheduler_rules) or a tfvars file that is
    NOT committed.
  EOT
  type = map(object({
    schedule_expression = string
    api_key             = string
    description         = string
  }))
  default   = {}
  sensitive = true
}

variable "scheduler_rules_enabled" {
  description = <<-EOT
    Whether the scheduler rules fire. Keep false until the API endpoint is
    deployed and returning 2xx, otherwise EventBridge generates a failed
    invocation every minute.
  EOT
  type        = bool
  default     = false
}
