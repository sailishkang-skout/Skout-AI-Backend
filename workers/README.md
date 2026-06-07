# Async worker pools — BullMQ (MVP) → Temporal (v1)

| Worker | Trigger | Package (planned) |
| --- | --- | --- |
| Waterfall | Temporal activity | `workers/waterfall` |
| Send | Temporal timer | `workers/send` |
| Warm-up | Cron | `workers/warmup` |
| CRM Sync | Kafka event | `workers/crm-sync` |
| AI Inference | Queue | `workers/ai-inference` |
| Scraper | Waterfall fallback | `workers/scraper` |
| Analytics ETL | Kafka consumer | `workers/analytics-etl` |

MVP uses BullMQ + Redis until Temporal is introduced (month 3–4 per development plan).
