# Skout AI — Scraping Platform Architecture

> Multi-source scraping bots (LinkedIn, company sites, and more) with deployment, data cleaning, and ingestion into the prospect corpus.

This platform is **separate from** the on-demand PAL enrichment waterfall (`internal_graph` → `apollo` → `hunter` → …). Those paths enrich a **single prospect** when a user triggers it. This document covers **bulk corpus collection** — scheduled and targeted scraping that feeds OpenSearch (and optionally ClickHouse).

---

## Goals

| Goal | Outcome |
|------|---------|
| Scale across sources | Add a new bot without changing orchestrator, cleaner, or ingestor |
| Safe deployment | Isolated scraper workers, secrets, rate limits, proxy pools |
| Clean data | Validate, normalize, dedupe before any record hits search |
| Canonical identity | All ingest paths use ADR 0001 (`prospect_id`, `company_id`) |
| Observable | Job status, per-source metrics, quarantine for bad rows |

---

## High-level pipeline

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐    ┌─────────────┐    ┌──────────────┐
│  Scheduler  │───►│ Orchestrator │───►│ Scraper bots│───►│   Cleaner   │───►│  Ingestor    │
│ (cron/API)  │    │  (BullMQ)    │    │ (per source)│    │  (pipeline) │    │ (OpenSearch) │
└─────────────┘    └──────────────┘    └──────┬──────┘    └──────┬──────┘    └──────────────┘
                                              │                  │
                                              ▼                  ▼
                                        S3 raw zone         S3 clean zone
                                        (immutable)         (validated JSONL)
```

**Stages**

1. **Schedule** — Cron, manual backfill, or API-triggered scrape jobs (by source, geo, industry, seed URL list).
2. **Orchestrate** — Split work into platform-specific jobs; enforce rate limits, proxy rotation, account pools.
3. **Scrape** — Bot writes **raw** payloads (HTML, JSON API responses, screenshots metadata) to S3.
4. **Clean** — Parse, validate, normalize fields, dedupe, quality-score; reject/quarantine bad rows.
5. **Ingest** — Hash identities, bulk-index to OpenSearch; optional ClickHouse row for analytics counts.

---

## Two operating modes

| Mode | Trigger | Output | Latency |
|------|---------|--------|---------|
| **Corpus build** (this doc) | Cron / backfill / seed list | OpenSearch bulk upsert | Minutes–hours |
| **Enrichment fallback** (PAL) | User clicks Enrich | `enrichment_results` → `prospect_activations` | Seconds |

Corpus-build scrapers feed the **global index**. PAL `scraper` adapter may call the same bot logic for a **single** LinkedIn URL or domain — reuse `packages/scraper-contracts` and bot parsers, but different queue and SLA.

---

## Component design

### 1. Orchestrator (`workers/scrapers/orchestrator`)

**Runtime:** Node.js + BullMQ (same Redis as API)

**Responsibilities**

- Accept scrape requests: `{ source, seeds[], options }`
- Fan out to per-platform queues: `scrape:linkedin`, `scrape:company-web`, …
- Track job lifecycle in PostgreSQL `async_jobs` + new `scrape_jobs` table (per story)
- Rate limiting per source (token bucket in Redis)
- Retry with exponential backoff; dead-letter queue for manual review
- Proxy/account assignment from Secrets Manager

**Queues**

| Queue | Consumer | Concurrency |
|-------|----------|-------------|
| `scrape:schedule` | Orchestrator | 1 |
| `scrape:linkedin` | LinkedIn bot | Low (account-bound) |
| `scrape:company-web` | Company web bot | Medium |
| `scrape:clean` | Cleaner worker | High |
| `scrape:ingest` | Ingestor worker | Medium |

### 2. Scraper bots (`workers/scrapers/bots`)

**Runtime:** Python 3.12 (Playwright / httpx) — one Docker image per bot family, or one image with `BOT=linkedin` env

| Bot | Source | Input | Raw output |
|-----|--------|-------|------------|
| `linkedin` | LinkedIn profiles, company pages | URL or search query | Profile JSON + raw HTML snapshot |
| `company-web` | Company websites | Domain | Team/about page parse |
| `crunchbase` | Crunchbase (API or scrape) | Company name/domain | Funding, size, industry |
| `google-maps` | Business listings | Geo + category | Name, domain, phone |
| *extensible* | New sources | Seed contract | `RawScrapeRecord` |

**Bot rules**

- Never write directly to OpenSearch or Postgres — only to **S3 raw**
- Emit `ScrapeJobResult` with `job_id`, `source`, `scraped_at`, `raw_s3_key`, `record_count`
- Use shared `bots/shared/` for proxy client, session store, captcha hook interface, user-agent rotation
- Platform credentials in Secrets Manager (`skout-dev/scraper/linkedin-accounts`, etc.)

### 3. Data cleaning (`workers/scrapers/cleaner`)

**Runtime:** Node.js or Python (Node preferred for Zod parity with `@skout/shared`)

**Pipeline stages** (each stage is a pure function; failed rows go to quarantine):

```
raw JSONL ──► parse ──► validate schema ──► normalize ──► dedupe ──► quality score ──► clean JSONL
```

| Stage | What it does |
|-------|----------------|
| **Parse** | Bot-specific parser → canonical `ProspectCandidate` |
| **Validate** | Zod/Pydantic: required fields, email format, URL safety |
| **Normalize** | `normalizeDomain()`, title casing, country codes (ISO), strip HTML |
| **Dedupe** | In-batch + cross-batch via `prospect_id` (ADR 0001) |
| **Quality score** | 0–100: email present, title sanity, domain resolvable |
| **Quarantine** | Rows below threshold or validation errors → `s3://…/quarantine/` |

**Canonical record** (`ProspectCandidate` — defined in `packages/scraper-contracts`):

```typescript
{
  source: "linkedin" | "company-web" | …;
  fullName?: string;
  title?: string;
  email?: string;
  companyName?: string;
  companyDomain: string;      // required for identity
  linkedinUrl?: string;
  country?: string;
  industry?: string;
  employeeCount?: number;
  scrapedAt: string;          // ISO
  rawS3Key: string;
  qualityScore: number;
}
```

### 4. Data ingestion (`workers/scrapers/ingestor`)

**Runtime:** Node.js

**Steps**

1. Read clean JSONL from S3
2. Compute `prospect_id` / `company_id` via `@skout/shared` identity helpers
3. Map to OpenSearch document shape (`prospectSummarySchema`)
4. Bulk upsert to OpenSearch (`_bulk`, batch 500–1000)
5. Emit metrics: `ingested`, `skipped_duplicate`, `failed`
6. Optional: append summary row to ClickHouse for corpus stats

**Idempotency:** Same `prospect_id` → update document (`_op_type: index` with same `_id`). Never create duplicate search hits.

**No Postgres writes** for corpus records — PostgreSQL only gets data on **activation** (user adds to list / enriches). See [database-schema.md](./database-schema.md).

---

## Storage layout (S3)

```
s3://skout-{env}-scrape/
├── raw/
│   └── {source}/{yyyy}/{mm}/{dd}/{job_id}/
│       ├── records.jsonl          # bot output
│       └── meta.json              # job config, account used, proxy
├── clean/
│   └── {source}/{yyyy}/{mm}/{dd}/{job_id}.jsonl
├── quarantine/
│   └── {source}/{job_id}/{reason}.jsonl
└── manifests/
    └── {job_id}.json              # lineage: raw → clean → ingest counts
```

Add bucket in CDK `DataStack` (per story): `skout-{env}-scrape` with lifecycle (raw → Glacier after 90d).

---

## Deployment architecture

```
                    ┌─────────────────────────────────────┐
                    │           VPC (private subnets)      │
                    │                                      │
  Internet ──► NAT ─┤  ┌─────────────┐  ┌──────────────┐ │
                    │  │ ECS: API    │  │ ECS: scraper │ │
                    │  │ (existing)  │  │ bots (new)   │ │
                    │  └──────┬──────┘  └──────┬───────┘ │
                    │         │                  │        │
                    │  ┌──────▼──────────────────▼──────┐ │
                    │  │ ElastiCache Redis (BullMQ)     │ │
                    │  └────────────────────────────────┘ │
                    │  ┌────────────┐  ┌─────────────────┐ │
                    │  │ RDS (jobs) │  │ S3 scrape raw   │ │
                    │  └────────────┘  └─────────────────┘ │
                    └─────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │ OpenSearch (Bonsai│
                    │ or AWS managed)   │
                    └───────────────────┘
```

| Service | ECS task | Scale on | Notes |
|---------|----------|----------|-------|
| `scraper-orchestrator` | 1 task, always on | — | Lightweight Node consumer |
| `scraper-bot-linkedin` | 0–N tasks | `scrape:linkedin` depth | Low concurrency; proxy egress |
| `scraper-bot-web` | 0–N tasks | `scrape:company-web` depth | Higher concurrency |
| `scraper-cleaner` | 1–3 tasks | `scrape:clean` depth | CPU-bound parsing |
| `scraper-ingestor` | 1–2 tasks | `scrape:ingest` depth | Network-bound bulk API |

**Secrets (AWS Secrets Manager)**

- `skout-{env}/scraper/linkedin-accounts` — session cookies / credentials (rotating pool)
- `skout-{env}/scraper/proxy` — residential proxy URL + auth
- `skout-{env}/scraper/captcha` — 2captcha / similar API key (optional)

**Networking:** Scraper tasks run in **private subnets** with NAT egress. Outbound traffic goes through **residential/datacenter proxy** — not the ALB. No inbound ports on scraper tasks.

**CI/CD:** New workflows build `scraper-*` images to ECR; deploy via CDK compute stack extension (per story).

---

## Observability

| Signal | Where |
|--------|-------|
| Job status | `scrape_jobs` table + BullMQ job state |
| Per-source success rate | CloudWatch metrics from orchestrator |
| Rows raw / clean / ingested | S3 manifest + ingestor logs |
| Quarantine volume | S3 prefix size alarm |
| Rate-limit hits | Redis counter + alert |

---

## Compliance & safety

- **Robots.txt / ToS:** Each bot documents allowed use; LinkedIn bot uses authenticated sessions only on approved accounts.
- **PII:** Raw HTML in S3 encrypted at rest (SSE-S3); lifecycle to Glacier/delete.
- **Rate limits:** Hard caps per account per hour; global circuit breaker pauses a source on HTTP 429 spike.
- **No credential logging:** Secrets never in job payloads or CloudWatch.

---

## Monorepo layout

```
workers/scrapers/
├── README.md
├── orchestrator/          # Node — BullMQ coordinator
├── bots/
│   ├── README.md
│   ├── linkedin/          # Python + Playwright
│   ├── company-web/
│   └── shared/            # Proxy, session, parsers base
├── cleaner/               # Node — validation + normalization
└── ingestor/              # Node — OpenSearch bulk

packages/
└── scraper-contracts/     # Zod schemas: RawScrapeRecord, ProspectCandidate, ScrapeJob
```

Build order (stories):

1. `packages/scraper-contracts` + S3 bucket in CDK
2. Orchestrator + `scrape_jobs` Drizzle schema
3. One bot (e.g. `company-web`) end-to-end: scrape → clean → ingest
4. LinkedIn bot + account pool + stricter rate limits
5. Additional sources as separate bot packages
6. PAL `scraper` adapter reuses bot parsers for single-record enrichment

---

## Related docs

- [Data enrichment strategy](./data-enrichment-strategy.md) — sources, providers, costs, and the build-cheap/enrich-on-demand model
- [Data flow diagram](./diagrams/skout-ai-data-flow.mmd) — search + enrichment OLTP path
- [Scraping platform diagram](./diagrams/skout-ai-scraping-platform.mmd) — this pipeline visual
- [ADR 0001 — canonical prospect ID](./adr/0001-canonical-prospect-id.md)
- [Database schema](./database-schema.md) — activation vs corpus split
- [workers/README.md](../workers/README.md) — all async workers
