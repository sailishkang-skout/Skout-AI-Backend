# Datadog + OTel connection from env

## Datadog APM (existing code path)
Set on API/CRM tasks:
```bash
DD_API_KEY=...
DD_SITE=us5.datadoghq.com   # or your site
DD_SERVICE=skout-api
DD_ENV=development|uat|production
DD_VERSION=...
DD_AGENT_HOST=127.0.0.1     # ECS sidecar
DD_TRACE_AGENT_PORT=8126
```

## SLO dashboard + paging
- JSON: `docs/ops/datadog-slo-dashboard.json`
- Scrape also: `GET /api/v1/metrics`, `GET /api/v1/slo`
- **On-call owner (SkoutDev): Neeraj** (named 2026-08-25)

### Import
Datadog dashboard create API requires **both** `DD-API-KEY` and `DD-APPLICATION-KEY`.  
`SkoutDev/datadog` currently has `DD_API_KEY` + `DD_SITE` only (API-only → 401).

**Option A (UI — preferred until APP key exists):**  
Datadog → Dashboards → New Dashboard → Import JSON from `docs/ops/datadog-slo-dashboard.json`.

**Option B (API):** add `DD_APP_KEY` to `SkoutDev/datadog`, then:
```bash
# example — do not print keys
curl -X POST "https://api.us5.datadoghq.com/api/v1/dashboard" \
  -H "DD-API-KEY: $DD_API_KEY" \
  -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  -H "Content-Type: application/json" \
  -d @docs/ops/datadog-slo-dashboard.json
```

## OpenTelemetry (optional / local only)
Deployed envs use **Datadog APM** instead of a separate OTLP sink (enterprise decision 2026-08-25).

```bash
OTEL_TRACING_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # local collector only
# OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20...
```

Local collector: `docker compose up -d otel-collector`

## Secrets Manager (SkoutDev)
`SkoutDev/datadog` → `{ "DD_API_KEY": "...", "DD_SITE": "us5.datadoghq.com" }`  
Optional: `DD_APP_KEY` for automated dashboard import.  
After updating the secret, force ECS redeploy on `api` / `crm` / `ai` so tasks reload it.
