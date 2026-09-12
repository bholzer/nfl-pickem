terraform {
  required_version = ">= 1.5.0, < 2.0.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.24.0"
    }
  }

  # Configure an owner-only state path outside the repository during terraform init.
  backend "local" {}
}

provider "cloudflare" {}

variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "An explicit Cloudflare account ID is required."
  }
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "An explicit staging or production environment is required."
  }
}

locals {
  name = "nfl-pickem-${var.environment}"
}

resource "cloudflare_d1_database" "app" {
  account_id = var.account_id
  name       = local.name
  # Keep the API default explicit to avoid null/disabled refresh drift.
  read_replication = {
    mode = "disabled"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Wrangler owns versions, deployments, bindings and the native Workflow.
resource "cloudflare_worker" "app" {
  account_id = var.account_id
  name       = local.name
  subdomain = {
    enabled          = false
    previews_enabled = false
  }

  lifecycle {
    prevent_destroy = true
  }
}

output "account_id" {
  value = var.account_id
}

output "environment" {
  value = var.environment
}

output "database_id" {
  value = cloudflare_d1_database.app.id
}

output "database_name" {
  value = cloudflare_d1_database.app.name
}

output "worker_id" {
  value = cloudflare_worker.app.id
}

output "worker_name" {
  value = cloudflare_worker.app.name
}
