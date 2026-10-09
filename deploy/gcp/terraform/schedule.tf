# Working-hours schedule for staging: up 10:00-22:00 IST on schedule_days, stopped otherwise.
# The database starts first and stops last so the services never run without it.
#   09:40 database start   09:50 VM start (Swarm services come back on their own, ~5 min)
#   22:00 VM stop          22:10 database stop
locals {
  schedule_tz = "Asia/Kolkata"
  sql_url     = "https://sqladmin.googleapis.com/v1/projects/${var.gcp_project}/instances/${google_sql_database_instance.pg.name}"
}

data "google_project" "this" {}

resource "google_project_service" "scheduler" {
  count              = var.schedule_enabled ? 1 : 0
  service            = "cloudscheduler.googleapis.com"
  disable_on_destroy = false
}

# ---------- VM: Compute Engine instance schedule ----------
resource "google_compute_resource_policy" "working_hours" {
  count  = var.schedule_enabled ? 1 : 0
  name   = "${local.prefix}-working-hours"
  region = var.gcp_region

  instance_schedule_policy {
    vm_start_schedule {
      schedule = "50 9 * * ${var.schedule_days}"
    }
    vm_stop_schedule {
      schedule = "0 22 * * ${var.schedule_days}"
    }
    time_zone = local.schedule_tz
  }

  depends_on = [google_project_service.apis]
}

# The schedule runs as the Compute Engine service agent, which needs permission to start and stop instances.
resource "google_project_iam_member" "compute_agent_scheduler" {
  count   = var.schedule_enabled ? 1 : 0
  project = var.gcp_project
  role    = "roles/compute.instanceAdmin.v1"
  member  = "serviceAccount:service-${data.google_project.this.number}@compute-system.iam.gserviceaccount.com"
}

# ---------- Database: Cloud Scheduler flips the Cloud SQL activation policy ----------
resource "google_service_account" "sql_scheduler" {
  count        = var.schedule_enabled ? 1 : 0
  account_id   = "${local.prefix}-sql-sched"
  display_name = "Starts and stops the staging database on schedule"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "sql_scheduler" {
  count   = var.schedule_enabled ? 1 : 0
  project = var.gcp_project
  role    = "roles/cloudsql.editor"
  member  = "serviceAccount:${google_service_account.sql_scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "sql" {
  for_each = var.schedule_enabled ? {
    start = { cron = "40 9 * * ${var.schedule_days}", policy = "ALWAYS" }
    stop  = { cron = "10 22 * * ${var.schedule_days}", policy = "NEVER" }
  } : {}

  name      = "${local.prefix}-db-${each.key}"
  region    = var.gcp_region
  schedule  = each.value.cron
  time_zone = local.schedule_tz

  retry_config {
    retry_count = 3
  }

  http_target {
    http_method = "PATCH"
    uri         = local.sql_url
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode({ settings = { activationPolicy = each.value.policy } }))

    oauth_token {
      service_account_email = google_service_account.sql_scheduler[0].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_project_service.scheduler, google_project_iam_member.sql_scheduler]
}
