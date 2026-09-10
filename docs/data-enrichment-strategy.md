# Skout AI — Data Enrichment Strategy

> How Skout AI turns raw scraped records and provider APIs into a **qualified, AI-scored prospect corpus** — covering every Company, Contact, Enrichment, and AI filter exposed in the product.

This document is the bridge between three existing pieces:

- **[Scraping platform architecture](./scraping-platform-architecture.md)** — *how* we bulk-collect raw data (orchestrator → bots → cleaner → ingestor → OpenSearch).
- **[Provider Abstraction Layer](../packages/pal/README.md)** — *how* we enrich a single record on demand (Apollo → Hunter → … waterfall).
- **[Database schema](./database-schema.md)** — *where* corpus vs. activated records live (OpenSearch vs. PostgreSQL).

It adds the **enrichment strategy**: which data points we collect, which tools/providers feed each one, what they cost, and the **build-cheap-then-enrich-on-demand** economic model that is Skout AI's moat.

Visual: **[Data enrichment flow diagram](./diagrams/skout-ai-data-enrichment-flow.mmd)**.

---

## 1. Core principle — the moat is the intelligence layer, not the data

```
Company Data  +  People Data  +  Signals  +  AI Models  ──►  Qualified Opportunities
```

Company records are a commodity. The value customers pay for is **ICP matching, buying-intent detection, growth signals, AI qualification, lead prioritization, and personalized outreach**. So our strategy is:

1. **Build a cheap, broad corpus ourselves** (free + scraped sources) — never pay per-record to *store* the world.
2. **Spend money only on activation** — verify emails and fetch phones **on demand**, gated by lead score.
3. **Differentiate with the AI layer** — ICP score, intent, pain-point detection, outreach readiness.

> Rule of thumb: **free/scraped data fills the corpus; paid APIs are a fallback triggered by user intent or a high lead score.**

---

## 2. Four-stage enrichment lifecycle

Every prospect flows through the same four stages, regardless of source. Stages 1–2 are **bulk and cheap**; stages 3–4 are **on-demand and paid**.

| Stage | What happens | Cost model | Where it runs |
|-------|--------------|-----------|---------------|
| **1. Collect** | Pull company + people records from free/scraped sources into the raw S3 zone | ~Free (infra only) | Scraper bots (Python ECS) |
| **2. Resolve & enrich (bulk)** | Domain discovery, industry classification, headcount estimate, tech stack, hiring + funding signals; normalize → `prospect_id` | ~Free (free APIs + scraping) | Cleaner + ingestor (Node ECS) |
| **3. Activate (on-demand)** | User adds to list / clicks Enrich → verify email, fetch phone, refresh stale firmographics via **PAL waterfall** | **Paid per outcome** | PAL adapters (BullMQ workers) |
| **4. Qualify (AI)** | ICP match score, intent score, pain-point detection, outreach readiness | LLM tokens | `apps/ai` (FastAPI) |

This maps directly onto the existing **corpus-build vs. enrichment-fallback** split in [scraping-platform-architecture.md §Two operating modes](./scraping-platform-architecture.md).

---

## 3. What we collect — filter → data point → source map

The product exposes four filter groups. Each filter must be backed by a concrete field and a source. The tables below are the **canonical mapping** the cleaner/ingestor must populate.

### 3.1 Company filters

| Filter | Field | Primary source (free/scraped) | Paid fallback |
|--------|-------|-------------------------------|---------------|
| Company name, website, description, keywords | `company_name`, `domain`, `description`, `keywords[]` | Company website, LinkedIn company page, OpenCorporates | PDL / Coresignal / Explorium |
| Industry, sub-industry | `industry`, `sub_industry` | Website + LinkedIn → AI classification | PDL / Explorium firmographics |
| HQ location (country, state, city, timezone) | `hq_country`, `hq_state`, `hq_city`, `timezone` | OpenCorporates, Google Business Profile, website | PDL / Coresignal |
| Company size / employee count buckets | `employee_count`, `employee_bucket` (1‑10 … 1000+) | LinkedIn company page, headcount estimate | Coresignal headcount, PDL |
| Annual revenue / revenue range | `annual_revenue`, `revenue_range` | SEC EDGAR (public cos), estimate model | Explorium / PDL financials |
| Employee / hiring / funding growth (3/6/12 mo) | `employee_growth_*`, `hiring_growth`, `funding_growth` | Coresignal historical headcount, job-board deltas | Coresignal Premium (historical headcount API) |
| Company stage (bootstrapped → public) | `company_stage` | Crunchbase, funding signals, SEC EDGAR | Crunchbase API |
| Funding data (total raised, last round/date, investors, # rounds) | `funding_*`, `investors[]` | Crunchbase (public pages), SEC EDGAR | Crunchbase API, Explorium events |

### 3.2 Technology filters (technographics)

| Filter | Field | Primary source | Paid fallback |
|--------|-------|----------------|---------------|
| CRM, marketing automation, CMS, analytics, payments, cloud provider, tech keywords | `tech_stack[]` (categorized) | **Wappalyzer** (self-host detection or API), website crawl | Wappalyzer Business API, Coresignal technographics |

> Self-hosting Wappalyzer's open-source detection rules against our own crawl keeps technographics in the **free** tier. The paid Wappalyzer API (Business $450/mo, 20k credits) is the fallback when we need depth/freshness without crawling.

### 3.3 Hiring & intent signals

| Filter | Field | Primary source | Paid fallback |
|--------|-------|----------------|---------------|
| Currently hiring, hiring volume, open job count, department hiring | `is_hiring`, `open_jobs`, `hiring_by_dept{}` | LinkedIn Jobs, company careers pages, job boards | Coresignal jobs dataset, PDL job postings |
| Intent signals (recent funding, leadership change, product launch, expansion, job-posting keywords, website changes) | `signals[]` (typed events) | Scraped deltas + Crunchbase + news | Explorium Event API, Bombora-style intent |

### 3.4 Contact filters

| Filter | Field | Primary source | Paid fallback |
|--------|-------|----------------|---------------|
| Full name, job title, department, seniority, job function | `full_name`, `title`, `department`, `seniority`, `job_function` | LinkedIn profiles, company team pages | PDL / Coresignal person data |
| Email/phone/LinkedIn availability flags | `has_email`, `has_phone`, `has_linkedin` | Derived after enrichment | — |
| Experience (years at company, years in role, previous company) | `tenure_company`, `tenure_role`, `prev_company` | LinkedIn profile parse | PDL person, Coresignal employee |
| Contact activity signals (promoted, changed jobs, posted on LinkedIn, active on social) | `contact_signals[]` | LinkedIn deltas, social scrape | Coresignal employee webhooks |

### 3.5 Enrichment filters

| Filter | Field | Primary source | Paid fallback |
|--------|-------|----------------|---------------|
| Work email verified, catch-all, risky, deliverability score | `email_status`, `is_catch_all`, `is_risky`, `deliverability_score` | Pattern-generate then **verify** | NeverBounce / ZeroBounce / MillionVerifier / Hunter |
| Phone: direct dial, mobile, HQ | `phone_direct`, `phone_mobile`, `phone_hq` | — (rarely free) | Datagma / Kaspr / Lusha / Cognism |
| Social profiles (LinkedIn, X, GitHub, personal site) | `social[]` | Scrape + website | PDL person enrich |
| Buying signals (funding/hiring in last X months, tech adoption, leadership change, new office, acquisitions) | `buying_signals[]` | Signal collection (stage 2) | Explorium events |

### 3.6 AI-powered filters (the differentiator)

| Filter | Field | How produced |
|--------|-------|--------------|
| AI ICP match score (0–100, strong/medium/weak) | `icp_score`, `icp_band` | `apps/ai` scores corpus record against `workspace_icp` |
| AI intent score (likelihood to buy/respond/need solution) | `intent_score` | LLM over signals + firmographics |
| AI pain-point detection (scaling sales, lead-gen issues, recruiting, churn, RevOps complexity) | `pain_points[]` | LLM over job posts, signals, description |
| AI outreach readiness (ready / warm / nurture / not qualified) | `outreach_readiness` | Composite of ICP + intent + signals |
| Saved smart lists (dynamic queries) | OpenSearch saved query | Stored filter set re-run on corpus |

> AI fields are computed in `apps/ai` (FastAPI) and written back to the OpenSearch document; `prospect_scores` in PostgreSQL holds the per-workspace activated copy. See [data-flow diagram](./diagrams/skout-ai-data-flow.mmd).

---

## 4. Build-your-own corpus (Steps 1–4)

Instead of buying expensive datasets up front, build proprietary company intelligence:

```
Step 1 — Collect company records      Step 2 — Discover & enrich
  OpenCorporates, SEC EDGAR,            domain discovery, industry classification,
  registry APIs, company websites,      employee estimation, tech-stack detection,
  LinkedIn company pages          ──►   hiring + funding signal collection
            │                                       │
            ▼                                       ▼
Step 4 — Store in Skout corpus  ◄──  Step 3 — AI intelligence layer
  OpenSearch (global, deduped),         ICP scores, intent signals,
  prospect_id / company_id (ADR 0001)   lead qualification, prioritization
```

Each company profile we persist (`company_id`):

`company_name · domain · industry · location · employee_range · company_type · founded_date · public/private · tech_stack · growth_signals · hiring_signals · funding_signals · ai_qualification_score`

This is exactly the **clean → ingest → OpenSearch** path already defined in the scraping platform; this doc just names the **sources per field**.

---

## 5. Email discovery strategy

Email is generated, then **verified** — we only ever store verified addresses.

**Phase 1 — generate patterns** (free, deterministic) for `John Smith @ acme.com`:

```
john@acme.com · john.smith@acme.com · jsmith@acme.com · j.smith@acme.com · johns@acme.com
```

**Phase 2 — verify** (paid, on demand) and store only `valid`:

```
generated candidates ──► verification API ──► valid? ──► store (else discard)
```

| Provider | Best for | API cost (bulk) | Notes |
|----------|----------|-----------------|-------|
| **MillionVerifier** | Cheapest high-volume bulk pass | ~$0.0003–$0.004/email; credits never expire | Lowest cost; slightly lower accuracy (~96%) — good first pass |
| **NeverBounce** | Real-time + CRM integrations | ~$0.008 → $0.0015/email at volume; expire 12 mo | Fast, simple, high accuracy |
| **ZeroBounce** | Deliverability-sensitive, enrichment, spam-trap/catch-all | ~$0.008/email; non-expiring | AI scoring + data append; best accuracy band |
| **Hunter.io** | Find *and* verify in one prospecting flow | Subscription (Starter $34 → Business $349/mo) | Also does email *finding* (pattern + sources), not just verification |

**Recommended:** MillionVerifier for the cheap bulk first pass, **ZeroBounce or NeverBounce** as the accuracy gate before any address is marked verified / used for sending. Hunter.io's *finder* is a useful discovery source feeding Phase 1.

---

## 6. Phone strategy — on-demand only (recommended)

Phone data is the most expensive and perishable dataset. **Do not** bulk-buy it.

```
lead generated ──► lead score > 80 ──► request phone enrichment ──► store result
```

| Provider | Mobile cost | API access | GDPR / region notes |
|----------|-------------|-----------|---------------------|
| **Datagma** | ~$0.33–$0.49/number | **Included in all paid plans** ($39–$209/mo annual) | API-first, best cost; smaller DB (~7M/day found) |
| **Kaspr** | ~$0.05–$0.45/number | Add-on ~$6k/yr | Large EU DB (90M+); cheap per-number but pricey API |
| **Lusha** | ~$1.10–$1.23/number | Add-on ~$7k/yr | ISO 27701; highest stated accuracy; no volume discount |
| **Cognism** | Custom (Diamond verified) | Data-as-a-Service (needs seat) | Strongest EMEA + phone-verified; enterprise pricing ($8–15k+/yr) |

**Recommended:** **Datagma** as the default on-demand phone provider (API on every plan, best unit economics). Add **Cognism** later for phone-verified EMEA coverage when enterprise demand justifies it. Gate every call behind `lead_score > 80` to control spend.

---

## 7. Provider catalog — company & signal data

### 7.1 Foundational / free-tier sources (corpus backbone)

| Source | Purpose | Access | Cost | Use in Skout |
|--------|---------|--------|------|--------------|
| **OpenCorporates** | Company registrations, legal entity, jurisdictions | API (key) | Self-serve £2,250–£12,000/yr (500–5,000 calls/mo); free for public-benefit only — **commercial = paid** | Seed company identity (legal name, jurisdiction, status) |
| **SEC EDGAR** | Public-company filings, financials, funding | Free full-text search + JSON | **Free** | Revenue/financials for public cos, funding events |
| **LinkedIn company/profile pages** | Headcount, hiring, people, firmographics | Scrape (authenticated, rate-limited) | Infra only | Primary people + company signal source (see compliance §10) |
| **Company websites** | Description, team, contact, tech | Crawl | Infra only | Description, keywords, team pages, tech detection input |
| **Google Business Profile / Places** | Local business info, locations, phone | Places API (per-request SKUs) | Usage-based per call | Local/SMB firmographics, HQ verification |
| **Job boards / LinkedIn Jobs** | Hiring signals, growth indicators | Scrape | Infra only | `is_hiring`, open jobs, dept hiring, intent |
| **Crunchbase** | Funding events, stage, investors | API (paid) or public pages | No free tier; Pro $49–99/mo, API custom | Funding signals, company stage |
| **Wappalyzer** | Website technology stack | Self-host rules / API | OSS rules free; API Business $450/mo | Technographics |
| **Similarweb** | Website traffic / audience | API (enterprise quote) | Custom (Starter ~$149/mo, API extra) | Traffic-based sizing/intent (optional, later) |

### 7.2 Paid aggregators (enrichment fallback)

Use these **only** when free/scraped data is missing or stale (PAL waterfall fallback), not for bulk corpus build.

| Provider | Coverage | API | Pricing (2026) | Where it fits |
|----------|----------|-----|----------------|---------------|
| **Explorium** | 150M+ companies; 50+ sources behind one API + MCP; 4,000+ data points; 18 event categories | Match → Enrich → Event → Fetch/Discover | Usage credits, no subscription; Free 100; $200/5k; $1,500/50k; $0.015/credit at scale | Best **aggregator + events** fallback; firmographics, technographics, intent, funding |
| **People Data Labs (PDL)** | 1.5–3B persons, 100M+ companies | Person/Company Enrich, Search, Bulk (100/req) | Free 100/mo; company ~$0.05–$0.10/profile; person ~$0.20–$0.28 | Person + company enrich fallback; raw API, dev-friendly |
| **Coresignal** | 75–90M companies, 650–880M employees, jobs | Search + Collect credits, Elasticsearch DSL, webhooks | Free trial; $49 → $800 → $1,500/mo; datasets from $1,000 | **Historical headcount + jobs** (growth/hiring signals), bulk datasets |
| **RevenueBase** | 390M+ contacts, 60M+ companies | Email verify, Search (semantic), Enrich, Company match, MCP | **Per-outcome**; free 500 credits + masked feeds; free tier 1,000 calls/mo | Cheap entry; semantic discovery + per-outcome enrich + email verify |
| **Demandbase** | ABM accounts + intent | Platform/API (enterprise) | Custom, ~$18k–$300k+/yr | Enterprise ABM intent (later, if upmarket) |

> **Decision:** Start with **RevenueBase** (generous free/per-outcome) + **PDL** (cheap company enrich) as PAL fallbacks. Add **Explorium** when we need multi-signal events at scale, and **Coresignal** specifically for historical-headcount growth signals. Treat OpenCorporates/Crunchbase/Wappalyzer as paid only where their unique data is required.

---

## 8. The two-tier cost model (how it all combines)

```
                    ┌──────────────────────────── TIER 1: CORPUS (cheap, bulk) ───────────────────────────┐
  Free + scraped ──►│ scrape → clean → dedupe (prospect_id) → AI score → OpenSearch global index          │
  sources           │ cost: infra only. Fills 3.1–3.6 with best-effort free data + AI fields.              │
                    └──────────────────────────────────────────────────────────────────────────────────────┘
                                   │  user searches / filters / saves smart list
                                   ▼
                    ┌──────────── TIER 2: ACTIVATION (paid, per-outcome, gated) ───────────────────────────┐
  User intent  ───► │ add to list / Enrich  →  PAL waterfall:                                               │
  or score>80       │   internal_graph → RevenueBase/PDL (firmographics) → Hunter (find email)             │
                    │                    → MillionVerifier→ZeroBounce (verify) → Datagma (phone, score>80)  │
                    │ writes prospect_activations + enrichment_results in PostgreSQL                        │
                    └──────────────────────────────────────────────────────────────────────────────────────┘
```

- **Tier 1** never pays per record — it is the [scraping platform](./scraping-platform-architecture.md) writing to OpenSearch.
- **Tier 2** is the [PAL](../packages/pal/README.md) waterfall, paying **per successful outcome** only, gated by user action or lead score. This is the cost-control mechanism that makes the unit economics work.

---

## 9. AI intelligence layer (`apps/ai`)

Runs over the corpus and over activated records:

1. **ICP match** — compare record to `workspace_icp` → `icp_score` (0–100) + band.
2. **Intent** — LLM over `signals[]` + firmographics → likelihood to buy / respond / need solution.
3. **Pain-point detection** — LLM over job posts, description, signals → typed `pain_points[]`.
4. **Outreach readiness** — composite → `ready / warm / nurture / not_qualified`.
5. **Personalization** — conversation starters + outreach recommendations (feeds `ai_drafts`).

Output: *"Give me qualified leads and help me start conversations faster."* — the product Skout AI optimizes for.

---

## 10. Compliance & safety

- **ToS / robots:** Each bot documents allowed use. LinkedIn scraping uses authenticated, approved accounts only, hard rate caps, residential proxy egress (see [scraping-platform-architecture.md §Compliance](./scraping-platform-architecture.md)).
- **GDPR/CCPA:** For EU/UK contacts, document lawful basis (legitimate interest) and provide Article 14 notice on first contact. Prefer providers with DPAs + opt-out (Cognism, Lusha ISO 27701). Keep provider provenance per field for audit (OpenCorporates-style sourcing).
- **Verified-only emails:** Never store/send unverified addresses (§5).
- **PII at rest:** Raw HTML/JSON encrypted in S3 (SSE), lifecycle to Glacier/delete; secrets never in job payloads or logs.
- **Per-field source lineage:** Store which source produced each value (for compliance + freshness/conflict resolution).

---

## 11. Market & regional rollout

| Phase | Effort | Markets | Recommended sources |
|-------|--------|---------|---------------------|
| **1 — North America** | 80% | US, Canada | OpenCorporates, SEC EDGAR, registry lookup, LinkedIn, websites (mostly free) |
| **2 — High-value intl** | 15% | UK, Australia, India | OpenCorporates + RevenueBase/PDL fallback |
| **3 — Emerging** | 5% | Brazil, Mexico | OpenCorporates + regional registries |

Phase scraping bot coverage and provider contracts to match this — don't pay for global coverage before NA corpus is solid.

---

## 12. Build order (roadmap)

Aligned with [scraping-platform-architecture.md §Build order](./scraping-platform-architecture.md) and PAL MVP:

1. **Corpus seed** — `company-web` + OpenCorporates/SEC ingest → OpenSearch; populate §3.1 fields.
2. **Technographics** — self-host Wappalyzer rules in cleaner; fill `tech_stack[]`.
3. **People + email finding** — LinkedIn/team-page bot + Hunter finder → pattern generation (§5 Phase 1).
4. **Email verification gate** — MillionVerifier + ZeroBounce/NeverBounce in PAL `validate()` (§5 Phase 2).
5. **Signals** — jobs + funding + leadership-change collectors → `signals[]`, `buying_signals[]`.
6. **AI layer** — ICP / intent / pain-point / readiness in `apps/ai` (§9).
7. **On-demand phone** — Datagma adapter in PAL, gated by `lead_score > 80` (§6).
8. **Paid aggregator fallbacks** — RevenueBase + PDL adapters in PAL waterfall; Explorium/Coresignal as needed.

---

## Related docs

- [Scraping platform architecture](./scraping-platform-architecture.md) — collection pipeline
- [Provider Abstraction Layer](../packages/pal/README.md) — on-demand enrichment waterfall
- [Scraper contracts](../packages/scraper-contracts/README.md) — shared schemas
- [Database schema](./database-schema.md) — corpus (OpenSearch) vs. activation (PostgreSQL)
- [ADR 0001 — canonical prospect ID](./adr/0001-canonical-prospect-id.md)
- Diagrams: [data enrichment flow](./diagrams/skout-ai-data-enrichment-flow.mmd) · [scraping platform](./diagrams/skout-ai-scraping-platform.mmd) · [data flow](./diagrams/skout-ai-data-flow.mmd)
