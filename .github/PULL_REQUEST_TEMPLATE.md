## Summary

<!-- What does this PR do and why? -->

## Test plan

<!-- How was this verified? -->

## Definition of sharp

- [ ] Acceptance criteria met (not just demoed)
- [ ] No regression to an adjacent existing feature
- [ ] Empty/error/loading states designed, not just the happy path
- [ ] AI-generated output includes a visible confidence or source, per the product's AI guardrails (N/A if this PR has no AI-generated output)
- [ ] If this PR starts a new epic (R11–R22 or later), its kickoff doc states in one sentence what only works because it lives inside Skout's unified data model, per R14.2 (N/A otherwise — see `docs/tickets/phase-1-feature-work-plan.md`)

## §1 Architecture gate (Enterprise Completion Plan)

- [ ] **Does this feature read/write the canonical entities** (Evidence Ledger — `evidence_ledger`; Tenancy/RBAC — `tenants`/`roles`/`workspace_member_roles`; deterministic identity — `identity.ts`), **or does it create its own local copy of state** that one of those already models? If it forks state, this line explains why and names the reviewer who signed off: _______

## Definition of done (Enterprise Completion Plan §15 — adopted verbatim as the checklist)

Applies to **new work from 24 Aug 2026 onward**, not retroactively to already-shipped features
— re-certifying everything already in production against this full list isn't realistic in one
pass. This scoping decision is Neeraj's (Lead) as the person adopting the checklist; it should
be confirmed or overridden by leadership, not treated as final. N/A any line genuinely
inapplicable to this PR (e.g. no migration in a docs-only change) rather than leaving it unchecked.

- [ ] **Data ownership** — this PR's tables/columns have a named owning service; no other service writes to them without going through its API (or a documented read-model exception, ADR 0003-style)
- [ ] **Permissions** — this endpoint's role/permission requirement is explicit in code (not implied by "nobody malicious would call this")
- [ ] **Jobs** — any async work has a defined retry/backoff and a terminal failure state that surfaces somewhere (not just logged and dropped)
- [ ] **Failure states** — every user-facing flow this PR touches has an explicit failure state design, not just the happy path
- [ ] **Audit** — privileged/destructive actions write an audit event (`audit_logs`, or `recordPrivilegedAction()` — see `packages/auth/src/step-up.ts`)
- [ ] **Telemetry** — this PR's new code paths are visible in existing logging/tracing (Pino/Sentry/OTel — see `packages/observability`), not a blind spot
- [ ] **Provider behavior** — any third-party API call has a defined timeout, retry policy, and handles the provider being down
- [ ] **Migrations** — additive and backward-compatible (no dropped/renamed columns on a live table without an explicit, reviewed exception); reversible or has a documented reason it isn't
- [ ] **Contracts** — API request/response shapes are validated (zod or equivalent), not assumed
- [ ] **Tests** — real test coverage exists for this PR's logic (unit and/or integration, matching the file's existing test convention)
- [ ] **Docs** — a comment, ADR, or doc update explains any non-obvious decision this PR makes
- [ ] **Journey states** — if this PR is part of a user-facing journey, it's been checked against the doc's 10 named states (not enumerated here — see the source Enterprise Completion Plan §15)
- [ ] **No competing truth** — this PR doesn't introduce a second source of truth for a fact that already has a canonical home
- [ ] **AI claims are grounded** — any AI-generated factual claim cites an `evidence_id` or is explicitly labeled unverified (see `@skout/shared`'s `evidence-contract.ts`)
- [ ] **WCAG 2.2 AA** — for any frontend change: keyboard navigable, sufficient contrast, screen-reader labels present
