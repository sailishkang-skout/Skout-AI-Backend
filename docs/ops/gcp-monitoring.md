# GCP monitoring for staging: log shipping, dashboard and alerts

Written for: whoever applies the staging Terraform and on-call for CustomerOps.

Replaces the Datadog monitors in `docs/ops/cops-monitors.json` (Datadog is not used). The app writes
structured JSON log lines; the VM ships its Docker logs to Cloud Logging; Cloud Monitoring turns the
CustomerOps health lines into metrics, a dashboard and alerts.

## What is created

| Piece | Where | What it does |
|---|---|---|
| VM service account + roles | `monitoring.tf` | `roles/logging.logWriter` and `roles/monitoring.metricWriter`, attached to the VM |
| Google Ops Agent config | `deploy/gcp/ops-agent/config.yaml` | Reads `/var/lib/docker/containers/*/*-json.log` and sends it to Cloud Logging |
| Log-based metrics | `monitoring.tf` | Critical and warn health reports (by metric name), health reports received and report failures |
| Alert policies | `monitoring.tf` | Critical, three warns in a row, report failing. "Report stopped" is optional. |
| Dashboard | `monitoring.tf` | "Skout staging: CustomerOps health" |

These are the same four alerts as the Datadog definitions. The worker's `payment_webhooks_rejected_24h` health metric (warn at 1, critical at 10) is covered by the critical and warn alerts.

## Apply

1. Re-authenticate: `gcloud auth application-default login`.
2. In `deploy/gcp/terraform`: `terraform init`, then `terraform plan -var alert_email=<address>`.
3. Read the plan. Expected: new APIs, one service account, two IAM members, four log metrics, a
   notification channel, three alert policies and a dashboard, and **one in-place change to the VM**
   (it gets a service account). Terraform stops and starts the VM for that change (it is not replaced).
   There should be no `must be replaced` line. If there is one, stop.
4. Apply outside working hours or accept a short restart of staging.

Leave `alert_email` empty to create the metrics and dashboard without alert policies.

## Install the Ops Agent (once, on the VM)

The VM's startup script is ignored after first boot, so Terraform cannot install the agent. On the VM:

    curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
    sudo bash add-google-cloud-ops-agent-repo.sh --also-install
    sudo cp config.yaml /etc/google-cloud-ops-agent/config.yaml     # from deploy/gcp/ops-agent
    sudo systemctl restart google-cloud-ops-agent

Check: `systemctl is-active google-cloud-ops-agent` prints `active`, and Logs Explorer shows
`jsonPayload.log:"cops_metric"` lines within a few minutes.

## Notes

- **No alert while the VM is stopped.** The staging schedule stops the VM overnight and at weekends. The
  "report stopped" policy would page every night, so it is off (`alert_on_missing_health_report = false`).
- **Metrics arrive every 10 minutes**, so a first alert can take up to 15 minutes.
- **Cost:** Cloud Logging has a monthly free allowance per project, the agent and dashboards are free, and
  alert policies are a small per-condition charge. Confirm against Google's current pricing page. To cut
  volume, exclude noisy containers from the `_Default` log sink.
