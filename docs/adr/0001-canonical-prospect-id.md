# ADR 0001: Canonical prospect_id

## Status

Accepted

## Context

Production blueprint requires stable identity before first record ingest.

## Decision

```
prospect_id   = SHA256(normalized_company_domain + ":" + SHA256(email))
company_id    = SHA256(normalized_company_domain)
record_version = monotonic int for optimistic concurrency
```

Implemented in `@skout/shared` (`packages/shared/src/identity.ts`).

## Consequences

- Idempotent reindexes and billion-scale merges
- All ingest paths must use the same normalization rules
