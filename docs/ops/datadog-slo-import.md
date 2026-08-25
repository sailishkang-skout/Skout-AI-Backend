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

Import dashboard: `docs/ops/datadog-slo-dashboard.json`  
Scrape also: `GET /api/v1/metrics`, `GET /api/v1/slo`

## OpenTelemetry
```bash
OTEL_TRACING_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # local collector
# prod example: https://otlp.example.com:4318
# OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20...
```

Local collector: `docker compose up -d otel-collector`
