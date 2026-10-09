# CustomerOps alerts and dashboard (COPS-07)

Source of every number: `GET /api/v1/admin/ops/metrics` (needs `admin:read`), also shown on the
CustomerOps admin page under Operations. Each metric carries its own `warn_at`, `critical_at`,
`status` and `runbook`, so a monitor only has to read `status`.

Status: the metrics and thresholds below are implemented. **No monitor or dashboard has been created
in Datadog yet.** That is an operations task: poll the endpoint per workspace (or run the same SQL
platform-wide) and alert on `status`.

| Metric | Warn | Critical | Runbook |
|---|---|---|---|
| `outbox_lag_seconds` (oldest unpublished event) | 60 s | 300 s | `runbooks/cops-platform.md` section 1 |
| `outbox_pending` | 500 | 5000 | `runbooks/cops-platform.md` section 1 |
| `outbox_dead_lettered` | 1 | 10 | `runbooks/cops-platform.md` section 2 |
| `provisioning_p95_ms` (30 days) | 120000 | 240000 | `runbooks/cops-commercial-credits.md` |
| `provisioning_within_target_pct` (30 days, lower is worse) | below 95 | below 80 | `runbooks/cops-commercial-credits.md` |
| `provisioning_failed` (30 days) | 1 | 5 | `runbooks/cops-commercial-credits.md` |
| `payment_webhooks_rejected_24h` (unmatched or never processed) | 1 | 10 | `runbooks/cops-commercial-credits.md` |
| `workflow_steps_stuck` (executing over 15 minutes) | 1 | 10 | `runbooks/cops-onboarding.md` |
| `workflow_steps_failed_24h` | 5 | 25 | `runbooks/cops-onboarding.md` |

Known limit: **webhook latency is not measured.** `payment_provider_events` stores only `received_at`,
so the endpoint reports webhook volume and the count that was not applied, not the time from provider
to applied. Measuring latency needs a `processed_at` column.

## Golden paths (Bible p.90) and where they are covered today

| Path | Backend tests | Browser |
|---|---|---|
| Free trial | provisioning service and route tests | Run live once (2026-10-09): provision, onboarding email, follow-up task, logged call |
| Paid deal | commercial and payment route tests | Mocked Playwright spec only |
| Failed payment | payment webhook tests (refund/failure keeps the workspace) | Not run in a browser |
| Stalled onboarding | onboarding signal tests | Mocked Playwright spec (`cops-onboarding.spec.ts`) |
| Ticket escalation | ticket service and route tests | Run live once (2026-10-09) and mocked spec (`cops-tickets.spec.ts`) |

There is no single end-to-end spec per golden path against a live backend, and the frontend
Playwright suite as a whole is red on `develop`. "All five golden paths green in CI" is not met.
