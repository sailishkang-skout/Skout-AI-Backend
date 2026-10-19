# CustomerOps alerts and dashboard (COPS-07)

Source of every number: `GET /api/v1/admin/ops/metrics` (needs `admin:read`), also shown on the
CustomerOps admin page under Operations. Each metric carries its own `warn_at`, `critical_at`,
`status` and `runbook`, so a monitor only has to read `status`.

Status: the metrics and thresholds below are implemented. The same numbers are computed
platform-wide every 10 minutes by the onboarding evaluator worker and written as one structured log
line per metric (`cops_metric`, `value`, `metric_status`, `runbook`), at info, warn or error level.
The four alerts that read those lines are defined in Terraform,
`deploy/gcp/terraform/monitoring.tf`, which is the source of truth (GCP Cloud Logging and Cloud
Monitoring; Datadog is not used, Aditya 2026-10-14). `docs/ops/cops-monitors.json` only lists them
and points there. The four: a metric is critical, a metric is in warning, the health report has
stopped (off by default, because the staging VM is stopped overnight), the health report itself is
failing. How to apply: `docs/ops/gcp-monitoring.md`.

Alerts reach the web app through `POST /api/v1/webhooks/ops-alerts`: the Terraform
`webhook_basicauth` notification channel (user name `skout`, password `OPS_ALERT_WEBHOOK_SECRET`). It
creates an in-app notification for the Admin, owner and Engineering members of
`OPS_ALERT_WORKSPACE_ID`, once per incident state (opened, closed). Without both settings it refuses
every call. Both go in the encrypted env file.

On staging, payment links made in the Razorpay dashboard for testing match no payment request and
put `payment_webhooks_rejected_24h` in warning. That is not a fault, so with
`ignore_payment_webhook_rejections` (default true) the critical and warning metrics leave it out.
Staging logs `env` as production, so this is keyed on the metric name.

Until the alerts are applied, "dashboards and alerting live" is not met; the numbers are on CustomerOps admin > Operations. Two limits to know:
the report runs every 10 minutes, so an outbox lag alert can be up to 10 minutes late; and the
report needs Redis and the worker, so the "health report has stopped" monitor matters most.

| Metric | Warn | Critical | Runbook |
|---|---|---|---|
| `outbox_lag_seconds` (oldest unpublished event) | 60 s | 300 s | `runbooks/cops-platform.md` section 1 |
| `outbox_pending` | 500 | 5000 | `runbooks/cops-platform.md` section 1 |
| `outbox_dead_lettered` | 1 | 10 | `runbooks/cops-platform.md` section 2 |
| `provisioning_p95_ms` (30 days) | 120000 | 240000 | `runbooks/cops-commercial-credits.md` |
| `provisioning_within_target_pct` (30 days, lower is worse) | below 95 | below 80 | `runbooks/cops-commercial-credits.md` |
| `provisioning_failed` (30 days) | 1 | 5 | `runbooks/cops-commercial-credits.md` |
| `payment_webhooks_rejected_24h` (unmatched or never processed) | 1 | 10 | `runbooks/cops-commercial-credits.md` |
| `payment_webhook_latency_p95_seconds` (provider send time to receipt, 24 hours) | 60 s | 300 s | `runbooks/cops-commercial-credits.md` |
| `payment_webhook_processing_p95_ms` (receipt to outcome, 24 hours) | 2000 | 10000 | `runbooks/cops-commercial-credits.md` |
| `workflow_steps_stuck` (executing over 15 minutes) | 1 | 10 | `runbooks/cops-onboarding.md` |
| `workflow_steps_failed_24h` | 5 | 25 | `runbooks/cops-onboarding.md` |

Webhook latency is measured from migration 0122 on: `provider_created_at` (the provider's own
event time) and `processed_at` are stored per event. Events received before that migration have
neither value and are left out of the two latency metrics. Events that match no payment request have
no workspace, so they appear only in the platform-wide report, not on a workspace's admin page.

## Migrations in this release

`0119` (tickets), `0120` (admin config), `0121` (retention runs) and `0122` (webhook latency) only
add tables and nullable columns; no existing row is rewritten, so there is no backfill. Each file
was applied twice in a row to the local test database without error. They have not been run
against a copy of production data.

## Golden paths (Bible p.90) and where they are covered today

| Path | Backend tests | Browser |
|---|---|---|
| Free trial | provisioning service and route tests | Run live once (2026-10-09): provision, onboarding email, follow-up task, logged call |
| Paid deal | commercial and payment route tests | Mocked Playwright spec only |
| Failed payment | payment webhook tests (refund/failure keeps the workspace) | Not run in a browser |
| Stalled onboarding | onboarding signal tests | Mocked Playwright spec (`cops-onboarding.spec.ts`) |
| Ticket escalation | ticket service and route tests | Run live once (2026-10-09) and mocked spec (`cops-tickets.spec.ts`) |

All five paths now also run end to end through the HTTP API on a real Postgres in
`apps/api/src/routes/cops-golden-paths.routes.test.ts` (part of `pnpm test`, so part of backend CI).
Real: routes, commercial gate, provisioning, credit ledger, SMTP send (to a catcher the test starts)
and signed payment webhooks. Stood in: the Razorpay API and the event worker (the test calls the
worker's consumers with the outbox event).

In the browser, `e2e/cops-golden-paths.spec.ts` in the frontend repo walks the same five paths
through the rep's screens against a stateful mock of the API (the paid-deal test waits for the gate
to open by polling, with no reload). No test drives a browser against a live backend.

Still not met: the frontend Playwright suite as a whole is red on `develop` because of older specs.
All 26 CustomerOps specs pass together when run in CI mode locally.
