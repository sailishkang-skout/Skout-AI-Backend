# Scraping platform

Bulk corpus scraping: orchestrate bots → raw S3 → clean → ingest OpenSearch.

**Architecture:** [docs/scraping-platform-architecture.md](../../docs/scraping-platform-architecture.md)  
**Diagram:** [docs/diagrams/skout-ai-scraping-platform.mmd](../../docs/diagrams/skout-ai-scraping-platform.mmd)

## Packages

| Path | Runtime | Role |
|------|---------|------|
| `orchestrator/` | Node + BullMQ | Job fan-out, rate limits, proxy/account assignment |
| `bots/linkedin/` | Python + Playwright | LinkedIn profiles and company pages |
| `bots/company-web/` | Python | Company website team/about parsing |
| `bots/shared/` | Python | Proxy client, sessions, base parser |
| `cleaner/` | Node | Validate, normalize, dedupe, quarantine |
| `ingestor/` | Node | Identity hash + OpenSearch bulk upsert |

## Queues

| Queue | Producer | Consumer |
|-------|----------|----------|
| `scrape:schedule` | Cron / API | orchestrator |
| `scrape:{source}` | orchestrator | bot for `{source}` |
| `scrape:clean` | bot (on complete) | cleaner |
| `scrape:ingest` | cleaner (on complete) | ingestor |

## Build order

1. `packages/scraper-contracts` — shared Zod schemas
2. Orchestrator + `scrape_jobs` Drizzle table (per story)
3. `company-web` bot — first end-to-end path
4. LinkedIn bot + account pool
5. Additional sources as separate bots

Implementation is added incrementally with user stories — no code until the first scrape story is picked up.
