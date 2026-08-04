<!--
  R14.2 — "Can't do this outside Skout" + "definition of sharp" checklist.
  See docs/tickets/phase-1-feature-work-plan.md §5.12 and R14.
-->

## What & why



## Definition of sharp (R14.2 / item 3 — "Sharpen Features")

- [ ] Acceptance criteria for this ticket are met — not just demoed happy-path.
- [ ] No regression to an adjacent existing feature (checked manually or via test).
- [ ] Empty / error / loading states are designed, not left blank.
- [ ] If this ships AI-generated output, it includes a visible confidence or source
      (per the platform's AI guardrails — see `docs/master-prd-summary.md`).

## Moat angle (R14 — new Track B epics only)

For a new epic (R10–R22 in `docs/tickets/phase-1-feature-work-plan.md`), state in one
sentence what this does that only works because it's inside Skout's unified data model
(vs. a bolt-on tool). Skip this section for Track A / bug-fix PRs.

> _e.g. "TAM coverage funnel is only possible because enrichment, sequence, and deal
> data are cross-referenced in one place."_

## Testing

- [ ] `pnpm typecheck` passes
- [ ] Relevant `pnpm test` suite passes
- [ ] Manually verified in dev
