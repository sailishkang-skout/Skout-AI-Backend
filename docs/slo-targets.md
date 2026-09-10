# §11.2 Enterprise SLO targets (Wave-1 baseline — **locked 2026-08-26**)

These are the **contractual Wave-1 baseline** reliability targets for Skout Dev/Prod.
Customer-specific overrides require Product + Legal sign-off; default to this table until then.

| Service / path | Availability | Latency (p95) | Notes |
|---|---|---|---|
| `GET /api/v1/health` | 99.9% monthly | < 100 ms | Allowlisted; no auth |
| Authenticated CRUD (CRM/API) | 99.5% monthly | < 500 ms | Excludes enrichment/AI |
| Enrichment score / personalize | 99.0% monthly | < 5 s | Upstream AI bound |
| Warm-Up Tool `/health` | 99.9% monthly | < 200 ms | Internal VPC |
| Sequence enroll (API accept) | 99.5% monthly | < 1 s | Async advance separate |

**RPO / RTO (Postgres primary — locked):** RPO ≤ **5 min** (RDS automated backup/WAL); RTO ≤ **1 h**
for regional failover (ops runbook). Published on `GET /api/v1/slo`.

**Freshness SLAs (data plane — locked):**

| Data path | Max staleness | Measurement |
|---|---|---|
| Evidence Ledger (canonical ingest) | ≤ 5 min | `evidence_ledger.created_at` vs source event time |
| OpenSearch prospect index | ≤ 24 h | Last successful reindex job timestamp |
| HubSpot native CRM sync | ≤ 15 min | Last `crm_hubspot_sync` success per workspace |
| Signal ingest → timeline | ≤ 10 min | Signal `created_at` vs downstream activity row |

## How to measure locally

```bash
# Latency sample
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{time_total}\n" http://localhost:3001/api/v1/health
done

# Machine-readable SLO envelope
curl -s http://localhost:3001/api/v1/slo
```

## Production measurement
Datadog dashboard [`tr2-pbk-y85`](https://app.us5.datadoghq.com/dashboard/tr2-pbk-y85) + `GET /api/v1/metrics`
expose target gauges **and** §11.3 journey counters (`skout_journey_*`). Page on burn rate for
SLO breaches; alert when `skout_journey_ai_pin_fail_total` or evidence write fails spike.
