# §11.2 Enterprise SLO targets (Wave-1 baseline)

These are the **initial** reliability targets for Skout Dev/Prod. They are policy +
measurement hooks — not a full SLO product dashboard (Grafana/Datadog boards remain an
ops ownership item).

| Service / path | Availability | Latency (p95) | Notes |
|---|---|---|---|
| `GET /api/v1/health` | 99.9% monthly | < 100 ms | Allowlisted; no auth |
| Authenticated CRUD (CRM/API) | 99.5% monthly | < 500 ms | Excludes enrichment/AI |
| Enrichment score / personalize | 99.0% monthly | < 5 s | Upstream AI bound |
| Warm-Up Tool `/health` | 99.9% monthly | < 200 ms | Internal VPC |
| Sequence enroll (API accept) | 99.5% monthly | < 1 s | Async advance separate |

**RPO / RTO (Postgres primary):** RPO ≤ 5 min (RDS automated backup/WAL); RTO ≤ 1 h for
regional failover (ops runbook).

## How to measure locally

```bash
# Latency sample
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{time_total}\n" http://localhost:3001/api/v1/health
done

# Machine-readable SLO envelope
curl -s http://localhost:3001/api/v1/slo
```

## Production next step
Point Datadog/OTel metrics at these SLIs and page on burn rate. Flip
`OTEL_TRACING_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` per env (see ADR 0004).
