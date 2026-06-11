# Data Enrichment — Build Order Tickets (ClickUp import)

> Copy-paste backlog for the [data-enrichment-strategy.md](../data-enrichment-strategy.md) build order (§12) and the [scraping platform](../scraping-platform-architecture.md).
> Structure: **10 Epics** → **stories**. Each story has Description, Acceptance Criteria, Dependencies, Estimate, Labels.
> Estimates use story points (SP): 1≈½ day, 2≈1 day, 3≈2 days, 5≈3–4 days, 8≈1 week, 13≈2 weeks.

Suggested ClickUp setup:
- **Space:** Skout AI · **Folder:** Data Enrichment Platform
- **Lists (= Epics):** E0–E9 below
- **Custom fields:** `Story Points` (number), `Layer` (dropdown: scraper / pal / ai / infra / contracts), `Tier` (dropdown: corpus / activation)
- **Tags:** see Labels per story

---

## E0 — Foundations (contracts + infra)

> Prereqs shared by everything else. Some already partially exist (S3 scrape bucket, ECR repos).

### E0.1 — Define shared scraper contracts (Zod)
**Description:** Implement `packages/scraper-contracts` exports used by orchestrator, bots, cleaner, ingestor, and PAL: `ScrapeJobRequest`, `RawScrapeRecord`, `ProspectCandidate`, `CompanyCandidate`, `ScrapeJobManifest`. Field set must cover the filter→field map in strategy §3 (firmographics, technographics, signals, contact, enrichment, AI fields). Identity hashing stays in `@skout/shared` (ADR 0001).
**Acceptance Criteria:**
- [ ] Package builds and is consumable via `workspace:*` from a Node worker.
- [ ] `ProspectCandidate` + `CompanyCandidate` include every field in strategy §3.1–§3.6.
- [ ] Schemas exported with inferred TS types; unit tests for parse/normalize of a sample record.
- [ ] `ScrapeJobManifest` captures raw→clean→ingested counts + per-field source lineage.
**Dependencies:** none
**Estimate:** 5 · **Labels:** contracts, corpus

### E0.2 — `scrape_jobs` Drizzle schema + migration
**Description:** Add `scrape_jobs` (and any `signals` lookup) tables to `packages/db` for job lifecycle + lineage. Generate + apply migration.
**Acceptance Criteria:**
- [ ] Drizzle schema for `scrape_jobs` (id, source, status, seeds, counts, started/finished, error).
- [ ] `pnpm db:generate` produces migration; `pnpm db:migrate` applies cleanly to dev.
- [ ] Indexed by `status` and `source`.
**Dependencies:** none
**Estimate:** 3 · **Labels:** infra, corpus

### E0.3 — Confirm scrape S3 zones + lifecycle + secrets
**Description:** Verify `skout-{env}-scrape` bucket zones (`raw/ clean/ quarantine/ manifests/`) and lifecycle (raw → Glacier 90d) are deployed; add Secrets Manager placeholders for scraper accounts/proxy/captcha.
**Acceptance Criteria:**
- [ ] Bucket + prefixes documented and reachable from ECS task role.
- [ ] Secrets `skout-{env}/scraper/{linkedin-accounts,proxy,captcha}` exist (placeholder ok).
- [ ] Lifecycle rule verified in CDK.
**Dependencies:** none (mostly done in infra)
**Estimate:** 2 · **Labels:** infra, corpus

---

## E1 — Corpus seed (company records → OpenSearch)

> Strategy §12.1. First end-to-end slice: scrape → clean → ingest for companies.

### E1.1 — Orchestrator service (BullMQ) skeleton
**Description:** `workers/scrapers/orchestrator` Node service: accept `ScrapeJobRequest`, fan out to per-source queues, track lifecycle in `scrape_jobs`, Redis token-bucket rate limiting, retry + DLQ.
**Acceptance Criteria:**
- [ ] Enqueues jobs to `scrape:company-web` and updates `scrape_jobs` state machine.
- [ ] Per-source rate limit configurable; exponential backoff + dead-letter queue.
- [ ] Deployed as `scraper-orchestrator` ECS task (1 always-on).
**Dependencies:** E0.1, E0.2, E0.3
**Estimate:** 8 · **Labels:** scraper, corpus

### E1.2 — `company-web` bot (Python)
**Description:** Bot crawls company website → writes `RawScrapeRecord` (HTML + parsed about/team) to S3 raw. Shared proxy/session/UA-rotation in `bots/shared/`.
**Acceptance Criteria:**
- [ ] Given a domain, writes `raw/company-web/{date}/{job_id}/records.jsonl` + `meta.json`.
- [ ] No direct writes to OpenSearch/Postgres.
- [ ] Emits `ScrapeJobResult` with counts + raw S3 key.
**Dependencies:** E1.1
**Estimate:** 8 · **Labels:** scraper, corpus

### E1.3 — OpenCorporates + SEC EDGAR ingest (company identity)
**Description:** Seed company identity/legal + public financials. OpenCorporates via API (paid key, commercial); SEC EDGAR via free JSON/full-text. Map to `CompanyCandidate`.
**Acceptance Criteria:**
- [ ] OpenCorporates adapter: name, jurisdiction, status, address → raw zone.
- [ ] SEC EDGAR adapter: revenue/financials + funding events for public cos.
- [ ] Provenance recorded per field.
**Dependencies:** E1.1
**Estimate:** 5 · **Labels:** scraper, corpus

### E1.4 — Cleaner pipeline (parse→validate→normalize→dedupe→score)
**Description:** `workers/scrapers/cleaner` Node service implementing strategy §3 mapping → `ProspectCandidate`/`CompanyCandidate`. Normalize domain/country/title; dedupe by `prospect_id`/`company_id`; quality score; quarantine failures.
**Acceptance Criteria:**
- [ ] Each stage is a pure, unit-tested function; failures → `quarantine/`.
- [ ] Writes `clean/{source}/{date}/{job_id}.jsonl`.
- [ ] Populates §3.1 company fields from E1.2/E1.3 output.
**Dependencies:** E1.2, E1.3
**Estimate:** 8 · **Labels:** scraper, corpus

### E1.5 — Ingestor → OpenSearch bulk upsert
**Description:** `workers/scrapers/ingestor` reads clean JSONL, computes identity via `@skout/shared`, bulk-upserts to OpenSearch (idempotent by `_id`), writes manifest, emits metrics.
**Acceptance Criteria:**
- [ ] Bulk batches 500–1000; same id updates (no duplicate hits).
- [ ] Manifest lineage (raw→clean→ingested) written to S3.
- [ ] Metrics: ingested / skipped_duplicate / failed.
**Dependencies:** E1.4 · (needs OpenSearch endpoint wired)
**Estimate:** 5 · **Labels:** scraper, corpus

### E1.6 — End-to-end corpus smoke test
**Description:** Run `company-web` + OpenCorporates/SEC for a seed list; verify records searchable in OpenSearch with §3.1 fields.
**Acceptance Criteria:**
- [ ] 100-company seed run completes; records queryable by name/domain/industry/location.
- [ ] Quarantine + manifest counts reconcile.
**Dependencies:** E1.5
**Estimate:** 3 · **Labels:** scraper, corpus

---

## E2 — Technographics

> Strategy §12.2 / §3.2. Keep free via self-hosted Wappalyzer rules.

### E2.1 — Self-hosted Wappalyzer detection in cleaner
**Description:** Integrate Wappalyzer OSS rule set against crawled HTML to produce categorized `tech_stack[]` (CRM, MAP, CMS, analytics, payments, cloud).
**Acceptance Criteria:**
- [ ] `tech_stack[]` populated with category + technology for crawled domains.
- [ ] Coverage report on seed set (% with ≥1 tech detected).
**Dependencies:** E1.4
**Estimate:** 5 · **Labels:** scraper, corpus

### E2.2 — Wappalyzer API fallback adapter
**Description:** Optional PAL/cleaner fallback to Wappalyzer Business API when self-host coverage is low/stale (1 credit/URL).
**Acceptance Criteria:**
- [ ] Adapter behind feature flag + credit guard; secret stored in Secrets Manager.
- [ ] Only called when self-host returns empty.
**Dependencies:** E2.1
**Estimate:** 3 · **Labels:** pal, activation

---

## E3 — People + email finding

> Strategy §12.3 / §5 Phase 1.

### E3.1 — People bot (LinkedIn + team pages)
**Description:** Bot extracts people (`full_name`, `title`, `department`, `seniority`, tenure) from approved LinkedIn sessions + company team pages → raw zone. Strict rate caps + residential proxy.
**Acceptance Criteria:**
- [ ] People records linked to `company_id`; §3.4 fields populated by cleaner.
- [ ] Account pool + per-account hourly cap enforced; 429 circuit breaker.
**Dependencies:** E1.4, E0.3
**Estimate:** 13 · **Labels:** scraper, corpus

### E3.2 — Email pattern generation
**Description:** Deterministic candidate generation (`john@`, `john.smith@`, `jsmith@`, …) from name + domain. No verification yet.
**Acceptance Criteria:**
- [ ] Generates ranked candidate list per contact; unit-tested across name formats.
- [ ] Stored as unverified candidates (never marked valid).
**Dependencies:** E3.1
**Estimate:** 3 · **Labels:** pal, activation

### E3.3 — Hunter.io finder adapter
**Description:** PAL adapter using Hunter to find/validate emails as a discovery source feeding Phase 1.
**Acceptance Criteria:**
- [ ] Adapter returns candidate emails + confidence; secret in Secrets Manager.
- [ ] Subscription/credit usage logged per call.
**Dependencies:** E3.2
**Estimate:** 3 · **Labels:** pal, activation

---

## E4 — Email verification gate

> Strategy §12.4 / §5 Phase 2. Only verified emails are stored/sent.

### E4.1 — MillionVerifier bulk first-pass adapter
**Description:** PAL `validate()` step — cheap bulk verification of candidates.
**Acceptance Criteria:**
- [ ] Batch verify; returns status per email; cheapest-first ordering.
- [ ] Results normalized to `email_status`, `is_catch_all`, `is_risky`, `deliverability_score`.
**Dependencies:** E3.2 (and E3.3)
**Estimate:** 3 · **Labels:** pal, activation

### E4.2 — ZeroBounce / NeverBounce accuracy gate
**Description:** Second-pass high-accuracy verify before an address is marked verified or used for sending.
**Acceptance Criteria:**
- [ ] Configurable primary provider; catch-all handling documented.
- [ ] Address marked `verified` only after passing gate; else discarded.
**Dependencies:** E4.1
**Estimate:** 3 · **Labels:** pal, activation

### E4.3 — Verified-only persistence rule
**Description:** Enforce across PAL + ingestor that unverified emails are never persisted to activation tables / sending.
**Acceptance Criteria:**
- [ ] Integration test: unverified candidate cannot reach `enrichment_results`/sending.
- [ ] Per-field source + verified-at timestamp stored.
**Dependencies:** E4.2
**Estimate:** 2 · **Labels:** pal, activation

---

## E5 — Signals (hiring / funding / leadership)

> Strategy §12.5 / §3.3 + §3.5.

### E5.1 — Hiring signals collector
**Description:** Collect from LinkedIn Jobs + careers pages + job boards → `is_hiring`, `open_jobs`, `hiring_by_dept{}`.
**Acceptance Criteria:**
- [ ] Hiring fields populated; department breakdown where available.
- [ ] Re-runs compute deltas for growth signals.
**Dependencies:** E1.4
**Estimate:** 5 · **Labels:** scraper, corpus

### E5.2 — Funding + leadership-change collector
**Description:** Crunchbase (pages/API) + SEC + news → `funding_*`, `investors[]`, leadership-change events → typed `signals[]` / `buying_signals[]`.
**Acceptance Criteria:**
- [ ] Funding (total, last round/date, investors, # rounds) populated.
- [ ] Events typed and timestamped; provenance stored.
**Dependencies:** E1.3, E1.4
**Estimate:** 5 · **Labels:** scraper, corpus

### E5.3 — Growth metrics (3/6/12 mo)
**Description:** Compute employee/hiring/funding growth from historical snapshots; optional Coresignal historical-headcount API.
**Acceptance Criteria:**
- [ ] `employee_growth_*`, `hiring_growth`, `funding_growth` computed from stored history.
- [ ] Coresignal fallback behind flag + credit guard.
**Dependencies:** E5.1, E5.2
**Estimate:** 5 · **Labels:** scraper, activation

---

## E6 — AI intelligence layer (`apps/ai`)

> Strategy §12.6 / §9 / §3.6.

### E6.1 — ICP match scoring
**Description:** Score corpus record vs. `workspace_icp` → `icp_score` (0–100) + band; write back to OpenSearch doc and `prospect_scores`.
**Acceptance Criteria:**
- [ ] Endpoint scores a record; band strong/medium/weak.
- [ ] Batch job can re-score corpus for a workspace.
**Dependencies:** E1.5
**Estimate:** 8 · **Labels:** ai, activation

### E6.2 — Intent + pain-point detection
**Description:** LLM over signals + firmographics + job posts → `intent_score`, typed `pain_points[]`.
**Acceptance Criteria:**
- [ ] Intent (buy/respond/need) and pain points returned with rationale.
- [ ] Pain points constrained to a typed enum.
**Dependencies:** E5.x, E6.1
**Estimate:** 8 · **Labels:** ai, activation

### E6.3 — Outreach readiness + personalization
**Description:** Composite `outreach_readiness` (ready/warm/nurture/not_qualified) + conversation starters feeding `ai_drafts`.
**Acceptance Criteria:**
- [ ] Readiness computed from ICP + intent + signals.
- [ ] Personalized opener generated and stored to `ai_drafts`.
**Dependencies:** E6.2
**Estimate:** 5 · **Labels:** ai, activation

### E6.4 — Saved smart lists
**Description:** Persist dynamic filter sets re-run against corpus (e.g. "Seed SaaS hiring SDRs").
**Acceptance Criteria:**
- [ ] User can save a filter set; re-running returns fresh matches.
- [ ] Smart list backed by stored OpenSearch query.
**Dependencies:** E6.1
**Estimate:** 5 · **Labels:** ai, corpus

---

## E7 — On-demand phone enrichment

> Strategy §12.7 / §6. Gated by `lead_score > 80`.

### E7.1 — Datagma phone adapter (default)
**Description:** PAL adapter fetching mobile/direct/HQ on demand; API on every Datagma plan.
**Acceptance Criteria:**
- [ ] Returns `phone_mobile`/`phone_direct`/`phone_hq` with source + timestamp.
- [ ] Secret in Secrets Manager; credit usage logged.
**Dependencies:** E4.x (activation path)
**Estimate:** 3 · **Labels:** pal, activation

### E7.2 — Score gate (lead_score > 80)
**Description:** Only trigger phone enrichment when `lead_score > 80` (user action or auto).
**Acceptance Criteria:**
- [ ] Phone enrichment refused below threshold; threshold configurable per workspace.
- [ ] Spend metric per workspace.
**Dependencies:** E7.1, E6.1
**Estimate:** 2 · **Labels:** pal, activation

### E7.3 — Cognism EMEA fallback (later)
**Description:** Add Cognism phone-verified fallback for EMEA when enterprise demand justifies.
**Acceptance Criteria:**
- [ ] Adapter behind flag; region-routing EU contacts to Cognism.
**Dependencies:** E7.1
**Estimate:** 3 · **Labels:** pal, activation

---

## E8 — Paid aggregator fallbacks (PAL waterfall)

> Strategy §12.8 / §7.2. Per-outcome, only on miss/stale.

### E8.1 — PAL waterfall orchestration
**Description:** Implement `internal_graph → external` waterfall with per-outcome billing, stale/missing detection, and provider ordering.
**Acceptance Criteria:**
- [ ] Internal cache checked first; external only on miss/stale.
- [ ] Per-outcome cost + provider recorded on `enrichment_results`.
**Dependencies:** E4.x
**Estimate:** 8 · **Labels:** pal, activation

### E8.2 — RevenueBase adapter
**Description:** Company match + enrich + semantic search; per-outcome pricing, free tier for dev.
**Acceptance Criteria:**
- [ ] Resolve + enrich firmographics; x-key auth; only billed on result.
**Dependencies:** E8.1
**Estimate:** 3 · **Labels:** pal, activation

### E8.3 — People Data Labs adapter
**Description:** Company + person enrich fallback (cheap company enrich).
**Acceptance Criteria:**
- [ ] Company + person enrich endpoints wired; 1 credit/successful request tracked.
**Dependencies:** E8.1
**Estimate:** 3 · **Labels:** pal, activation

### E8.4 — Explorium + Coresignal adapters (as needed)
**Description:** Explorium for multi-signal events at scale; Coresignal for historical headcount/jobs datasets.
**Acceptance Criteria:**
- [ ] Match→Enrich→Event (Explorium) behind flag; Coresignal Collect/Search credits tracked.
- [ ] Used only where unique data is required (documented).
**Dependencies:** E8.1
**Estimate:** 5 · **Labels:** pal, activation

---

## E9 — UI triggers & activation API (how the UI fires enrichment)

> How the product UI triggers Tier-2 activation, plus the async job contract the frontend needs. See strategy §8 (two-tier model) and the existing `prospect.routes.ts` (`POST /prospects/:id/enrich` already returns `202`).

### E9.1 — Enrichment job lifecycle (jobs tables + BullMQ wiring)
**Description:** Back the existing `POST /prospects/:id/enrich` with real async infra: write `enrichment_jobs` + `async_jobs`, enqueue BullMQ, run the PAL waterfall in a worker, persist `enrichment_results` + update `prospect_activations`. Status machine: `queued → running → done/failed`.
**Acceptance Criteria:**
- [ ] `POST /prospects/:id/enrich` returns `202 { jobId, status: "queued" }`.
- [ ] Worker transitions status and writes results idempotently (safe to retry).
- [ ] Failures captured with reason; job is retryable.
**Dependencies:** E8.1 (PAL waterfall), E0.2
**Estimate:** 5 · **Labels:** pal, activation

### E9.2 — Job status endpoint (polling contract)
**Description:** `GET /api/v1/enrichment/jobs/:jobId` returning status + progress + per-step results; also surface latest status on `GET /prospects/:id` so the card can refresh.
**Acceptance Criteria:**
- [ ] Returns `status`, `steps[]` (firmographics/email/phone), `updatedAt`.
- [ ] `GET /prospects/:id` includes `enrichmentStatus` for inline UI refresh.
- [ ] 404 for unknown/foreign-workspace job.
**Dependencies:** E9.1
**Estimate:** 3 · **Labels:** pal, activation

### E9.3 — Bulk / list enrichment
**Description:** `POST /api/v1/lists/:id/enrich` to enqueue enrichment for every member (real usage is bulk, not one-by-one). Fan out into per-prospect jobs under a parent batch.
**Acceptance Criteria:**
- [ ] Creates a batch job; per-member child jobs tracked.
- [ ] `GET .../batch/:batchId` returns aggregate progress (done/failed/total).
- [ ] Respects per-workspace credit balance + concurrency caps.
**Dependencies:** E9.1, E9.2
**Estimate:** 5 · **Labels:** pal, activation

### E9.4 — Add-to-list activation (corpus → Postgres)
**Description:** When a user adds corpus prospects to a list (`POST /lists` / list members), copy the OpenSearch record into `prospect_activations` (activation = OLTP write). No external spend yet.
**Acceptance Criteria:**
- [ ] List add creates/links `prospect_activations` rows by `prospect_id`.
- [ ] Idempotent; no duplicate activations.
**Dependencies:** E1.5
**Estimate:** 3 · **Labels:** pal, activation

### E9.5 — Credit gating + phone score gate (UI-enforced spend)
**Description:** Enforce credit checks before any paid step; enforce `lead_score > 80` for phone enrichment specifically. Return clear 402/422 with reason so UI can prompt upgrade/confirm.
**Acceptance Criteria:**
- [ ] Paid steps blocked when `credit_balances` insufficient → `402` with needed amount.
- [ ] Phone step skipped (not errored) when `lead_score <= 80`; reason surfaced in job result.
- [ ] Credit transaction recorded per successful outcome.
**Dependencies:** E9.1, E6.1, E7.2
**Estimate:** 3 · **Labels:** pal, activation

### E9.6 — Real-time progress (SSE/WebSocket) — optional
**Description:** Push enrichment job updates to the UI instead of polling (SSE or WS channel per workspace).
**Acceptance Criteria:**
- [ ] UI receives `job.updated` events with status transitions.
- [ ] Falls back to polling (E9.2) when stream unavailable.
**Dependencies:** E9.2
**Estimate:** 5 · **Labels:** pal, activation

### E9.7 — Auto-enrich on score threshold — optional
**Description:** When AI `icp_score`/`lead_score` crosses a workspace-configured threshold, auto-trigger the same enrichment job without a click.
**Acceptance Criteria:**
- [ ] Threshold configurable per workspace; toggle on/off.
- [ ] Auto-jobs respect credit gating (E9.5) and are labeled `auto`.
**Dependencies:** E9.1, E6.1
**Estimate:** 3 · **Labels:** pal, ai, activation

### E9.8 — Admin scrape trigger (Tier-1, internal only)
**Description:** Internal Admin API/UI to launch corpus scrape jobs (`POST /admin/scrape-jobs`) — by source, geo, industry, seed list. NOT exposed to customers.
**Acceptance Criteria:**
- [ ] Admin-only auth; enqueues to orchestrator `scrape:schedule`.
- [ ] Job appears in `scrape_jobs` with status tracking.
**Dependencies:** E1.1
**Estimate:** 3 · **Labels:** scraper, infra, corpus

---

## Suggested sequencing (dependency order)

1. **E0** (foundations) → 2. **E1** (corpus seed E2E) → 3. **E2** (tech) + **E5** (signals) in parallel → 4. **E3** (people/email find) → 5. **E4** (verify gate) → 6. **E6** (AI layer) → 7. **E7** (phone) → 8. **E8** (paid fallbacks) → 9. **E9** (UI triggers — E9.1/E9.2/E9.4 alongside E8, rest after).

**Critical path to first demo:** E0.1 → E0.2/E0.3 → E1.1 → E1.2/E1.3 → E1.4 → E1.5 → E1.6 → E6.1 (searchable, AI-scored corpus).

**Critical path to first enrichment UX:** E8.1 → E9.1 → E9.2 → E9.4 (UI can add-to-list, click Enrich, and poll status).
