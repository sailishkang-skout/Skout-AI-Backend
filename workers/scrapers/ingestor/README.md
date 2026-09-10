# Scrape ingestor

Node.js worker. Reads clean JSONL from S3, bulk-upserts to OpenSearch.

1. Compute `prospect_id` / `company_id` via `@skout/shared`
2. Map to `prospectSummarySchema` document shape
3. OpenSearch `_bulk` upsert (idempotent by `prospect_id`)
4. Write manifest to `s3://…/manifests/{job_id}.json`

Does not write to PostgreSQL — activation happens when a user interacts with a prospect in the API.
