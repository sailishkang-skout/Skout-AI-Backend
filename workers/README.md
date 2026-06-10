# Async worker pools — BullMQ (MVP) → Temporal (v1)

## Scraping platform (corpus build)

Bulk multi-source scraping (LinkedIn, company sites, etc.): orchestrate → scrape → clean → ingest OpenSearch.

| Component | Path |
| --- | --- |
| Full architecture | [docs/scraping-platform-architecture.md](../docs/scraping-platform-architecture.md) |
| Orchestrator | `workers/scrapers/orchestrator/` |
| Bots (per source) | `workers/scrapers/bots/` |
| Data cleaning | `workers/scrapers/cleaner/` |
| OpenSearch ingest | `workers/scrapers/ingestor/` |
| Shared schemas | `packages/scraper-contracts/` |

## Product workers (enrichment, outreach, analytics)

| Worker | Trigger | Package (planned) |
| --- | --- | --- |
| Waterfall | BullMQ / Temporal | `workers/waterfall` |
| Send | Temporal timer | `workers/send` |
| Warm-up | Cron | `workers/warmup` |
| CRM Sync | Kafka event | `workers/crm-sync` |
| AI Inference | Queue | `workers/ai-inference` |
| Scraper (PAL fallback) | Enrichment waterfall | Reuses `workers/scrapers/bots/` parsers |
| Analytics ETL | Kafka consumer | `workers/analytics-etl` |

MVP uses BullMQ + Redis until Temporal is introduced (month 3–4 per development plan).
