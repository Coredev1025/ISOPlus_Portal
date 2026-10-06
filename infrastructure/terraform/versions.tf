terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # Remote state lives in an S3 bucket, with S3-native locking
  # (use_lockfile = true, Terraform 1.10 or later). There is no DynamoDB
  # table. Create the bucket once, by hand, before the first init. See
  # section 3 of 02-terraform-runbook.md.
  #
  # The real values are supplied by a git-ignored backend_override.tf, so this
  # block stays commented out. Shape of that file:
  #
  # backend "s3" {
  #   bucket       = "isoplus-tfstate-<ENV>-<ACCOUNT_ID>-<REGION>"
  #   key          = "email/<ENV>/terraform.tfstate"
  #   region       = "<REGION>"
  #   use_lockfile = true
  #   encrypt      = true
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
