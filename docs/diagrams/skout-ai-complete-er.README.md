# Skout AI — Complete ER Diagram (Mermaid)

## Files

| File | Purpose |
|------|---------|
| [`skout-ai-complete-er.mmd`](./skout-ai-complete-er.mmd) | **Paste into [mermaid.live](https://mermaid.live)** — must start with `erDiagram` (no leading comments) |
| [`skout-ai-data-flow.mmd`](./skout-ai-data-flow.mmd) | Data-flow overview diagram |
| [`skout-ai-database-schema.xlsx`](./skout-ai-database-schema.xlsx) | **Excel export** — tables, columns, FKs, indexes, design decisions |

## Scope

- 25 PostgreSQL tables (migrations 001–004)
- OpenSearch `prospects` index (external — not in Postgres)

## Design decisions (D1–D18)

| # | Decision |
|---|----------|
| D1 | No global `prospects`/`leads` table in PostgreSQL (~200M corpus in OpenSearch) |
| D2 | `prospect_id` is a logical key — not a FK to a prospects table |
| D3 | `prospect_id = SHA256(domain + ":" + SHA256(email))` — [ADR 0001](../adr/0001-canonical-prospect-id.md) |
| D4 | `company_id = SHA256(normalized_domain)` |
| D5 | Lead field data: `prospect_activations.snapshot` (JSONB) |
| D6 | `list_members` stores `prospect_id` only — JOIN activations for display |
| D7 | Search/filter → OpenSearch; workspace state → PostgreSQL |
| D8 | Redis caches search results (not in diagram — not a PG table) |
| D9 | `credit_transactions` = append-only ledger; `credit_balances` = cache |
| D10 | ICP config JSONB on `workspace_icp` |
| D11 | Enrichment PAL waterfall: jobs → attempts → results → snapshot merge |
| D12 | `async_jobs` mirrors BullMQ; `enrichment_jobs.async_job_id` links queue |
| D13 | Activation on list-add or enrich — not on every search view |
| D14 | CRM secrets via `credentials_ref` (not plain text) |
| D15 | 45-day MVP: search, enrich, score, list, export (sequences UI Phase 1) |
| D16 | HubSpot export one-way in MVP |
| D17 | `record_version` on `prospect_activations` (optimistic concurrency) |
| D18 | Row-level security deferred until Clerk auth wired |

## Migrations

| Migration | Tables |
|-----------|--------|
| 001 | `workspaces`, `prospect_activations`, `lists`, `list_members` |
| 002 | users, outreach, inbox, CRM, webhooks, `async_jobs` |
| 003 | `enrichment_jobs`, `enrichment_attempts`, `enrichment_results` |
| 004 | `credit_balances`, `credit_transactions`, `workspace_icp`, `prospect_scores` |

## How to view

1. Open [mermaid.live](https://mermaid.live)
2. Copy **entire** contents of `skout-ai-complete-er.mmd`
3. Paste into the editor

Full narrative: [mvp/05-database-er-diagram.md](../mvp/05-database-er-diagram.md)
