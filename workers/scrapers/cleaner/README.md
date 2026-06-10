# Scrape cleaner

Node.js pipeline worker. Reads raw S3, outputs validated clean JSONL.

**Stages:** parse → validate → normalize (ADR 0001) → dedupe → quality score → quarantine or clean bucket

Uses `@skout/shared` for `normalizeDomain` / identity helpers and `@skout/scraper-contracts` for schemas.
