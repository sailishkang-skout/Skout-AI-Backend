# Logs, dashboard and alerts for staging on Cloud Logging and Cloud Monitoring. This replaces the Datadog
# monitors in docs/ops/cops-monitors.json (not used).
#
# The VM ships its Docker container logs to Cloud Logging through the Google Ops Agent
# (deploy/gcp/ops-agent/config.yaml, installed once by hand; see docs/ops/gcp-monitoring.md).
# Everything below reads those logs. The CustomerOps worker writes one JSON line per health metric every
# 10 minutes (fields cops_metric, value, metric_status, runbook), and the alerts match on those lines.
#
# Cost: Cloud Logging includes a monthly free allowance per project, the Ops Agent and dashboards are free,
# and a handful of alert policies is a small per-condition charge. Check Google's current pricing page.

# ---------- Identity the VM runs as ----------
resource "google_service_account" "vm" {
  account_id   = "${local.prefix}-vm"
  display_name = "Skout staging VM (Ops Agent: logs and metrics)"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "vm_log_writer" {
  project = var.gcp_project
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_project_iam_member" "vm_metric_writer" {
  project = var.gcp_project
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.vm.email}"
}

# ---------- Log-based metrics ----------
# The Ops Agent parses Docker's json-file wrapper, so the application's own JSON line is the string in
# jsonPayload.log. The filters match on that string, which avoids a second parse step.
locals {
  cops_worker = "jsonPayload.log:\"cops-onboarding-evaluator.worker\""
}

resource "google_logging_metric" "cops_critical" {
  name        = "cops_metric_critical"
  description = "CustomerOps health metric reported as critical, by metric name."
  filter      = "${local.cops_worker} AND jsonPayload.log:\"\\\"metric_status\\\":\\\"critical\\\"\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "cops_metric"
      value_type  = "STRING"
      description = "Health metric name"
    }
  }
  label_extractors = {
    "cops_metric" = "REGEXP_EXTRACT(jsonPayload.log, \"\\\"cops_metric\\\":\\\"([a-z0-9_]+)\\\"\")"
  }

  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "cops_warn" {
  name        = "cops_metric_warn"
  description = "CustomerOps health metric reported as warn, by metric name."
  filter      = "${local.cops_worker} AND jsonPayload.log:\"\\\"metric_status\\\":\\\"warn\\\"\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "cops_metric"
      value_type  = "STRING"
      description = "Health metric name"
    }
  }
  label_extractors = {
    "cops_metric" = "REGEXP_EXTRACT(jsonPayload.log, \"\\\"cops_metric\\\":\\\"([a-z0-9_]+)\\\"\")"
  }

  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "cops_report" {
  name        = "cops_health_report"
  description = "One count per CustomerOps health report (the outbox lag metric is written on every report)."
  filter      = "${local.cops_worker} AND jsonPayload.log:\"\\\"cops_metric\\\":\\\"outbox_lag_seconds\\\"\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }

  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "cops_report_failed" {
  name        = "cops_health_report_failed"
  description = "The CustomerOps health report threw."
  filter      = "${local.cops_worker} AND jsonPayload.log:\"cops ops metrics report failed\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }

  depends_on = [google_project_service.apis]
}

# ---------- Notification channel and alert policies ----------
resource "google_monitoring_notification_channel" "email" {
  count        = var.alert_email == "" ? 0 : 1
  display_name = "Skout staging alerts"
  type         = "email"
  labels       = { email_address = var.alert_email }

  depends_on = [google_project_service.apis]
}

locals {
  channels = google_monitoring_notification_channel.email[*].id
  runbook  = "Runbook path is in the runbook field of the log line. Alert definitions: docs/ops/gcp-monitoring.md."
}

resource "google_monitoring_alert_policy" "cops_critical" {
  count                 = var.alert_email == "" ? 0 : 1
  display_name          = "[CustomerOps] A workflow health metric is critical"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "critical report in the last 15 minutes"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.cops_critical.name}\" AND resource.type=\"gce_instance\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "900s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.cops_metric"]
      }
    }
  }

  documentation {
    content   = "A CustomerOps health metric is critical. ${local.runbook}"
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "3600s"
  }
}

resource "google_monitoring_alert_policy" "cops_warn" {
  count                 = var.alert_email == "" ? 0 : 1
  display_name          = "[CustomerOps] A workflow health metric is in warning"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "three warn reports in a row (30 minutes)"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.cops_warn.name}\" AND resource.type=\"gce_instance\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2
      duration        = "0s"
      aggregations {
        alignment_period     = "1800s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.cops_metric"]
      }
    }
  }

  documentation {
    content   = "A CustomerOps health metric has been in warning for three reports. ${local.runbook}"
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "7200s"
  }
}

resource "google_monitoring_alert_policy" "cops_report_failed" {
  count                 = var.alert_email == "" ? 0 : 1
  display_name          = "[CustomerOps] The health report itself is failing"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "report threw at least twice in 30 minutes"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.cops_report_failed.name}\" AND resource.type=\"gce_instance\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "0s"
      aggregations {
        alignment_period   = "1800s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  documentation {
    content   = "The CustomerOps health report threw. Check the database and the evaluator worker logs."
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "3600s"
  }
}

# Off by default: the staging VM is stopped overnight and at weekends, which would page every night.
resource "google_monitoring_alert_policy" "cops_report_missing" {
  count                 = var.alert_email != "" && var.alert_on_missing_health_report ? 1 : 0
  display_name          = "[CustomerOps] The health report has stopped"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "no health report for 30 minutes"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.cops_report.name}\" AND resource.type=\"gce_instance\""
      duration = "1800s"
      aggregations {
        alignment_period   = "600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  documentation {
    content   = "No CustomerOps health report in 30 minutes. The evaluator worker, Redis or the database is down."
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "3600s"
  }
}

# ---------- Dashboard ----------
resource "google_monitoring_dashboard" "customerops" {
  # Cloud Monitoring rewrites the stored JSON (key order and defaults), so every plan showed a change.
  lifecycle {
    ignore_changes = [dashboard_json]
  }

  dashboard_json = jsonencode({
    displayName = "Skout staging: CustomerOps health"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          xPos = 0, yPos = 0, width = 6, height = 4
          widget = {
            title = "Critical reports by metric"
            xyChart = {
              dataSets = [{
                plotType = "STACKED_BAR"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter      = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.cops_critical.name}\""
                    aggregation = { alignmentPeriod = "600s", perSeriesAligner = "ALIGN_SUM", crossSeriesReducer = "REDUCE_SUM", groupByFields = ["metric.label.cops_metric"] }
                  }
                }
              }]
            }
          }
        },
        {
          xPos = 6, yPos = 0, width = 6, height = 4
          widget = {
            title = "Warning reports by metric"
            xyChart = {
              dataSets = [{
                plotType = "STACKED_BAR"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter      = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.cops_warn.name}\""
                    aggregation = { alignmentPeriod = "600s", perSeriesAligner = "ALIGN_SUM", crossSeriesReducer = "REDUCE_SUM", groupByFields = ["metric.label.cops_metric"] }
                  }
                }
              }]
            }
          }
        },
        {
          xPos = 0, yPos = 4, width = 6, height = 4
          widget = {
            title = "Health reports received (expect one per 10 minutes while the VM runs)"
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter      = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.cops_report.name}\""
                    aggregation = { alignmentPeriod = "600s", perSeriesAligner = "ALIGN_SUM" }
                  }
                }
              }]
            }
          }
        },
      ]
    }
  })

  depends_on = [google_project_service.apis]
}
