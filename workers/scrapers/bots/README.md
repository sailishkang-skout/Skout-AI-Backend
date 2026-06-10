# Scraper bots

One package per data source. Each bot:

1. Consumes `scrape:{source}` from BullMQ (via Redis bridge or SQS — TBD in first story)
2. Scrapes with Playwright / httpx
3. Writes **raw** JSONL to `s3://skout-{env}-scrape/raw/{source}/…`
4. Enqueues `scrape:clean` with `{ job_id, raw_s3_key }`

| Bot | Status |
|-----|--------|
| `linkedin/` | Planned |
| `company-web/` | Planned (first E2E candidate) |
| `shared/` | Proxy, session, parser base |

Bots never write to OpenSearch or PostgreSQL directly.
