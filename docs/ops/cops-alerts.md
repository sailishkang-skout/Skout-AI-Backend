# CustomerOps alerts and dashboard (COPS-07)

Source of every number: `GET /api/v1/admin/ops/metrics` (needs `admin:read`), also shown on the
CustomerOps admin page under Operations. Each metric carries its own `warn_at`, `critical_at`,
`status` and `runbook`, so a monitor only has to read `status`.

Status: the metrics and thresholds below are implemented. The same numbers are computed
platform-wide every 10 minutes by the onboarding evaluator worker and written as one structured log
line per metric (`cops_metric`, `value`, `metric_status`, `runbook`), at info, warn or error level.
`docs/ops/cops-monitors.json` holds four Datadog log monitors that read those lines.

**The monitors have not been imported into Datadog and no dashboard has been created.** That is an
operations task. Until it is done, "dashboards and alerting live" is not met. Two limits to know:
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

Webhook latency is measured from migration 0117 on: `provider_created_at` (the provider's own
event time) and `processed_at` are stored per event. Events received before that migration have
neither value and are left out of the two latency metrics. Events that match no payment request have
no workspace, so they appear only in the platform-wide report, not on a workspace's admin page.

## Migrations in this release

`0114` (tickets), `0115` (admin config), `0116` (retention runs) and `0117` (webhook latency) only
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
