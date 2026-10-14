# CustomerOps alerts and dashboard (COPS-07)

> **Status (2026-10-14): Datadog setup skipped.** The Datadog trial (us5) has expired, and
> Aditya decided to skip the Datadog part for now. The webhook, the monitors and the dashboard
> below are not created. Their definitions stay in this folder for when an account is in place.
> Until then the health numbers are read in CustomerOps admin > Operations. With `DD_API_KEY`
> set, a refused metrics call is logged as a warning and never fails the worker.

Source of every number: `GET /api/v1/admin/ops/metrics` (needs `admin:read`), also shown on the
CustomerOps admin page under Operations. Each metric carries its own `warn_at`, `critical_at`,
`status` and `runbook`, so a monitor only has to read `status`.

Status: the metrics and thresholds below are implemented. The same numbers are computed
platform-wide every 10 minutes by the onboarding evaluator worker, written as one structured log
line per metric, and submitted to Datadog (us5) as gauges through the metrics API with the
`DD_API_KEY` the app already has:

- `skout.cops.metric_status`, tagged `metric:<key>`: 0 ok, 1 warning, 2 critical;
- `skout.cops.<key>`: the value;
- `skout.cops.report`: 1 per report (heartbeat).

`docs/ops/cops-monitors.json` holds three metric monitors over those gauges: a metric is critical,
a metric has stayed in warning for 30 minutes, and the report has stopped.

**Why metrics and not logs.** Checked on 2026-10-13: the Datadog account has no log index, and the
app sends it only APM traces (`skout_api`, `skout_api_bullmq`, `skout_crm`). The first version of
the monitors read log lines and could never have fired. The log lines stay for whoever reads logs
elsewhere.

**Where alerts go.** Into the web app, as in-app notifications for the Admin, owner and Engineering
members of one workspace. Datadog cannot write into the app, so the monitors notify a Datadog
webhook, which calls `POST /api/v1/webhooks/datadog/cops-alerts`. The endpoint has no session; it
checks a shared secret and refuses every call (503) until both settings below exist. A team email
address is added to the monitors as a fallback for when the web app itself is down.

Setup, once per environment:

1. In the encrypted env file (`deploy/hetzner/env-enc/api.env`, SOPS + age) set
   `DATADOG_WEBHOOK_SECRET` (a random string of 32 or more characters) and `OPS_ALERT_WORKSPACE_ID`
   (the id of the internal Skout workspace). Never put the secret in the repository or in chat.
2. In Datadog: Integrations > Webhooks > New. Name `skout-cops-alerts`. URL
   `https://<api host>/api/v1/webhooks/datadog/cops-alerts`. Custom headers:
   `{"X-Skout-Webhook-Secret": "<the secret>"}`. Payload:
   `{"alert_id": "$ALERT_ID", "cycle_key": "$ALERT_CYCLE_KEY", "transition": "$ALERT_TRANSITION", "title": "$EVENT_TITLE", "body": "$TEXT_ONLY_MSG", "link": "$LINK"}`
3. Create the monitors from `docs/ops/cops-monitors.json`; their messages already name
   `@webhook-skout-cops-alerts`. Append the team email handle to each message.
4. Use "Test notifications" on one monitor and check that the alert shows in the notification
   center of an Admin.
5. Create the dashboard: POST the `dashboard` object of `docs/ops/cops-dashboard.json` to
   `/api/v1/dashboard`. It has one graph per metric with its warning and critical lines, the status
   of every metric now, and whether the report is arriving. Do this after the first reports have
   arrived; before that every graph is empty.

A Datadog retry of the same state change notifies nobody twice; a recovery is a new notification.

**Limits.** The report runs every 10 minutes, so an outbox lag alert can be up to 10 minutes late.
The report needs Redis and the worker, which is why the "report has stopped" monitor exists. If the
web app or the API is down, the in-app alert cannot arrive: that is what the email fallback is for,
and its address is still to be given. The dashboard is defined in `docs/ops/cops-dashboard.json`
and has not been created in Datadog yet (step 5). Its threshold lines repeat the numbers in
`cops-ops-metrics.service.ts`; when a threshold changes there, change the file and update the
dashboard.

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
