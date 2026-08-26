# Architecture review checklist

Source: Skout AI Enterprise Platform Engineering Vision v2.1, §1 (Executive mandate),
§1.1–§1.2, §2 (Competitive positioning), §3 (Product principles). These are governance and
positioning items, not code — this document is how they get enforced going forward, and
records the decisions/status as of this pass.

## §1 — Executive mandate: the "does this fork state" gate

**Rule:** before a PR that adds a new feature-owned table, cache, or duplicated business
rule is merged, the author (or reviewer) answers, in the PR description:

> Does this feature read/write the canonical entities (Evidence Ledger — `evidence_ledger`;
> Tenancy/RBAC — `tenants`/`roles`/`workspace_member_roles`; deterministic identity —
> `identity.ts`), or does it create its own local copy of state that one of those already
> models?

If the answer is "creates its own copy," the PR needs an explicit justification and a named
architecture reviewer's sign-off before merge — the same bar that would have caught the
three parallel evidence-tracking mechanisms this pass is now unifying (ADR 0002).

**Status:** wired into [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md)
as the §1 Architecture gate checkbox. Standing architecture reviewer name is still a
product/leadership decision (not an engineering one).

## §1.1 — Phase 1 (Foundation Hardening) tracker

| Item | Status |
|---|---|
| Evidence Ledger unification | **Wave 1 shipped** this pass (ADR 0002) — table + API + dual-write call sites. **Wave 2 in progress:** autofill precedence uses ledger manual locks; full cutover ongoing (due 2026-09-15). |
| Tenancy/RBAC/Entitlement build | **Wave 1 shipped** this pass (ADR 0002) — tables + backfill + opt-in `assertPermission()`. Wave 2 (migrating existing `requireRole()` call sites) not started. |
| OpenTelemetry tracing baseline | **Wave 1 shipped** in the next-10 pass (ADR 0004) — in-process tracer + W3C context propagation, worked-example queues + sweep workers. Wave 2 (remaining queues, apps/ai/Python full) largely shipped. |

## §1.2 — Strategic outcome (From → To) tracker

| Shift | Owning domain(s) | Status |
|---|---|---|
| Separate screens → one canonical graph | Evidence Ledger + Tenancy (this pass) | Wave 1 foundation shipped; not yet the *only* path (Wave 2) |
| Opaque AI → evidence-backed recommendations | `evidence-contract.ts` (this pass) | Library shipped; not yet required at every AI-response boundary — that adoption is separate follow-up work |
| Manual copying → observable async workflows | Dexter Orchestrator, Workflow Studio | **Backend shipped** — `workflow_runs` + `/api/v1/workflows/runs*` (UI Aditya) |
| Provider-specific logic → domain abstractions | PAL, `telecom.service.ts` | Already largely true — no action needed |
| Vanity dashboards → decision-oriented views | CRO Copilot forecasting split, board-pack export | **Backend shipped** — `decision_views` + `/api/v1/decisions*` (UI Aditya/Shailpreet) |
| Uncontrolled automation → four explicit modes | Dexter Policy Gateway | **Backend shipped** — ask/auto/draft/approve + `/api/v1/automation-policy` |

## §2 — Competitive positioning / win-loss (§2)

**Engineering (2026-08-26):** Postgres-backed `competitive_win_loss_*` tables + API
(`GET/POST /api/v1/competitive/win-loss*`). Status flips to `complete` at ≥4 real deals.
Template: `docs/templates/competitive-win-loss.md`.

**Still Product/GTM:** enter ≥4 won/lost deals or assign owner by **2026-09-09**. Regional TAM
marketing gate remains blocked until deals are recorded.

## §3 — Product principles: enforcement mechanism per principle

| Principle | Enforcement mechanism | Status |
|---|---|---|
| One truth, many views | §1 PR-gate + Evidence Ledger SoT autofill + reconciliation matrix | **Enforced** (Wave 2) |
| Evidence before action | `assertEvidenced()` + `pinAiClaim` on all AI pin surfaces | **Enforced** |
| Ask before guessing | NL search `unverified`; onboarding clarifiers (§8.1 UI) | **Enforced** (API); UI clarifiers Shailpreet |
| Human control by design | `MAX_ACTIVE_RULES_PER_WORKSPACE = 5`; AI draft approval queue | **Enforced** |
| Global by model | Regional intel + §2 win/loss API gate (`assertRegionalTamValidated`) | **Enforced** |
| Async is first-class UX | Warm-Up intent + `withSpan` on all 18 workers + journey metrics | **Enforced** |
| Provider abstraction | PAL, `telecom.service.ts` | **Enforced** |
| No silent failure | Datadog APM + OTLP + `/slo` + `/metrics` + `skout_journey_*` | **Enforced** |

**All eight** principles have a shipped enforcement hook (2026-08-26 Wave 2). External: GTM win/loss data; §8.1 onboarding UI clarifiers.