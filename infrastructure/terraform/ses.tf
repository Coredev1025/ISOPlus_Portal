locals {
  mail_from_domain = "${var.mail_from_subdomain}.${var.sending_domain}"
}

# ---------------------------------------------------------------------------
# Domain identity
# ---------------------------------------------------------------------------

resource "aws_sesv2_email_identity" "this" {
  email_identity         = var.sending_domain
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# Attaching the config set to the identity makes it the default for every send
# from this domain. The application then cannot accidentally send an untracked
# email by omitting ConfigurationSetName.

resource "aws_sesv2_email_identity_mail_from_attributes" "this" {
  email_identity         = aws_sesv2_email_identity.this.email_identity
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"

  # USE_DEFAULT_VALUE means SES falls back to amazonses.com if the MX record is
  # missing, so mail still goes out. REJECT_MESSAGE would drop it instead.
  # Keep the fallback unless you have a compliance reason not to.
}

# ---------------------------------------------------------------------------
# Configuration set
# ---------------------------------------------------------------------------

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = var.name_prefix

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }
}

resource "aws_sesv2_configuration_set_event_destination" "sns" {
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  event_destination_name = var.name_prefix

  event_destination {
    enabled              = true
    matching_event_types = var.event_types

    sns_destination {
      topic_arn = aws_sns_topic.events.arn
    }
  }
}

# ---------------------------------------------------------------------------
# DNS
#
# Only created when manage_dns is true and the zone is in Route 53. Otherwise
# create these by hand. The identity will report unverified until they resolve,
# which can take up to 72 hours but is usually minutes.
# ---------------------------------------------------------------------------

resource "aws_route53_record" "dkim" {
  count = var.manage_dns ? 3 : 0

  zone_id = var.route53_zone_id
  name    = "${aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.sending_domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "mail_from_mx" {
  count = var.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = local.mail_from_domain
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_txt" {
  count = var.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}
