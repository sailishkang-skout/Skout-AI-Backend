# Scrape orchestrator

Node.js BullMQ worker. Fans out scrape jobs to per-source queues and tracks lifecycle in PostgreSQL.

**Inputs:** `{ source, seeds[], options }`  
**Outputs:** BullMQ jobs on `scrape:{source}`; `async_jobs` / `scrape_jobs` rows

Planned dependencies: `bullmq`, `ioredis`, `@skout/db`, `@skout/scraper-contracts`
