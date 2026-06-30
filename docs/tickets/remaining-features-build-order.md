# Remaining Features — Build Order Tickets (ClickUp import)

> Copy-paste backlog for everything still **partial (🟡)** or **planned (🔴)** in the
> [feature guide](../skout-ai-feature-guide.md) §7 roadmap and the
> [enrichment implementation status](../data-enrichment-implementation-status.md).
> The shipped MVP (auth, search, activation, PAL enrichment, scoring, lists, smart lists,
> HubSpot, BYOK, credits/Razorpay, dashboard) is **not** re-ticketed here.
>
> Structure: **9 Epics** → **stories**. Each story has Description, Acceptance Criteria, Dependencies, Estimate, Labels.
> Estimates use story points (SP): 1≈½ day, 2≈1 day, 3≈2 days, 5≈3–4 days, 8≈1 week, 13≈2 weeks.

Suggested ClickUp setup:
- **Space:** Skout AI · **Folder:** Roadmap (Post-MVP)
- **Lists (= Epics):** R1–R9 below
- **Custom fields:** `Story Points` (number), `Area` (dropdown: outreach / ai / corpus / analytics / platform / extension), `Surface` (dropdown: backend / ai-service / frontend / infra / extension)
- **Tags:** see Labels per story
- **Priority hint:** follow the [suggested sequencing](#suggested-sequencing) at the bottom (mirrors feature-guide §7.6).

---

## R1 — Outreach: Sequences engine

> Feature guide §7.1. DB tables already exist (`sequences`, `sequence_steps`,
> `sequence_enrollments`, `sequence_enrollment_steps`); routes are stubs
> (`GET /sequences`, `POST /sequences/:id/enroll`). This epic turns the scaffold into a
> working multi-step cadence engine.

### R1.1 — Sequence CRUD + step builder API
**Description:** Full CRUD for `sequences` and `sequence_steps`: create/update/delete a sequence, add/reorder/remove steps (`stepType` = email/linkedin/wait/task), set `delayDays`, `subject`, `bodyTemplate`. Validate step ordering is contiguous.
**Acceptance Criteria:**
- [ ] `POST/PATCH/DELETE /sequences` and `/sequences/:id/steps` work and are workspace-scoped.
- [ ] Step reorder keeps `(sequenceId, stepOrder)` unique and contiguous.
- [ ] Body templates support merge tokens (`{{firstName}}`, `{{company}}`, …) validated against a known token list.
- [ ] Status lifecycle `draft → active → paused → archived` enforced.
**Dependencies:** none (schema exists)
**Estimate:** 5 · **Labels:** outreach, backend

### R1.2 — Enrollment + scheduler (delays & branching)
**Description:** Back `POST /sequences/:id/enroll` with real scheduling: create `sequence_enrollments` + materialize `sequence_enrollment_steps` with `scheduledAt` computed from `delayDays`. Worker advances enrollments and marks steps `executed`. Reference the Temporal-backed scheduling noted in code, or BullMQ delayed jobs as MVP.
**Acceptance Criteria:**
- [ ] Enrolling a prospect/list creates enrollment + per-step schedule.
- [ ] Scheduler executes due steps, honoring per-step delay and business-hours window.
- [ ] Branching: reply/bounce/meeting-booked transitions stop or fork the cadence.
- [ ] Idempotent + retryable; duplicate enroll on `(sequenceId, prospectId)` rejected.
**Dependencies:** R1.1, R3.x (sending domains/inboxes for actual send)
**Estimate:** 13 · **Labels:** outreach, backend

### R1.3 — Email send + tracking (open/click/reply hooks)
**Description:** Wire step execution to actual email send via a connected sending inbox (R3). Inject open/click tracking pixels + link rewrites; capture sends to `sequence_enrollment_steps.executedAt`.
**Acceptance Criteria:**
- [ ] Email steps send through the rotated sending inbox (R3.2).
- [ ] Open/click events recorded and attributed to enrollment + step.
- [ ] Unsubscribe link + suppression honored before every send.
**Dependencies:** R1.2, R3.2
**Estimate:** 8 · **Labels:** outreach, backend

### R1.4 — Sequences frontend (builder, enroll, analytics)
**Description:** UI to build cadences (drag-reorder steps), enroll lists/prospects, and view per-sequence analytics (sent/open/reply/meeting).
**Acceptance Criteria:**
- [ ] Visual step builder with delay + channel per step.
- [ ] Enroll from a list or prospect detail; see live enrollment status.
- [ ] Per-step funnel metrics displayed.
**Dependencies:** R1.1, R1.2, R1.3
**Estimate:** 8 · **Labels:** outreach, frontend

---

## R2 — Outreach: Unified inbox & reply tracking

> Feature guide §7.1. Stub today (`GET /inbox/threads` returns empty). Conversation state
> across sequences.

### R2.1 — Inbound email ingestion + thread model
**Description:** Ingest replies from connected inboxes (IMAP/Gmail/Outlook API or provider webhook), thread by message-id/references, link to the originating enrollment + prospect.
**Acceptance Criteria:**
- [ ] Replies create/append `inbox_threads` + `messages` linked to prospect + sequence.
- [ ] Bounces and auto-replies classified separately from human replies.
- [ ] A human reply pauses the prospect's active sequence (feeds R1.2 branching).
**Dependencies:** R3.1
**Estimate:** 8 · **Labels:** outreach, backend

### R2.2 — Conversation state machine
**Description:** Track thread state (`new → replied → bounced → meeting_booked → closed`) and surface unread counts per workspace.
**Acceptance Criteria:**
- [ ] State transitions recorded with timestamps; unread badge counts correct.
- [ ] Sentiment / intent tag on reply (optional, AI-assisted via R5).
**Dependencies:** R2.1
**Estimate:** 5 · **Labels:** outreach, backend

### R2.3 — Unified inbox UI
**Description:** Thread list + conversation view; reply inline; shows linked prospect, sequence, and score context.
**Acceptance Criteria:**
- [ ] `GET /inbox/threads` returns real threads with pagination + filters (unread, replied).
- [ ] Reply sends through the same inbox the thread is on.
- [ ] Prospect/sequence context panel beside the conversation.
**Dependencies:** R2.1, R2.2
**Estimate:** 8 · **Labels:** outreach, frontend

---

## R3 — Outreach: Deliverability (domains, inboxes, warmup)

> Feature guide §7.1. Stub today (`GET /inboxes`, `GET /domains` return empty).
> Sending infrastructure that R1/R2 depend on.

### R3.1 — Sending inbox connect (OAuth + SMTP/IMAP)
**Description:** Connect Google/Microsoft mailboxes via OAuth (and generic SMTP/IMAP); store encrypted tokens; per-inbox daily send caps.
**Acceptance Criteria:**
- [ ] `GET /inboxes` lists connected inboxes with health + daily cap usage.
- [ ] Tokens encrypted at rest (AES-256-GCM, same pattern as BYOK).
- [ ] Test-send verifies the inbox before activation.
**Dependencies:** none
**Estimate:** 8 · **Labels:** outreach, infra, backend

### R3.2 — Inbox rotation + send throttling
**Description:** Rotate sends across healthy inboxes, throttle per inbox/day, back off on bounce spikes.
**Acceptance Criteria:**
- [ ] Round-robin/weighted rotation respects per-inbox caps.
- [ ] Auto-pause an inbox when bounce/spam rate exceeds threshold.
**Dependencies:** R3.1
**Estimate:** 5 · **Labels:** outreach, backend

### R3.3 — Domain warmup + monitoring
**Description:** Sending-domain registration (`GET /domains`), SPF/DKIM/DMARC checks, gradual warmup ramp, bounce/spam/blacklist monitoring.
**Acceptance Criteria:**
- [ ] `GET /domains` returns domains with DNS-record health (SPF/DKIM/DMARC pass/fail).
- [ ] Warmup ramps daily volume on a schedule; surfaced in UI.
- [ ] Blacklist/spam-rate alerts raised per domain.
**Dependencies:** R3.1
**Estimate:** 8 · **Labels:** outreach, infra, backend

### R3.4 — Deliverability frontend
**Description:** UI to connect inboxes, view domain DNS health, and monitor warmup + bounce metrics.
**Acceptance Criteria:**
- [ ] Connect-inbox flow + per-inbox health cards.
- [ ] Domain DNS checklist with copy-paste records.
- [ ] Warmup + bounce/spam charts.
**Dependencies:** R3.1, R3.2, R3.3
**Estimate:** 5 · **Labels:** outreach, frontend

---

## R4 — Outreach: AI review queue (HITL)

> Feature guide §7.1 + §7.6 — smallest gap, drafts already persist via `personalize`.
> `GET /ai/drafts` exists; needs review workflow + status.

### R4.1 — Draft review status + actions
**Description:** Add review state to `ai_drafts` (`pending → approved → rejected → edited`); endpoints to approve/reject/edit a draft before it can be used in a sequence step.
**Acceptance Criteria:**
- [ ] `GET /ai/drafts` supports status filter + pagination (replace stub list).
- [ ] `POST /ai/drafts/:id/approve|reject` + `PATCH` for edits, audit-logged.
- [ ] Only `approved` drafts are sendable in R1.3.
**Dependencies:** none (drafts persist today)
**Estimate:** 3 · **Labels:** outreach, ai, backend

### R4.2 — AI review queue UI
**Description:** Reviewer screen: queued drafts with prospect context, inline edit, approve/reject, bulk approve.
**Acceptance Criteria:**
- [ ] Queue lists pending drafts with prospect + score context.
- [ ] Inline edit + approve/reject; bulk actions.
- [ ] Approved drafts flow into sequence enrollment.
**Dependencies:** R4.1
**Estimate:** 5 · **Labels:** outreach, frontend

---

## R5 — AI layer deepening

> Feature guide §7.2 + implementation-status §3.6/§9. Move from heuristic to LLM-first and
> close the auto re-score + corpus write-back gaps.

### R5.1 — LLM scoring as default (explainable)
**Description:** Make `POST /v1/score` LLM-first with heuristic only as fallback; return structured `reasoning` per dimension (industry/seniority/geo/size/intent).
**Acceptance Criteria:**
- [ ] LLM path is default when `OPENAI_API_KEY` set; heuristic fallback on error/timeout.
- [ ] `source = llm` with per-dimension explanation in response.
- [ ] Latency + cost budget respected (cache identical inputs).
**Dependencies:** none
**Estimate:** 8 · **Labels:** ai, ai-service

### R5.2 — Real intent classification model
**Description:** Replace hardcoded `/v1/classify` with a real intent model over signals + firmographics + job posts; typed intent (`buy/respond/need`) with rationale + HITL gating.
**Acceptance Criteria:**
- [ ] `/v1/classify` returns model-derived intent + confidence (not hardcoded).
- [ ] Intent feeds `intentScore` and outreach readiness.
- [ ] Low-confidence results flagged for human review.
**Dependencies:** R5.1, R6.2 (signals)
**Estimate:** 8 · **Labels:** ai, ai-service

### R5.3 — First-class pain-point surfacing
**Description:** Promote LLM pain-points from personalize-only to a stored, typed field surfaced on prospect detail.
**Acceptance Criteria:**
- [ ] Pain points constrained to a typed enum, stored on the prospect/activation.
- [ ] Shown on prospect detail with source rationale.
**Dependencies:** R5.1
**Estimate:** 5 · **Labels:** ai, backend

### R5.4 — Auto re-score on ICP change + corpus write-back
**Description:** When `workspace_icp` changes, enqueue a batch re-score of stored prospects; write `icp_score` back to the OpenSearch corpus doc as well as `prospect_scores`.
**Acceptance Criteria:**
- [ ] ICP `version` bump triggers a batch re-score job (BullMQ), credit-aware.
- [ ] Scores written back to OpenSearch and `prospect_scores`.
- [ ] Job progress pollable; toggle to disable auto re-score.
**Dependencies:** R5.1
**Estimate:** 8 · **Labels:** ai, backend

---

## R6 — Corpus pipeline maturation (Tier 1)

> Feature guide §7.3 + implementation-status §4/§7/P0–P1. Deploy what exists and broaden
> coverage + signal depth.

### R6.1 — Deploy scraper workers to ECS
**Description:** Deploy orchestrator/cleaner/ingestor as ECS services (ECR repos already exist). Wire env (Redis, OpenSearch, S3), health checks, autoscaling.
**Acceptance Criteria:**
- [ ] Three services deployed + healthy in `dev`; logs/metrics in CloudWatch.
- [ ] End-to-end job runs in the deployed environment (not just local).
**Dependencies:** none
**Estimate:** 8 · **Labels:** corpus, infra

### R6.2 — Orchestrator hardening (rate limit, retry, DLQ)
**Description:** Add Redis token-bucket rate limiting, exponential backoff, and a dead-letter queue to the orchestrator.
**Acceptance Criteria:**
- [ ] Per-source rate limit configurable; 429s trigger circuit breaker.
- [ ] Failed jobs land in DLQ with reason; retryable.
**Dependencies:** R6.1
**Estimate:** 5 · **Labels:** corpus, backend

### R6.3 — Production `company-web` crawl + E2E smoke test
**Description:** Turn the Python `company-web` scaffold into a production crawler (Playwright + proxy + UA rotation); run a 100-company seed and verify searchable in OpenSearch.
**Acceptance Criteria:**
- [ ] Crawls domain → writes raw S3 records with about/team parse.
- [ ] 100-company seed completes; records queryable by name/domain/industry/location.
- [ ] Quarantine + manifest counts reconcile.
**Dependencies:** R6.1
**Estimate:** 8 · **Labels:** corpus, backend

### R6.4 — Broaden source coverage (LinkedIn, Crunchbase, job boards, Google Business)
**Description:** Add bots/adapters for additional sources with account pools + strict rate caps where required (LinkedIn people/company, Crunchbase funding, job boards, Google Business Profile).
**Acceptance Criteria:**
- [ ] Each source maps to `ProspectCandidate`/`CompanyCandidate` with provenance.
- [ ] LinkedIn bot enforces account pool + per-account hourly cap + 429 breaker.
**Dependencies:** R6.3
**Estimate:** 13 · **Labels:** corpus, backend

### R6.5 — Signal collectors (hiring / funding / leadership) + growth metrics
**Description:** Build collectors for `is_hiring`/`open_jobs`/`hiring_by_dept`, funding/investors/leadership-change events, and compute 3/6/12-mo growth from historical snapshots.
**Acceptance Criteria:**
- [ ] Hiring + funding + leadership signals populated and typed in `signals[]`/`buying_signals[]`.
- [ ] Growth metrics computed from stored history; provenance recorded.
**Dependencies:** R6.3
**Estimate:** 8 · **Labels:** corpus, backend

### R6.6 — Cleaner AI enrichment + full provenance
**Description:** AI industry/sub-industry classification in the cleaner, full Wappalyzer OSS rule set, and per-field source lineage populated end-to-end.
**Acceptance Criteria:**
- [ ] AI industry classification replaces static normalization.
- [ ] Full Wappalyzer ruleset (not the ~12-tool subset) detects tech stack.
- [ ] Per-field `provenance` populated through clean → ingest.
**Dependencies:** R6.3
**Estimate:** 8 · **Labels:** corpus, backend

---

## R7 — Analytics & data platform

> Feature guide §7.4. ClickHouse referenced but not wired; webhooks are a stub.

### R7.1 — ClickHouse analytics path
**Description:** Stream credit/enrichment/usage events to ClickHouse; move heavy analytics aggregates off Postgres.
**Acceptance Criteria:**
- [ ] Events ingested to ClickHouse (batch or stream); schema documented.
- [ ] `GET /analytics/report` reads from ClickHouse for heavy queries; Postgres fallback.
- [ ] Backfill job for existing `credit_transactions`/`enrichment_jobs`.
**Dependencies:** none
**Estimate:** 13 · **Labels:** analytics, infra

### R7.2 — Outbound event webhooks
**Description:** Implement the `/webhooks` stub: register endpoints, sign payloads (HMAC), deliver on events (enrichment completed, score ready, sequence reply) with retries.
**Acceptance Criteria:**
- [ ] CRUD for webhook endpoints + event subscriptions, workspace-scoped.
- [ ] Signed deliveries with retry + DLQ; delivery log viewable.
- [ ] At least 3 event types wired end-to-end.
**Dependencies:** none
**Estimate:** 5 · **Labels:** analytics, backend

---

## R8 — Platform / infrastructure

> Feature guide §7.5. Edge hardening, global billing, and full team management.

### R8.1 — CloudFront HTTPS edge
**Description:** Move the public edge from API Gateway-in-front-of-ALB to CloudFront once the AWS account is verified.
**Acceptance Criteria:**
- [ ] CloudFront distribution fronts the API with TLS + caching rules.
- [ ] HTTP→HTTPS redirect; ALB locked to CloudFront origin.
**Dependencies:** AWS account CloudFront verification
**Estimate:** 5 · **Labels:** platform, infra

### R8.2 — Stripe billing (global/USD)
**Description:** Add Stripe alongside Razorpay for global/USD customers; shared credit-pack catalog; webhook → credit grant.
**Acceptance Criteria:**
- [ ] `POST /billing/stripe/checkout` creates a session; webhook verifies signature and credits on success.
- [ ] Currency/region routing decides Stripe vs Razorpay.
- [ ] `payment_orders` + `credit_transactions` recorded identically to Razorpay path.
**Dependencies:** none
**Estimate:** 8 · **Labels:** platform, backend

### R8.3 — Multi-seat team management (invites + permissions)
**Description:** Full team UI on top of existing `owner/admin/member` roles: invite by email, accept flow, per-seat permissions, remove/suspend members.
**Acceptance Criteria:**
- [ ] Invite → email → accept provisions `workspace_members` with chosen role.
- [ ] Role gates enforced in API + reflected in UI (e.g. scrape admin = owner/admin).
- [ ] Remove/suspend member revokes access immediately.
**Dependencies:** none
**Estimate:** 8 · **Labels:** platform, backend, frontend

---

## R9 — Chrome extension (features + improvements)

> Manifest V3 extension (`apps/chrome-extension`, **v0.5.0 MVP**). Today it captures a
> **single** LinkedIn profile (`/in/username`) → activate / add-to-list / **email-only**
> enrich, with list caching and a Clerk auth bridge via the Skout web tab. This epic adds
> the missing capture surfaces, full enrichment parity, and ships it to the Web Store.

### R9.1 — Bulk capture from LinkedIn search / Sales Navigator
**Description:** Capture multiple profiles at once from LinkedIn search results and Sales Navigator lead/account lists (checkbox select + "Add all to list"), instead of one `/in/` profile at a time.
**Acceptance Criteria:**
- [ ] Detects results/Sales Nav pages and renders per-row select + select-all.
- [ ] Bulk activates + adds selected prospects to a chosen list in one action.
- [ ] Respects rate/pagination; shows progress + per-row success/failure.
- [ ] De-dupes against the target list (no duplicate members).
**Dependencies:** none
**Estimate:** 8 · **Labels:** extension, frontend

### R9.2 — Company page + post-author capture
**Description:** Extend capture beyond personal profiles to LinkedIn **company pages** (firmographics + domain) and **post/feed authors**, removing the "Not a LinkedIn profile" dead-end.
**Acceptance Criteria:**
- [ ] Company page capture maps name/domain/industry/size to a `CompanyCandidate`.
- [ ] Post/feed author capture resolves the author profile and captures it.
- [ ] Content-script matches updated in `manifest.json` for company + feed URLs.
**Dependencies:** none
**Estimate:** 5 · **Labels:** extension, frontend

### R9.3 — Full enrichment parity + inline results
**Description:** Today the panel only requests `fields: ["email"]`. Add company/phone/validation enrichment (full PAL waterfall) and surface returned email/phone/company + verification status inline in the side panel.
**Acceptance Criteria:**
- [ ] Field picker (company / email / validation / phone) mirrors the web app.
- [ ] Panel polls the enrichment job and renders results + per-step status inline.
- [ ] Phone gating + `402 insufficient_credits` surfaced with a top-up hint.
**Dependencies:** none (backend enrichment exists)
**Estimate:** 5 · **Labels:** extension, frontend

### R9.4 — Inline ICP score + fit badge
**Description:** Show the AI ICP score/band as a badge on the captured profile so reps can qualify without switching to the app; trigger "Score" from the panel.
**Acceptance Criteria:**
- [ ] Panel shows `icpScore` + band (strong/medium/weak) after scoring.
- [ ] "Score" action calls the scoring API; handles `ICP_NOT_CONFIGURED` with a setup link.
- [ ] Cached per prospect to avoid re-scoring on every open.
**Dependencies:** none (R5.1 improves quality)
**Estimate:** 3 · **Labels:** extension, frontend

### R9.5 — Enroll to sequence from the extension
**Description:** Let reps enroll a captured prospect (or bulk selection) into an outreach sequence directly from LinkedIn.
**Acceptance Criteria:**
- [ ] Panel lists active sequences; enroll single or bulk selection.
- [ ] Activation happens first if the prospect isn't yet activated.
- [ ] Confirmation + link back to the sequence in the web app.
**Dependencies:** R1.1, R1.2
**Estimate:** 3 · **Labels:** extension, outreach, frontend

### R9.6 — Build pipeline, bundling & tests
**Description:** Move from hand-loaded raw JS to a real build (bundler + env injection), share request/identity contracts with the backend, and add tests. Currently load-unpacked only, no build/CI, no tests.
**Acceptance Criteria:**
- [ ] Bundled build output (e.g. Vite/esbuild) with env-driven default URLs.
- [ ] Identity hashing + prospect field mapping shared with/validated against `@skout/shared` contracts.
- [ ] Unit tests for `api.js` mapping + auth flow; runs in CI.
**Dependencies:** none
**Estimate:** 5 · **Labels:** extension, infra

### R9.7 — Chrome Web Store packaging & release + manifest cleanup
**Description:** Package for the Chrome Web Store (listing, privacy disclosures, screenshots) and clean the manifest: remove the hardcoded dev ALB host, tighten broad `optional_host_permissions` (`http://*/*`), and add the production CloudFront origin (ties to R8.1).
**Acceptance Criteria:**
- [ ] Versioned zip + store listing assets; privacy/permissions justification drafted.
- [ ] Hardcoded `skoutdev-alb-*` host removed; host permissions scoped to prod origins.
- [ ] CloudFront origin added to `host_permissions` + `externally_connectable`.
- [ ] Auto-update channel verified post-publish.
**Dependencies:** R8.1 (CloudFront origin)
**Estimate:** 5 · **Labels:** extension, infra

### R9.8 — Auth & reliability hardening
**Description:** Harden the Skout-web auth bridge (token refresh, single 401-retry today), handle expired sessions gracefully, and improve first-run onboarding (guided connect, clearer error states).
**Acceptance Criteria:**
- [ ] Silent token refresh before expiry; no dead buttons after session lapse.
- [ ] Clear, actionable states for not-signed-in / host-permission-denied / API-unreachable.
- [ ] Guided first-run: connect account → refresh lists → capture, with empty/error states.
**Dependencies:** none
**Estimate:** 3 · **Labels:** extension, frontend

---

## Suggested sequencing

Mirrors feature-guide §7.6 (highest leverage first):

1. **R4** — AI review queue (smallest gap; unlocks the outreach story).
2. **R3 → R1 → R2** — deliverability, then sequences, then unified inbox (the big outreach surface).
3. **R5** — LLM scoring by default + auto re-score (strengthens the core differentiator).
4. **R6** — scraper ECS deploy + source/signal coverage (grows the corpus moat).
5. **R7 + R8** — ClickHouse, webhooks, Stripe, CloudFront, multi-seat (scale/ops hardening).

**R9 (Chrome extension)** runs largely in parallel — it's a separate surface with few backend
deps. Quick wins (R9.1 bulk capture, R9.3 full enrichment, R9.4 inline score) can ship now;
R9.5 waits on sequences (R1), and R9.7 store release pairs with CloudFront (R8.1).

**Critical path to the outreach product:** R3.1 → R3.2 → R1.1 → R1.2 → R1.3 → R2.1 → R2.3.
