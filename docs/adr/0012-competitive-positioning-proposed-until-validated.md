# ADR 0012 — Competitive positioning: proposed until win/loss validated

## Status
Accepted — **2026-08-29** (Leadership / GTM alignment)

## Context
§2 of the Enterprise Completion Plan requires validating positioning claims (regional intelligence,
evidence-backed recommendations, operator control) against **real buyer evidence** from won/lost
deals. Engineering ships `competitive_win_loss_*` tables and a Regional TAM gate; GTM owns deal
review and data entry.

## Decision
1. Until **≥4 real won/lost deals** are recorded per workspace (`competitive_win_loss_deals`), the
   three differentiators above are **proposed hypotheses**, not proven competitive advantages.
2. **Regional TAM Learning (§6.3)** stays **no-go** for marketing claims and `purpose=tam|competitive`
   on `POST /api/v1/regional-intel` until the gate clears.
3. If GTM cannot find four qualifying deals in the review window, **document the gap** in
   `docs/templates/competitive-win-loss.md` and run a **pilot feedback** track — synthetic deals and
   demo seed rows do not count.
4. **Marketing** limits claims to substantiated product facts until validation; advisory UI (regional
   briefs, Dexter) remains `unverified: true`.
5. **Regional TAM product development** continues only against **customer need + measurable pilot
   outcomes**, not positioning assumptions.

## Consequences
- API: `GET /api/v1/competitive/win-loss` returns `positioning` policy metadata.
- Ops: `docs/ops/competitive-win-loss-process.md` is the GTM runbook.
- Template: `docs/templates/competitive-win-loss.md` is the sign-off artifact.

## Supersedes
Clarifies ADR 0009 §3 — win/loss gate is mandatory for *validated* positioning, not for building
advisory regional features behind `onboarding` / `territory` purposes.
