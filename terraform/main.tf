terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# ── D1 Database ────────────────────────────────────────────────────────────────

resource "cloudflare_d1_database" "metrics" {
  account_id = var.cloudflare_account_id
  name       = "tf-cf-wanstats-metrics"
}

# ── Render wrangler.jsonc from template ────────────────────────────────────────

resource "local_file" "wrangler_jsonc" {
  content = templatefile("${path.module}/../worker/wrangler.jsonc.tpl", {
    account_id     = var.cloudflare_account_id
    d1_database_id = cloudflare_d1_database.metrics.id
  })
  filename = "${path.module}/../worker/wrangler.jsonc"
}

# ── D1 Migration ───────────────────────────────────────────────────────────────

resource "null_resource" "migrate" {
  depends_on = [cloudflare_d1_database.metrics, local_file.wrangler_jsonc]

  triggers = {
    migration_hash = filesha256("${path.module}/../migrations/0001_initial.sql")
    database_id    = cloudflare_d1_database.metrics.id
  }

  provisioner "local-exec" {
    working_dir = "${path.module}/../worker"
    command     = "npx wrangler d1 execute tf-cf-wanstats-metrics --remote --file=${abspath(path.module)}/../migrations/0001_initial.sql"
    environment = {
      CLOUDFLARE_API_TOKEN = var.cloudflare_api_token
    }
  }
}

# ── Deploy Worker ──────────────────────────────────────────────────────────────

resource "null_resource" "deploy" {
  depends_on = [null_resource.migrate]

  triggers = {
    worker_hash   = filesha256("${path.module}/../worker/src/index.ts")
    wrangler_hash = sha256(local_file.wrangler_jsonc.content)
  }

  provisioner "local-exec" {
    working_dir = "${path.module}/../worker"
    command     = "npm install && npx wrangler deploy"
    environment = {
      CLOUDFLARE_API_TOKEN = var.cloudflare_api_token
    }
  }
}

# ── Worker Secret ──────────────────────────────────────────────────────────────
# WAN_API_TOKEN is the API token the worker uses at runtime to call the
# Cloudflare GraphQL Analytics API (Account Analytics: Read permission).
# Wrangler is used to set the secret so the value is passed via environment
# variable (never exposed in shell history or Terraform logs).

resource "null_resource" "set_wan_api_token" {
  depends_on = [null_resource.deploy]

  triggers = {
    token_hash = sha256(var.wan_api_token)
  }

  provisioner "local-exec" {
    working_dir = "${path.module}/../worker"
    # printf avoids a trailing newline that echo would add
    command     = "printf '%s' \"$SECRET_VALUE\" | npx wrangler secret put WAN_API_TOKEN"
    environment = {
      CLOUDFLARE_API_TOKEN = var.cloudflare_api_token
      SECRET_VALUE         = var.wan_api_token
    }
  }
}

# ── Outputs ───────────────────────────────────────────────────────────────────

output "d1_database_id" {
  description = "D1 database ID"
  value       = cloudflare_d1_database.metrics.id
}

output "workers_dev_url" {
  description = "Workers.dev URL for the dashboard"
  value       = "https://tf-cf-wanstats.${var.cloudflare_account_id}.workers.dev"
}
