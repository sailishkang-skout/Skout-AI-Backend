locals {
  app_host = "stg.${var.base_domain}"
  prefix   = "skout-${var.environment}"
}

resource "google_project_service" "apis" {
  for_each           = toset(["compute.googleapis.com", "sqladmin.googleapis.com", "storage.googleapis.com", "iam.googleapis.com"])
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
  web_cidrs      = var.web_cidrs
  machine_type   = var.machine_type
  server_count   = var.server_count
  spot           = var.spot
  running        = var.running
  boot_disk_gb   = var.boot_disk_gb

  resource_policies = google_compute_resource_policy.working_hours[*].id

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
    disk_size         = var.db_disk_gb
    disk_type         = var.db_disk_type
    disk_autoresize   = true
    activation_policy = var.running ? "ALWAYS" : "NEVER"

    backup_configuration {
      enabled                        = var.db_backups
      point_in_time_recovery_enabled = var.db_backups
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

  # Cloud Scheduler starts and stops the database (schedule.tf); do not let apply undo that.
  lifecycle {
    ignore_changes = [settings[0].activation_policy]
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

# ---------- Object storage (Cloud Storage, reached through its S3-compatible API with an HMAC key) ----------
locals {
  # Same retention the old S3 lifecycle rules had (dev values). Cloud Storage has no Glacier transition for raw/.
  bucket_rules = {
    "exports"     = { age = 30, prefix = null }
    "email-intel" = { age = 30, prefix = null }
    "scrape"      = { age = 30, prefix = "quarantine/" }
  }
}

resource "google_storage_bucket" "bucket" {
  for_each                    = local.bucket_rules
  name                        = "${var.gcp_project}-${var.environment}-${each.key}"
  location                    = var.storage_location
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true # staging only

  lifecycle_rule {
    condition {
      age            = each.value.age
      matches_prefix = each.value.prefix == null ? [] : [each.value.prefix]
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_service_account" "app" {
  account_id   = "${local.prefix}-app"
  display_name = "Skout app object storage"

  depends_on = [google_project_service.apis]
}

resource "google_storage_hmac_key" "app" {
  service_account_email = google_service_account.app.email
}

resource "google_storage_bucket_iam_member" "app" {
  for_each = google_storage_bucket.bucket
  bucket   = each.value.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${google_service_account.app.email}"
}
