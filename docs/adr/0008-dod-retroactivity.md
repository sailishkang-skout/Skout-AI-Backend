# ADR 0008 — Definition of Done retroactivity (§15)

## Status
Accepted (interim Lead decision; leadership may override)

## Context
Enterprise Completion Plan §15 requires a full Definition of Done checklist. Applying it
retroactively to every already-shipped feature in one pass is not realistic.

## Decision
DoD applies to **new work from 24 Aug 2026 onward**, not retroactively to production features
already shipped before that date. Encoded in `.github/PULL_REQUEST_TEMPLATE.md`.

## Consequences
- New PRs must complete (or N/A) the §15 checklist and §1 architecture gate.
- Pre-2026-08-24 surfaces are not re-certified en masse unless leadership opens a separate
  remediations program.
- Named owner for confirmation/override: Neeraj (Lead); backup: Eng director.

## Alternatives considered
1. Full retroactive re-certification — rejected as unbounded blast radius.
2. Soft guidance only — rejected; CI already enforces architecture fork-state gates.
