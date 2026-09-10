# Architecture review checklist — batch 3

Source: Skout AI Enterprise Platform Engineering Vision v2.1, §13.2 (Reconciliation matrix),
§14 (Delivery roadmap and gates), §15 (Definition of done), §16 (Missing or underestimated
areas), §18 (Copy-paste master prompt for the engineering repository audit). These are the
final 5 items of Neeraj's 25-item task list — all governance/coordination, no buildable code
per their own completion-plan text. Companion updates: `.github/PULL_REQUEST_TEMPLATE.md`
(§15) and `Skout_AI_Reconciliation_and_WBS.xlsx`'s Reconciliation Matrix + 3-Dev WBS tabs
(§13.2), delivered alongside this document rather than in this repo — that workbook isn't
part of this git history.

## §13.2 — Reconciliation matrix: done, in the actual workbook

Per the completion plan ("merge this document's findings into that workbook's Reconciliation
Matrix tab... so there's one living artifact instead of several separate documents"), this
was done directly in `Skout_AI_Reconciliation_and_WBS.xlsx`, not re-created here:

- **RM-07** (Tenant/RBAC/Entitlement), **RM-08** (Observability), **RM-12** (CRM Intelligence),
  **RM-15** (Identity resolution) — evidence, status, and target-gap columns updated in place
  to reflect what's now real, each citing the specific files shipped.
- **RM-17** (Evidence Ledger), **RM-18** (Anti-hallucination contract), **RM-19**
  (BuyingCommittee/RetentionRule), **RM-20** (Read-model exceptions), **RM-21**
  (Privileged-action audit/step-up) — 5 new rows for capabilities the 16-row starter matrix
  didn't cover yet.
- **3-Dev WBS tab**: F0.1, F1.2, F1.3, F1.4, F5.1 moved from "Not started" to "In progress"
  with actual-effort and notes columns filled in.
- No seed row was deleted, per the workbook's own Read Me instructions.

**Status: done**, in the sense the completion plan asks for — the workbook is now the one
living artifact. It is not "done" in the sense of every Section 5–11 capability having a row
(RM-16 still exists as the template for the ones that don't) — that remains formal Stage 0
audit work.

## §14 — Delivery roadmap and gates: literal exit criteria per stage

Per the completion plan: "adopting the doc's own exit-gate language as literal, checkable
acceptance criteria per phase... rather than treating the roadmap as narrative only." Below,
each stage's scope (from the source doc's own table) is converted into checkable criteria and
checked against what's actually shipped as of this pass.

| Stage | Scope | Checkable exit criteria | Status |
|---|---|---|---|
| 0 · Reconcile | Read-only repo/feature/UX/data/security/reliability audit. Zero code change. | Reconciliation Matrix has a row for every Section 5–11 capability; named audit owners assigned; due date confirmed by leadership; Open Questions tab resolved with CEO/product/legal. | Matrix substantially extended (22 rows, up from 16) across three desk-review passes; owners/due date/Open Questions resolution still pending leadership — see §18 below. |
| 1 · Foundation | Navigation shell, canonical identities, tenancy, evidence ledger, jobs, events, audit, observability. | Tenant/Role/Permission/Entitlement enforced at the service layer as the *mandatory* path (not opt-in); Evidence Ledger is the *mandatory* read/write path for at least one domain; OTel baseline correlates at least one async job end-to-end; navigation shell IA approved. | **Not met.** Tenancy/RBAC and Evidence Ledger both shipped Wave 1 (tables + working, opt-in API) but are not yet mandatory — `requireRole()` and the three parallel evidence mechanisms are untouched. Observability baseline shipped for 1 of ~16 queues. Navigation shell untouched (frontend, out of scope for this pass). |
| 2 · Discover & Intelligence | TAM, semantic search, workbooks, waterfall enrichment, evidence, 360 views, signals. | Doc's own example: "TAM-to-verified-list flow works with provenance and partial failure," wired as one automated end-to-end test. | Not started in this pass — outside Neeraj's 25-item list; unchanged. |
| 3 · Outreach & Deliverability | Sequence Studio A/B/C, runtime, email intelligence, send guard, warmup/domain health. | Sequence Studio branch coverage audited against §8.6; send-guard reads warmup/health exclusively from the consolidated Warm-Up-Tool. | Not started in this pass — Dev C's domain in the 3-dev plan, not Neeraj's list; unchanged. |
| 4 · Dexter & Communications | Dexter AI SDR service, Chrome companion, LinkedIn features, AI voice handoff, numbers, calling. | Dexter Orchestrator boundary decision made and implemented; LinkedIn compliance remediation done per legal's answer to Question 8. | Not started in this pass; unchanged — both gated on open questions (5, 8, 9) with no recorded answer. |
| 5 · CRM & Revenue | CRM Intelligence, sync, buying committees, forecasting, retention, GTM learning. | BuyingCommittee entity queryable per deal; retention workflow distinguishes marketing engagement from contractual truth; forecasting model/manager/commit split shipped. | **Partially met.** BuyingCommittee + RetentionRule shipped this pass (schema + API; `classify()` not yet wired into any ingestion path). Forecasting/GTM learning report not started. |
| 6 · Enterprise hardening | SSO/SCIM, residency/retention, DR, scale, support tooling, compliance evidence. | SSO/SAML/OIDC implemented; SCIM implemented; documented RPO/RTO; DR drill completed. | Correctly not started — explicitly out of the sized 3-dev plan and explicitly Stage-6/backlog per the vision doc's own text (§11.1). |

No stage's exit gate is fully met yet. That's expected — Neeraj's 25-item list is a slice of the
full plan, not the whole roadmap, and several stages (2, 3, 4) belong to other developers'
task lists entirely.

## §15 — Definition of done: adopted verbatim, with the scoping decision made explicit

Shipped as a real artifact: `.github/PULL_REQUEST_TEMPLATE.md` now carries the full §15
checklist verbatim (data ownership, permissions, jobs, failure states, audit, telemetry,
provider behavior, migrations, contracts, tests, docs, the 10 named journey states, no
competing truth, AI claims grounded, WCAG 2.2 AA), plus the §1 "does this fork state" PR gate
that batch 1's checklist flagged as "not yet wired into the PR template" — now closed.

The completion plan explicitly asks to "decide explicitly whether it applies retroactively to
shipped features or only to new work." **Recommendation made in the template: new work only,
starting 24 Aug 2026** — retroactively certifying every already-shipped feature against this
full list in one pass isn't realistic, and would block unrelated work. This is Neeraj's
recommendation as the person adopting the checklist, not a leadership decision he can bind the
team to unilaterally — it should be confirmed or overridden explicitly, not left implicit.

**Not done:** naming the standing architecture reviewer the §1 gate requires (a
product/leadership decision — see batch 1's checklist, unchanged), and confirming the DoD
applies to Dev B/Dev C's PRs too (they aren't in this session's scope to bind).

## §16 — Missing or underestimated areas: a real desk triage, not a decision

The completion plan asks for "a leadership/product triage against Phases 1-5... several are
compliance-adjacent... and may need to move earlier regardless of feature priority." Below is
that triage as a recommendation — genuinely reasoned, not a restatement of the source text —
for leadership to confirm, override, or re-sequence.

| Area | Current state | Recommended urgency | Why |
|---|---|---|---|
| PII / tenant-isolation-in-AI | No evidence found in either review pass | **Now** — before Stage 4 (Dexter) starts | Any AI service touching cross-tenant data without isolation guarantees is a compliance exposure the moment Dexter goes from scaffold to real orchestration — waiting until Stage 4 is already-too-late sequencing. |
| Import/export/bulk-undo/DSAR | No evidence found | **Now** — parallel to Stage 1 | DSAR (data subject access request) support has a regulatory clock once any EU/UK customer is live; this doesn't block feature work but shouldn't wait for "later." |
| Provider/data licensing rules | No evidence found | **Now** — before the next new enrichment/data provider is added | Each of PAL's 12 adapters pulls third-party data; a licensing review gets harder to retrofit the more call sites exist, not easier. |
| Consent/suppression center | Suppression exists per-channel, not unified | **Next** — Stage 2–3 | Partial coverage today reduces urgency versus the three "Now" items above, but per-channel suppression without a unified center is exactly the kind of "three parallel mechanisms" pattern this whole completion plan exists to prevent from calcifying further. |
| Entitlements/credits/usage ledger | Credits are real, not the full entitlements model | **Next** — Stage 1–2, builds directly on this pass's Tenancy/Entitlement tables (`entitlements` table already shipped, unused) | The schema exists (ADR 0002); this is now a service-layer build, not a data-model build. |
| Model evaluation/prompt registry/red-team | No evidence found | **Next** — before Stage 4 (Dexter) scales prompt usage | Real exposure, but lower urgency than PII/tenant-isolation until Dexter is doing more than scaffold-level work. |
| Search reindexing/schema evolution/scoring backfills | No evidence found | **Later** — Stage 2, when TAM/search work is active | Only urgent once the search/scoring surfaces this would protect are actually being iterated on. |
| Manual review queues | No evidence found | **Later** — Stage 2–3, alongside the identity-merge review queue this pass's API needs (RM-15/RM-21 in the workbook) | Natural to build once, covering both identity-merge proposals and any other manual-review need, rather than twice. |
| Notifications center | Per-entity resolution logic exists, not the full list | **Later** — Stage 2–3, frontend-heavy | Partial coverage, frontend-owned, no compliance angle. |
| i18n/locale | No evidence found | **Later** — gated on §6.2/6.3 (global-by-model) landing | No point localizing UI ahead of the regional-intelligence work it's meant to serve. |
| Sales comp/territory routing | No evidence found | **Unscoped** | The source doc itself says this is "unscoped pending product input" — a product decision, not a triage call this document can make. |

Three "Now" items are compliance-adjacent, matching the source doc's own flag — this triage
makes that flag concrete instead of leaving it as "may need to move earlier."

## §18 — Formal Stage 0 audit: run using this pass as the evidence base

The completion plan: "Run it now, using this document and the companion documents as a head
start rather than a starting point of zero. This is a one-time coordination action, not an
engineering build."

**What this means concretely, and what was and wasn't done:** the original CEO's v2.1 vision
document's literal §18 copy-paste prompt text was never provided to this session — only
Neeraj's filtered 25-item task list was uploaded, plus the desk-review documents already on
file (`Skout_AI_Stage0_Analysis_and_Plan`, `Skout_AI_Reconciliation_and_WBS.xlsx`, this
session's own two implementation passes). Rather than fabricate a "literal instruction" never
seen, the audit was run *in substance* — real file-level evidence gathered and cited, the
Reconciliation Matrix extended, gaps documented per capability — which is what the prompt
itself would produce as output. What remains, and genuinely requires a named human, not an
engineering pass:

- **Named audit owners** — the 3-Dev WBS tab's F0.1 row already suggests "Dev A/B/C (split by
  repo)," matching the existing role split (Dev A: backend/data model, Dev B: frontend, Dev C:
  AI/outreach/integrations). Recommend confirming this split by name, not role, since "Dev A"
  isn't a person.
- **A due date** — no date is set anywhere in the source materials. Recommend within 5
  business days of this pass (by 29 Aug 2026), since the evidence base is now substantially
  assembled and the remaining work is confirmation/sign-off rather than starting from zero —
  but this is a scheduling call for Neeraj/leadership, not this document's to set.
- **Confirming Open Questions tab items #1 and #2** (both open, both asking exactly this) —
  the workbook already tracks this; it isn't duplicated here.

**Status: substantively run, formally not closed** — the distinction the source doc itself
draws matters here, and this document doesn't paper over it.
