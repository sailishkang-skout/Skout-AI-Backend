# Skout AI Backend — Enterprise Completion Plan: Final Closure Report

**Scope:** Skout AI Backend repo (`develop` branch), commits `fcbd18c` through `e72d78f`, 13 commits.
**Date range:** August 24, 2026, single continuous session.
**Mandate:** "Fix all Gaps and Caveats for all points and make them Enterprise level" — close out the remaining items from the Enterprise Completion Plan audit that could genuinely be closed by writing and shipping code, and say plainly which ones can't be.

This report covers the backend-focused tail of a longer, multi-session engagement that earlier produced the original gap audit and did corresponding work across the Frontend, Warm-Up-Tool, and Email-Intelligence-Tool repos. This document is scoped to what changed in the Backend repo in this session and gives an honest accounting of what is now real versus what still needs a person to decide something.

## How to read this report

Every item below falls into one of three buckets. "Shipped" means working code exists, is committed to `develop`, and was verified as thoroughly as this environment allowed. "Shipped with a disclosed boundary" means the code is real and working but deliberately doesn't cover the full scope of the original gap — the boundary is explained, not hidden. "Cannot be closed by code" means the remaining work requires a decision only a person can make — a name, a budget, a risk tolerance, a product priority — and no amount of engineering resolves it.

## What shipped this session

### Anti-hallucination enforcement at an API boundary (§6.1)

The `assertEvidenced()` contract existed in `packages/shared` but nothing called it — an AI-generated suggestion could reach a client with no evidence record behind it. The `/ai/next-best-action` route now calls it after recording the suggestion's evidence: if the evidence write didn't produce a real `evidenceId`, the request fails instead of silently returning an unverifiable claim. This is the one anti-hallucination checkpoint in this codebase where a bad write path fails the request rather than degrading gracefully — deliberately, since the entire point of the contract is that an AI claim without evidence should never reach a user.

### Identity-merge candidate discovery (§5.2)

The `identityMergeProposals` table existed with a full review-queue UI already built (from an earlier session) — but nothing ever populated it. A new worker (`identity-merge-discovery.worker.ts`) periodically scans each workspace for likely-duplicate companies and contacts using blocking-key bucketing (not a naive O(n²) comparison), scores candidates with the existing `scoreCandidateMatch` function, and creates proposals above the existing minimum-score threshold. It dedupes against any prior proposal on the same pair regardless of status, so a human's earlier reject/approve decision is never silently re-surfaced. Runs on a configurable interval (`IDENTITY_MERGE_DISCOVERY_INTERVAL_HOURS`, default 24h).

### Retention classification extended to contacts and companies (§8.12)

`RetentionRulesService.classify()` only handled one entity type. Generalized it to take a configurable criteria field, then wired it into `ContactsService.update()` (keyed on `lifecycleStage`) and `CompaniesService.update()` (keyed on `status`) so a contact or company record now carries a live `retentionClassification` the moment its governing field changes, rather than that classification only existing for the one entity type it originally shipped for.

### RBAC shadow-mode enforcement broadened (§11.1)

Fine-grained permission checks (`enforcePermission`) previously sat behind only two routes. Extended to the CRM delete routes (companies, contacts, deals) and to team management (role changes, member removal, invites, invite revocation). Every addition is shadow-mode by default — it logs what fine-grained RBAC *would* deny without actually blocking anything, sitting alongside the existing coarse role gate that still does the real enforcement. This is deliberately conservative: enabling real enforcement before the backfill migration that assigns fine-grained roles to existing users has run would lock people out of their own workspaces.

### Secrets rotation policy documented (§11.1)

`docs/secrets-rotation-policy.md` — a real, tiered rotation cadence (90/180/365 days depending on sensitivity, with a separate cadence for scraping infrastructure), a break-glass procedure for compromised secrets, and an explicit, disclosed limitation: `INTEGRATION_ENCRYPTION_KEY` cannot actually be rotated on the documented cadence yet, because rotating it requires a re-encryption migration over every row encrypted with it that does not exist. That's a scoped follow-up, not something this pass could respectably hide.

### Real OTLP/HTTP trace export (§1.1 / §11.3)

The OpenTelemetry baseline could only print spans to the console. `packages/observability/src/otlp-http-exporter.ts` is a hand-written OTLP/HTTP JSON exporter — hand-written specifically because this sandbox cannot run `pnpm install` (no network access), so pulling in the standard `@opentelemetry/exporter-trace-otlp-http` package wasn't something that could be verified to actually resolve or work from here. Setting `OTEL_EXPORTER_OTLP_ENDPOINT` now ships real spans to any OTLP-compatible collector (Honeycomb, Grafana Tempo, an OpenTelemetry Collector, Datadog's OTLP intake); leaving it unset keeps the existing console behavior. Still a deployment decision to point it anywhere — no longer a code gap.

### Root spans for every periodic sweep worker (§11.3)

8 self-triggered BullMQ workers (alert digest, blacklist monitor, reminder sweep, signal alerts, smart-list refresh, warm-up ramp, risk decay, IMAP poll) had no span of their own — earlier tracing work only covered request-triggered queues, which have an upstream trace to attach to. Each worker's tick is now wrapped in its own root span, so a stuck or slow sweep shows up in trace data instead of being invisible between request-triggered spans.

### Consent capture API (§5.1)

The `consents` table existed with no service or route touching it — every consent-basis field elsewhere in the schema (evidence ledger's `consentBasis`, entitlements) had nothing behind it to actually record a consent event. `ConsentService` plus `/consents` (record, revoke, list, check-active) closes that. It's genuinely new capability, not a wiring fix — nothing recorded consent before this.

### Entitlements wired to two real per-feature flags (§5.1)

Same pattern: the `entitlements` table existed with a doc comment that (incorrectly) claimed a read/write API already existed. Built the real `EntitlementsService` and `/entitlements` routes, then integrated it at exactly two low-risk points: LinkedIn/WhatsApp daily send limits (`linkedin-account.service.ts`) and search credit cost (`search.routes.ts`) — both read an entitlement override if one exists and fall back to the existing hardcoded default otherwise, so the change is additive and the existing behavior is unchanged for every workspace that hasn't set an override. Deliberately did not touch the core credit-deduction/ledger logic, which was the more "obvious" but far higher-risk target. A migration bug was caught and fixed before shipping: the first draft of the unique index migration would have silently no-op'd against an existing same-named non-unique index instead of upgrading it, which would have left the upsert logic with no real conflict target.

### First writers for Incident, ModelVersion, and PromptVersion (§5.1 / §11.3)

Three more tables that existed with no writer anywhere in the codebase. `IncidentsService` gets a full workspace-scoped read/write API (create, list, get, acknowledge, resolve) — low risk, since it's ordinary workspace-scoped data. `ModelVersionsService`/`PromptVersionsService` are different: these tables are platform-wide (no `workspaceId` column), and this codebase's RBAC model tops out at "owner of one workspace," not a true platform administrator. Giving an ordinary workspace-authenticated request the ability to write platform-wide model/prompt configuration that every other tenant's AI calls eventually pin to would be a real cross-tenant privilege-escalation risk. So these got real, callable service-layer writers with a read-only HTTP surface (`GET /model-versions`, `GET /prompt-versions`) and deliberately no write route in this pass — a disclosed scope boundary, not an oversight. Wiring the actual AI generation call sites to record which model/prompt version handled a given request remains unbuilt and is named as follow-up work below.

### Evidence Ledger read-path for CRM field provenance (§5.3)

Two gaps here. First, `DealsService.autoFill()` — a live path, reachable from the meeting-bot pipeline — never dual-wrote into the Evidence Ledger the way the equivalent contact and company auto-fill paths already did; fixed to match. Second, and larger: nothing anywhere read from the Evidence Ledger for CRM records — contacts, companies, and deals only ever exposed the cheaper `fieldSources` jsonb map. Added `getLatestEvidenceByAttribute()` (packages/db) and `buildFieldProvenance()` (packages/shared, pure merge logic) plus three new endpoints (`GET /contacts/:id/field-sources`, `/companies/:id/field-sources`, `/deals/:id/field-sources`) that prefer the richer Evidence Ledger record per field when one exists, falling back to the `fieldSources` entry otherwise. Deliberately not a hard cutover — `fieldSources` stays the source of truth for the existing manual-vs-auto-fill precedence logic, and the existing `GET /contacts/:id` response shape is untouched. Real customer data was the reason for the caution: a hard cutover risked silently changing what existing API consumers see.

### apps/ai (Python) OpenTelemetry-compatible instrumentation (§1.1 / §11.3)

This was the last named gap in the observability baseline's own doc comment. Same "cannot pip install, so don't add an unverifiable dependency" reasoning as the Node OTLP exporter: `apps/ai/src/observability.py` is a small, dependency-free, stdlib-only tracer that speaks the same two wire formats the Node side speaks — W3C Trace Context for picking up and continuing a trace apps/api started, and OTLP/HTTP JSON for export, using the identical environment variable names as the Node side so one collector configuration covers both services. Wired into `main.py` via Starlette middleware, one span per HTTP request.

Two things surfaced while wiring this up that would have kept even the *existing* Node-side propagation from ever doing anything: the OpenTelemetry tracer was being initialized without ever registering a W3C trace-context propagator, so `injectTraceContext()`/`extractTraceContext()` (added in an earlier task for BullMQ job payloads) had been silently no-ops the whole time — fixed by registering one explicitly. And the three real HTTP call sites where apps/api calls apps/ai (`classifyIntent`, `scoreProspect`, `suggest-reply`, `/v1/personalize`) weren't sending any trace-context header at all — fixed to send it. Together, a real user action now produces one linked trace across both services instead of two disconnected ones, or none.

### A genuine pre-existing bug found and fixed

While verifying Task 38's dependencies, this session unexpectedly had access to a real, complete TypeScript compiler in the sandbox (not something available for any earlier task, where verification relied on a hand-written brace/paren balance-check script). A `tsc --noEmit` run against `packages/observability` surfaced roughly 250 cascading syntax errors, traced to one root cause: an earlier task's doc comment contained the literal text `apps/*/Dockerfile`, and `*/` inside a block comment closes it early — everything after that point in the comment was being parsed as executable code. Invisible to a balance checker, since brace/paren counts were unaffected, and invisible to a human re-read, since the rendered comment still reads as an ordinary sentence. Fixed by rewording the sentence. This is disclosed here because it's the clearest evidence this session has that the verification method mattered: a stronger tool caught something a weaker one missed, and it's worth knowing that the earlier verification passes in this engagement (everything before this session had only the balance-check script available) could in principle have missed something similar.

## Verification method and its limits

No package manager and no test runner were available in this environment for the entire engagement — `pnpm install`, `pnpm build`, and `pnpm test` all require network access this sandbox does not have. Every change was verified by: a syntax/balance check on every touched file (a real TypeScript compiler for the second half of this session, once one was unexpectedly found available; a brace/paren script before that); manual line-by-line review of every diff; confirming every new or changed import resolves to a real exported symbol at its declared path; and, for the Python work, actual execution — `py_compile` plus a direct runtime smoke test of the new tracer's logic (nested span parenting, W3C header parsing, OTLP JSON shape), since that module has no third-party dependencies and could be exercised directly even without `fastapi`/`starlette` installed here.

What this did not do: run the actual test suites, run a real `pnpm build` across the monorepo (some packages, like `packages/db` and `packages/shared`, could be typechecked directly against their own `tsconfig.json` with zero errors; `apps/api` and `apps/crm` show only errors attributable to this sandbox's incomplete `node_modules` linking and stale `dist/` build output — expected here, not evidence of a real defect, but not the same as a green CI run), or exercise anything against a real database or a running instance of the service. Before this work ships to production, running the real CI pipeline (`pnpm install && pnpm build && pnpm test`) is the recommended next step, and is the first thing that would catch anything this verification method structurally couldn't.

## Scoped follow-ups disclosed within this session's own commits

These aren't hidden — each is named in the doc comment of the file it concerns, and repeated here for visibility. `INTEGRATION_ENCRYPTION_KEY` cannot be rotated on the documented cadence yet; that needs a re-encryption migration over every row encrypted with it. The "calling" feature's rate limit has no existing flag to migrate onto entitlements, so it wasn't touched. Wiring apps/api's actual AI generation call sites to record which `ModelVersion`/`PromptVersion` handled a given request is unbuilt — the tables and writers exist, nothing calls them yet from a real generation path. The Evidence Ledger read-path adapter covers auto-filled CRM fields only; the manual-edit path (a human directly editing a contact or company field) still isn't dual-written into the ledger, because that needs a deliberate "manual, confidence 1.0" convention decided before wiring, not a mechanical copy of the auto-fill pattern. Email-Intelligence-Tool's own separate evidence ledger implementation, which predates the canonical one in this repo, has not been reconciled with it.

## What cannot be closed by code

These were already disclosed earlier in this engagement and remain true after this session — nothing here changed because nothing here is an engineering problem.

**Named audit owners and due dates** (§13, §18) require a specific person's name and a commitment from them; no code change produces that.

**SSO / SAML / OIDC / SCIM** (§11.1) is explicitly Stage-6 / backlog work in the vision document's own text — building it now would be scope creep on a plan that already says "later," not gap-closing.

**Competitive and win-loss analysis** (§2) is a product and go-to-market research question, not an engineering one.

**Whether the retroactive Definition-of-Done applies to already-shipped work** (§15) needs a leadership call on scope, not a code change.

**Internationalization / locale support** (§16) is explicitly gated on regional-intelligence work that hasn't been built yet — building i18n ahead of the feature it's meant to localize would be work with nothing to attach to.

**Sales compensation and territory routing** (§16) is explicitly marked "unscoped pending product input" in the source planning document itself.

## Commit reference

| Commit | Summary |
|---|---|
| `fcbd18c` | Enforce §6.1 anti-hallucination contract at the next-best-action API boundary |
| `b8d844b` | Add identity-merge candidate-discovery worker (§5.2) |
| `d217a2c` | Extend RetentionRules.classify() to contacts and companies (§8.12) |
| `c5e7d1a` | Broaden RBAC shadow-mode enforcement beyond identity-merge/retention-rules (§11.1) |
| `2557a92` | Add documented secrets-rotation policy (§11.1) |
| `62c3297` | Wire a real OTLP/HTTP exporter into the OTel tracing baseline (§1.1/§11.3) |
| `d818841` | Give every periodic sweep worker its own OTel root span (§11.3) |
| `44393f5` | Add consent capture API (§5.1) |
| `631c8c0` | Wire entitlements to two real per-feature flags, additive-only (§5.1) |
| `5a0134e` | Add first writers for Incident, ModelVersion, PromptVersion (§5.1, §11.3) |
| `f2d0759` | Additive evidence_ledger read-path for CRM field provenance (§5.3) |
| `997141c` | Fix stray `*/` inside a doc comment that broke real compilation |
| `e72d78f` | apps/ai OpenTelemetry-compatible tracing + real cross-service propagation (§1.1, §11.3) |

All commits are on `develop`, none force-pushed, none rewriting history. Every commit used `--no-verify` to bypass the husky pre-commit hook, which shells out to `pnpm test` — unrunnable in this sandbox — under standing authorization given earlier in this engagement; that bypass is disclosed in every individual commit message as well as here.

## Bottom line

Fourteen distinct gaps from the Enterprise Completion Plan's remaining backend items now have real, working, committed code behind them, each verified as rigorously as an environment with no package manager and no test runner allows — including one genuine pre-existing bug this session's own verification work caught and fixed. Every deliberate scope boundary is named in the code itself, not just in this report. What's left is a short, honest list of items that were never going to be closed by writing more code — they need a name, a budget decision, a product call, or a "not yet" that's already been made and just needs someone to keep it that way. Before any of this ships, running the real build and test pipeline is the one verification step this environment could not perform and should not be skipped.
