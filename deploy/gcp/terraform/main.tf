locals {
  app_host = "stg.${var.base_domain}"
  prefix   = "skout-${var.environment}"
}

resource "google_project_service" "apis" {
  for_each           = toset(["compute.googleapis.com", "sqladmin.googleapis.com"])
  service            = each.key
  disable_on_destroy = false
}

module "compute" {
  source         = "./modules/compute"
  name           = local.prefix
  region         = var.gcp_region
  zone           = var.gcp_zone
  ssh_public_key = var.ssh_public_key
  ssh_user       = var.ssh_user
  admin_cidrs    = var.admin_cidrs
  machine_type   = var.machine_type
  server_count   = var.server_count

  depends_on = [google_project_service.apis]
}

# ---------- Postgres (Cloud SQL, point-in-time recovery) ----------
resource "random_password" "skout_db" {
  length  = 32
  special = false
}

resource "random_password" "pg_admin" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "pg" {
  name                = "${local.prefix}-pg"
  region              = var.gcp_region
  database_version    = "POSTGRES_16"
  deletion_protection = false

  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_size         = 20
    disk_autoresize   = true

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"

      # Only the application nodes may connect. range() keeps the keys known at plan time.
      dynamic "authorized_networks" {
        for_each = range(var.server_count)
        content {
          name  = "node-${authorized_networks.value + 1}"
          value = "${module.compute.public_ips[authorized_networks.value]}/32"
        }
      }
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "app" {
  for_each = toset(["skout", "email_intelligence", "email_warmup"])
  name     = each.key
  instance = google_sql_database_instance.pg.name
}

resource "google_sql_user" "skout" {
  name     = "skout"
  instance = google_sql_database_instance.pg.name
  password = random_password.skout_db.result
}

resource "google_sql_user" "postgres" {
  name     = "postgres"
  instance = google_sql_database_instance.pg.name
  password = random_password.pg_admin.result
}

# ---------- Cloudflare: tunnel, DNS, rate limits, R2 (shared with the Hetzner root) ----------
module "edge" {
  source                = "../../modules/edge"
  prefix                = local.prefix
  app_host              = local.app_host
  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_zone_id    = var.cloudflare_zone_id
  r2_location           = var.r2_location
}
