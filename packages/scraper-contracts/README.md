# Scraper contracts

Shared Zod schemas for the scraping platform (raw bot output, cleaned candidates, job payloads).

Consumed by orchestrator, cleaner, ingestor, and PAL `scraper` enrichment adapter.

**Planned exports:**

- `ScrapeJobRequest` — orchestrator input
- `RawScrapeRecord` — bot → S3 raw
- `ProspectCandidate` — cleaner output
- `ScrapeJobManifest` — lineage counts raw → clean → ingested

Implement with the first scrape story. Identity hashing stays in `@skout/shared` (ADR 0001).
