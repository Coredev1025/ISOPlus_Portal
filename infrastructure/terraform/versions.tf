terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # Remote state. Create the bucket and lock table once, by hand, before the
  # first init. See section 3 of 02-terraform-runbook.md.
  #
  # Uncomment and fill in per environment, or pass with -backend-config.
  #
  # backend "s3" {
  #   bucket         = "isoplus-tfstate"
  #   key            = "email/uat/terraform.tfstate"
  #   region         = "ap-southeast-2"
  #   dynamodb_table = "isoplus-tfstate-lock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      tenant      = "ISOCS"
      application = "isoplus-portal"
      environment = var.environment
      managed_by  = "terraform"
      component   = "email"
    }
  }
}
