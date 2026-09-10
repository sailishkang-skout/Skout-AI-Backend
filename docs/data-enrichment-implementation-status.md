# Data Enrichment — Implementation Status

> Tracks delivery against [data-enrichment-strategy.md](./data-enrichment-strategy.md) (§1–§12).
> Last updated: **2026-06-11**

This document is the living checklist for the two-tier enrichment model:

- **Tier 1 (corpus)** — scrape → clean → ingest → OpenSearch (cheap, bulk)
- **Tier 2 (activation)** — on-demand PAL waterfall + AI scoring (paid, gated)

Related: [build-order tickets](./tickets/data-enrichment-build-order.md) · [credentials guide](./enrichment-credentials.md) · [flow diagram](./diagrams/skout-ai-data-enrichment-flow.mmd)

---

## Summary

| Layer | Status | Notes |
|-------|--------|-------|
| Shared contracts | ✅ Done | `@skout/scraper-contracts` (Zod schemas) |
| PAL (Tier 2) | ✅ MVP | Live + stub adapters; waterfall engine |
| Tier 2 API | ✅ Done | Enrich, credits, jobs, scoring, bulk list enrich |
| Tier 1 workers | 🟡 Partial | BullMQ + S3 + OpenSearch wired; bots/coverage thin |
| AI layer | 🟡 Partial | Heuristic scoring + LLM pain-points/personalize |
| DB schema | 🟡 Partial | Migrations generated; apply with `pnpm migrate` |
| Frontend | 🟡 Partial | Enrichment console + enrich actions; no ICP/smart lists UI |
| Infra / ECS | 🔴 Not done | ECR repos exist; no scraper ECS services deployed |

**Tests:** 32 passing (PAL, contracts, shared, opensearch, storage, workers, API).

---

## §1 — Core principle (build cheap, enrich on demand)

| Item | Status |
|------|--------|
| Two-tier cost model (corpus vs activation) | ✅ Architecture + code paths exist |
| Paid APIs only on user intent / score gate | ✅ Phone gated at `ENRICHMENT_PHONE_SCORE_GATE` (default 80) |
| AI as differentiator | 🟡 Heuristic scoring live; full LLM scoring not wired |

---

## §2 — Four-stage enrichment lifecycle

| Stage | What | Status |
|-------|------|--------|
| **1. Collect** | Scraper bots → raw S3 | 🟡 Node bots + BullMQ orchestrator; Python `company-web` still scaffold |
| **2. Resolve & enrich (bulk)** | Cleaner → normalized records | 🟡 Cleaner worker + technographics + basic signals |
| **3. Activate (on-demand)** | PAL waterfall | ✅ `@skout/pal` + API routes + credit gating |
| **4. Qualify (AI)** | ICP / intent / pain / readiness | 🟡 `/v1/score` heuristic; LLM for pain-points/personalize only |

---

## §3 — Filter → data point → source map

### §3.1 Company filters

| Field group | Status | Implementation |
|-------------|--------|----------------|
| Name, domain, description | 🟡 | `company-web` Node fetch; partial parse |
| Industry, sub-industry | 🟡 | Cleaner normalization; no AI classification |
| HQ location | 🟡 | OpenCorporates adapter (key-gated) |
| Employee count / buckets | 🔴 | LinkedIn headcount not production-ready |
| Revenue / funding | 🟡 | SEC EDGAR adapter; no Crunchbase bot |
| Growth metrics (3/6/12 mo) | 🔴 | Not implemented |
| Company stage | 🔴 | Not implemented |

### §3.2 Technology filters (technographics)

| Item | Status |
|------|--------|
| Self-hosted Wappalyzer rules | 🟡 Pattern table (~12 tools) in `workers/scrapers/cleaner/src/wappalyzer.ts` |
| Full Wappalyzer OSS rule set | 🔴 Not integrated |
| Wappalyzer Business API fallback (E2.2) | 🔴 Not implemented |

### §3.3 Hiring & intent signals

| Item | Status |
|------|--------|
| Basic signal derivation | 🟡 `workers/scrapers/cleaner/src/signals.ts` |
| LinkedIn Jobs / careers / job boards collectors | 🔴 Not implemented |
| Explorium / Bombora-style intent | 🔴 PAL adapter exists; no event ingestion pipeline |

### §3.4 Contact filters

| Item | Status |
|------|--------|
| People from LinkedIn / team pages | 🔴 LinkedIn bot is credential-gated scaffold |
| Email pattern generation | ✅ `packages/pal/src/email-patterns.ts` |
| Tenure, social, contact activity | 🔴 Not populated from scrapers |

### §3.5 Enrichment filters

| Item | Status |
|------|--------|
| Email verify waterfall | ✅ MillionVerifier → ZeroBounce → NeverBounce (+ Hunter fallback) |
| Phone on-demand | ✅ Datagma + Cognism adapters; score-gated |
| Verified-only persistence rule | 🟡 PAL logic; no E4.3 integration test |
| Social / buying signals | 🔴 Partial via signals stub only |

### §3.6 AI-powered filters

| Item | Status |
|------|--------|
| ICP match score + band | ✅ `/v1/score` + `GET/PUT /api/v1/icp` (`workspace_icp` DB) |
| Intent score | 🟡 Heuristic (signal count); not LLM |
| Pain-point detection | 🟡 `/v1/pain-points` (LLM when `OPENAI_API_KEY` set) |
| Outreach readiness | 🟡 Composite heuristic in scorer |
| Saved smart lists | 🟡 Backend CRUD + OpenSearch run; **no frontend UI** |
| Write scores back to OpenSearch corpus | 🔴 Not implemented |
| Batch re-score job | 🔴 Not implemented |

---

## §4 — Build-your-own corpus (Steps 1–4)

| Step | Status | Notes |
|------|--------|-------|
| Step 1 — Collect | 🟡 | Orchestrator + 4 bot adapters (Node); OpenCorporates/SEC/LinkedIn thin |
| Step 2 — Discover & enrich | 🟡 | Cleaner + Wappalyzer patterns + signals |
| Step 3 — AI intelligence | 🟡 | API scoring; no corpus-wide batch |
| Step 4 — Store in corpus | 🟡 | Ingestor bulk upserts OpenSearch + S3 manifests |

**Pipeline entrypoint:** `POST /api/v1/scrape/jobs` → BullMQ → S3 → cleaner → ingestor.

---

## §5 — Email discovery strategy

| Phase | Status |
|-------|--------|
| Phase 1 — pattern generation | ✅ Deterministic candidates in PAL |
| Phase 2 — verify & store valid only | ✅ PAL verify waterfall; 🟡 no E4.3 enforcement test |
| Hunter finder | ✅ Live adapter when key set |

---

## §6 — Phone strategy

| Item | Status |
|------|--------|
| On-demand only (no bulk buy) | ✅ |
| Score gate > 80 | ✅ `ENRICHMENT_PHONE_SCORE_GATE` |
| Datagma (default) | ✅ Adapter |
| Cognism (EMEA fallback) | ✅ Adapter |
| Kaspr / Lusha | 🔴 Not implemented |

---

## §7 — Provider catalog

### §7.1 Free / scraped sources (corpus backbone)

| Source | Status |
|--------|--------|
| OpenCorporates | 🟡 API adapter (key-gated) |
| SEC EDGAR | 🟡 Free JSON adapter |
| LinkedIn | 🔴 Scaffold only |
| Company websites | 🟡 Node fetch; Python bot scaffold |
| Google Business Profile | 🔴 Not started |
| Job boards / LinkedIn Jobs | 🔴 Not started |
| Crunchbase | 🔴 Not started |
| Wappalyzer (self-host) | 🟡 Pattern subset only |

### §7.2 Paid aggregators (PAL fallback)

| Provider | Status |
|----------|--------|
| PDL | ✅ |
| RevenueBase | ✅ |
| Explorium | ✅ |
| Coresignal | ✅ |
| Demandbase | 🔴 Not started |

---

## §8 — Two-tier cost model

| Tier | Status |
|------|--------|
| Tier 1 — corpus (infra only) | 🟡 Workers + packages; not deployed to ECS |
| Tier 2 — activation (per-outcome) | ✅ PAL + credits + enrichment tables |
| `internal_graph` cache step | 🔴 Documented but not implemented in engine |

---

## §9 — AI intelligence layer (`apps/ai`)

| Capability | Status | Endpoint |
|------------|--------|----------|
| ICP match | 🟡 Heuristic | `POST /v1/score` |
| Intent | 🟡 Heuristic | `POST /v1/score` |
| Pain points | 🟡 LLM + heuristic fallback | `POST /v1/pain-points` |
| Outreach readiness | 🟡 Heuristic composite | `POST /v1/score` |
| Personalization | 🟡 LLM + heuristic fallback | `POST /v1/personalize` |
| Persist to `ai_drafts` | 🔴 API returns JSON only; no DB write |

API proxy: `POST /api/v1/enrichment/score`, `POST /api/v1/enrichment/personalize`.

---

## §10 — Compliance & safety

| Item | Status |
|------|--------|
| Per-field source lineage | 🔴 Schema supports `provenance`; not populated end-to-end |
| Verified-only emails | 🟡 PAL logic; needs integration test |
| PII at rest (S3 SSE, lifecycle) | 🟡 CDK bucket exists; Glacier lifecycle not verified in this branch |
| LinkedIn rate caps / proxy pool | 🔴 Not implemented |
| GDPR audit trail | 🔴 Not automated |

---

## §11 — Market rollout

No regional phasing implemented yet — NA-first bot coverage is the default target but not enforced in code.

---

## §12 — Build order (roadmap checklist)

| # | Roadmap item | Status |
|---|--------------|--------|
| 1 | Corpus seed (company-web + OpenCorporates/SEC → OpenSearch) | 🟡 Code exists; E1.6 smoke test not automated |
| 2 | Technographics (Wappalyzer in cleaner) | 🟡 Pattern subset |
| 3 | People + email finding (LinkedIn + Hunter) | 🟡 Hunter done; people bot not production |
| 4 | Email verification gate | ✅ PAL adapters |
| 5 | Signals (jobs + funding + leadership) | 🔴 Collectors not built |
| 6 | AI layer (ICP / intent / pain / readiness) | 🟡 Partial |
| 7 | On-demand phone (Datagma, score > 80) | ✅ |
| 8 | Paid aggregator fallbacks (RevenueBase + PDL + …) | ✅ |

---

## Packages & services delivered

### New / extended packages

| Package | Purpose |
|---------|---------|
| `@skout/scraper-contracts` | Zod schemas for scrape/clean/ingest |
| `@skout/pal` | Provider Abstraction Layer waterfall |
| `@skout/storage` | S3 client + scrape zone key helpers |
| `@skout/opensearch` | Index, bulk upsert, search, smart-list queries |
| `@skout/db` | `scrape_jobs`, `smart_lists`, enrichment tables |

### Workers

| Worker | Queue | Status |
|--------|-------|--------|
| `@skout/scraper-orchestrator` | `scrape:schedule` → bot queues | 🟡 No rate limit / DLQ |
| `@skout/scraper-cleaner` | `scrape:clean` | ✅ |
| `@skout/scraper-ingestor` | `scrape:ingest` | ✅ |

### API routes (backend)

| Route | Purpose |
|-------|---------|
| `POST /api/v1/prospects/:id/enrich` | Single prospect activation |
| `POST /api/v1/prospects/activate` | Bulk activate |
| `POST /api/v1/lists/:id/enrich` | List bulk enrich |
| `GET /api/v1/enrichment/credits` | Credit balance |
| `GET /api/v1/enrichment/jobs` | Job history |
| `POST /api/v1/enrichment/score` | ICP/intent scoring |
| `POST /api/v1/enrichment/personalize` | Outreach personalization |
| `GET/PUT /api/v1/icp` | Workspace ICP config |
| `GET/POST /api/v1/smart-lists` | Smart list CRUD |
| `POST /api/v1/smart-lists/:id/run` | Run saved query against OpenSearch |
| `POST /api/v1/scrape/jobs` | Trigger corpus scrape job |

### Frontend (Skout Ai Frontend)

| Screen | Status |
|--------|--------|
| Enrichment console | ✅ |
| Prospect search — Enrich button | ✅ |
| Lists — bulk enrich | ✅ |
| Workspace ICP settings | 🔴 Placeholder page |
| Smart lists UI | 🔴 Not started |
| Scrape admin | 🔴 Not started |

---

## Remaining work (prioritized)

### P0 — Production blockers

1. Apply DB migration: `cd packages/db && pnpm migrate`
2. Deploy scraper workers to ECS (orchestrator, cleaner, ingestor)
3. E1.6 end-to-end corpus smoke test (100-company seed → OpenSearch search)
4. Orchestrator rate limits, retry backoff, dead-letter queue

### P1 — Corpus depth

5. Production `company-web` crawl (Playwright + proxy + UA rotation)
6. LinkedIn people/company bot with account pool + rate caps
7. Hiring / funding / leadership signal collectors (E5)
8. Growth metrics from historical snapshots (E5.3)
9. Populate §3 field map end-to-end + per-field provenance

### P2 — Activation completeness

10. `internal_graph` cache step in PAL engine
11. Verified-only persistence integration test (E4.3)
12. Wappalyzer OSS rules + Business API fallback (E2.2)

### P3 — AI & product

13. LLM-based intent scoring; write scores back to OpenSearch
14. Batch workspace re-score job
15. Personalize → persist `ai_drafts`
16. Frontend: ICP settings, smart lists, scrape admin
17. Create activation list from smart-list run

### P4 — Later / optional

18. Google Places, Crunchbase, Kaspr/Lusha, Similarweb
19. ClickHouse analytics path
20. Compliance automation (GDPR Article 14, audit exports)

---

## Local dev quick start

```bash
# Backend
cp .env.example .env   # set DATABASE_URL, REDIS_URL, OPENSEARCH_URL, SCRAPE_BUCKET
pnpm install && pnpm -r build && pnpm -r test
cd packages/db && pnpm migrate

# Start workers (separate terminals)
pnpm --filter @skout/scraper-orchestrator start
pnpm --filter @skout/scraper-cleaner start
pnpm --filter @skout/scraper-ingestor start

# Trigger corpus job
curl -X POST http://localhost:3001/api/v1/scrape/jobs \
  -H 'Content-Type: application/json' \
  -d '{"source":"company-web","seeds":["example.com"]}'
```

See [enrichment-credentials.md](./enrichment-credentials.md) for provider API keys.

---

## Related docs

- [Data enrichment strategy](./data-enrichment-strategy.md) — target architecture
- [Scraping platform architecture](./scraping-platform-architecture.md) — Tier 1 pipeline
- [Build-order tickets](./tickets/data-enrichment-build-order.md) — ClickUp backlog (E0–E9)
- [Enrichment credentials](./enrichment-credentials.md) — where to add API keys
