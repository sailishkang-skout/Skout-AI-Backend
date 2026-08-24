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

**Status:** not yet wired into the PR template. Recommended next step: add this question as
a checkbox in `.github/pull_request_template.md`, and name a standing architecture reviewer
(rotates or fixed — a product/leadership decision, not an engineering one).

## §1.1 — Phase 1 (Foundation Hardening) tracker

| Item | Status |
|---|---|
| Evidence Ledger unification | **Wave 1 shipped** this pass (ADR 0002) — table + API + one dual-write call site. Wave 2 (remaining call sites) not started. |
| Tenancy/RBAC/Entitlement build | **Wave 1 shipped** this pass (ADR 0002) — tables + backfill + opt-in `assertPermission()`. Wave 2 (migrating existing `requireRole()` call sites) not started. |
| OpenTelemetry tracing baseline | **Wave 1 shipped** in the next-10 pass (ADR 0004) — in-process tracer + W3C context propagation, one worked-example BullMQ queue. Wave 2 (remaining queues, real OTLP exporter, apps/ai/Python) not started. |

## §1.2 — Strategic outcome (From → To) tracker

| Shift | Owning domain(s) | Status |
|---|---|---|
| Separate screens → one canonical graph | Evidence Ledger + Tenancy (this pass) | Wave 1 foundation shipped; not yet the *only* path (Wave 2) |
| Opaque AI → evidence-backed recommendations | `evidence-contract.ts` (this pass) | Library shipped; not yet required at every AI-response boundary — that adoption is separate follow-up work |
| Manual copying → observable async workflows | Dexter Orchestrator, Workflow Studio | Not started |
| Provider-specific logic → domain abstractions | PAL, `telecom.service.ts` | Already largely true — no action needed |
| Vanity dashboards → decision-oriented views | CRO Copilot forecasting split, board-pack export | Not started |
| Uncontrolled automation → four explicit modes | Dexter Policy Gateway | Not started |

## §2 — Competitive positioning

This is a product/leadership decision, not an engineering task, and nothing in this pass
resolves it. The two open questions from `Skout_AI_Feature_Clarity_Questions.pdf` (Q1, Q2)
still stand: which specific competitor gaps are being committed to first, and whether the
product should ever show competitor comparisons in-app. **No status change from this pass.**

## §3 — Product principles: enforcement mechanism per principle

| Principle | Enforcement mechanism | Status |
|---|---|---|
| One truth, many views | The §1 PR-gate question above + Evidence Ledger/Tenancy as the canonical store | Mechanism defined this pass; not yet tooled (manual PR review only) |
| Evidence before action | `evidence-contract.ts`'s `assertEvidenced()` | Shipped this pass; not yet required everywhere it should be |
| Ask before guessing | Onboarding wizard clarifying questions (§8.1) | Not started |
| Human control by design | `activation-rules.service.ts`'s 5-rule cap; `ai-draft.service.ts`'s approval queue | Already real, pre-dates this pass |
| Global by model | Regional/country intelligence (§6.2–§6.3) | Not started |
| Async is first-class UX | Warm-Up-Tool's execution-intent pattern, not yet extended elsewhere (§7.2) | Not started |
| Provider abstraction | PAL, `telecom.service.ts` | Already real, pre-dates this pass |
| No silent failure | Observability baseline (§11.3) | Not started |

Three of eight principles now have a real, shipped enforcement mechanism as of this pass
(evidence-before-action, and the two that were already true beforehand). The remaining five
are unchanged by this pass and need their own scoped work.
