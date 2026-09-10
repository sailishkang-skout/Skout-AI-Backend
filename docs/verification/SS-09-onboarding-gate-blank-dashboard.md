### SS-09 — Onboarding: server-side gate + blank-dashboard verification

**Objective:** Trace whether (1) the "confirm before automation" / autonomy-mode setting captured during onboarding is actually enforced server-side before an automated action fires, and (2) a genuinely fresh workspace shows the setup checklist / demo-seed prompt instead of a blank dashboard.

**Update:** Gap 1 below was initially flagged as its own ticket per this ticket's "flag if bigger than expected" instruction. On request, it was fixed — see "Fix applied" at the end of section 1. Gap 2 needed no fix.

---

## 1. Autonomy-mode gate — **Was not enforced (decorative). Now fixed.**

**The setting exists and is captured.** The onboarding wizard (`apps/app/(dashboard)/onboarding/page.tsx` in Skout-AI-Frontend) has a dedicated "autonomy" step with three options (`AUTONOMY_MODES`): `manual`, `assisted`, `autonomous`. The choice is folded into `state.autonomyMode` and included in the payload `buildIcpConfig()` sends.

**Where it's saved.** `icpApi.save()` does `PUT /api/v1/workspace/icp` with the whole onboarding profile nested under `onboarding.autonomyMode`. Backend-side, `icp.routes.ts`'s `onboardingSchema` validates it (`z.enum(["manual", "assisted", "autonomous"])`) — but the handler only calls `setWorkspaceIcp(app.db, workspaceId, body)` (`icp.service.ts:57`), which does exactly one thing: upsert the whole config blob into the `workspace_icp.config` jsonb column. That's it. No other write happens in that request.

**Where automated actions actually check permission.** The real server-side gate is `policy-gateway.service.ts`'s `assertAllowed` / `getActionMode`, backed by the `automation_policies` table (`workspace_id`, `action_key`, `mode`). It's genuinely used — confirmed by tracing `invokeDexterPlan` (`dexter-journey.service.ts:167`) calling `assertAllowed` before executing a Dexter plan, and by the `dexter-orchestrator.worker.test.ts` integration test that fails with `"Policy Gateway requires Ask confirmation"` when the mode isn't `"auto"`. `DEFAULT_ACTION_MODES` hardcodes a per-action default (`dexter.plan_invoke: "approve"`, `sequence.enroll: "auto"`, etc.) used whenever no `automation_policies` row exists for that `(workspace, actionKey)` pair.

**The gap.** `grep`ing `policy-gateway.service.ts` for `autonomyMode` or `workspaceIcp` returns nothing. `setWorkspaceIcp` never touches `automation_policies`. There is no code path anywhere that reads `workspace_icp.config.onboarding.autonomyMode` and turns it into an `automation_policies` row via `upsertActionMode`. The only thing that writes real automation-policy rows is a *separate*, disconnected route — `POST /api/v1/dexter/policies` (`dexter-platform.routes.ts:60`, backing the Dexter Command Center settings UI).

**Verified, not just read:** `apps/api` typechecks and its full test suite (155 files / 1632 tests) passes with this code path unchanged, and manual tracing of `setWorkspaceIcp` confirms it performs a single jsonb upsert with no side effects.

**Conclusion:** A user can pick "Autonomous" during onboarding, and every automated action in the product still runs under whatever `DEFAULT_ACTION_MODES` says (mostly `ask`/`approve`/`draft`, except `sequence.enroll` which defaults to `auto` regardless of what the user picked) until someone separately visits the Dexter Command Center's policy settings and changes it there. The onboarding question is honest-looking UI with no backend effect.

**Fix applied.** `policy-gateway.service.ts` gained `applyOnboardingAutonomyMode(db, workspaceId, autonomyMode, userId)`, called from `PUT /api/v1/workspace/icp` only when `onboarding.completedAt` is set (i.e. the wizard actually finished, not on every incremental step-save):

- **`autonomous`** ("sends and acts... without a per-item review") → every one of the 8 action keys is force-set to `"auto"`.
- **`manual`** ("you approve every send and action") → only `sequence.enroll` (the one action key whose system default is already `"auto"`) is overridden to `"ask"`; every other key is left at its existing ask/draft/approve default rather than being flattened.
- **`assisted`** ("drafts and acts on routine steps, flags anything new") → clears any prior override for these 8 keys back to `DEFAULT_ACTION_MODES`, since that's already the intended balance.
- Switching autonomy levels always resets first (deletes existing override rows for the 8 keys) before applying the new level, so e.g. going `autonomous` → `manual` actually reverts `dexter.plan_invoke` back to `"approve"` instead of leaving a stale `"auto"` row behind.

Verified with a real DB: a unit-level test (`policy-gateway.service.test.ts`, 4 cases, including a regression test for the stale-override bug caught while writing it) and a full HTTP end-to-end test (`onboarding-autonomy.e2e.test.ts`, 3 cases) that completes onboarding via the real `PUT /api/v1/workspace/icp` route and confirms `GET /api/v1/automation-policy` reflects the chosen mode. Full `apps/api` suite: 157 files / 1639 tests, all passing.

---

## 2. Fresh-workspace dashboard — **Yes, handled correctly. Verified end-to-end.**

**Traced the full path**, then verified it live against a real, brand-new workspace (a fresh stub user/workspace provisioned in this session, zero prior data) hitting the real endpoints on a live Postgres:

- `GET /api/v1/workspaces/current/setup-checklist` → `200`, `{ complete: false, readyForOutboundSend: false, items: [4 items, all done: false] }`. `getSetupChecklist` (`workspace-setup.service.ts`) counts lists/mailboxes/prospect-activations with plain `COUNT()` queries scoped to the workspace — zero rows just means zero counts, no crash, no special-casing needed.
- `POST /api/v1/workspaces/current/seed-demo-data` → `200`, `{ added: 3, alreadySeeded: false }` — creates a real "Demo: Sample Prospects" list using the RFC 2606 documentation domains (example.com/.org/.net), so even an accidental send can't reach a real inbox.
- `GET /api/v1/dashboard/summary` → `200` on the untouched fresh workspace, `{ listCount: 0, totalProspectsInLists: 0, icpConfigured: false, recentJobs: [], ... }` — no divide-by-zero, no unhandled null.

**Frontend renders unconditionally, not gated behind "if empty".** `dashboard/page.tsx` always renders, in order: header, `<DemoBanner />`, `<SetupChecklistCard />`, the stat-tile grid (shows `"—"`/`0` while empty, never omitted), a Quick Actions card, and a "Recent enrichment" card with an explicit empty state ("No enrichment jobs yet — Run your first enrichment") rather than nothing. `SetupChecklistCard` fetches the checklist and renders it (plus a "Load demo data" button wired to the seed endpoint) whenever `!complete`; it only renders `null` once the checklist is genuinely finished. There is no code path that renders an empty container.

**Conclusion:** A fresh workspace cannot land on a blank dashboard — the checklist + demo-seed prompt (§8.1's actual requirement) render correctly, confirmed by both code trace and a live request against a real zero-data workspace. No fix needed.

---

## Summary

| # | Question | Finding |
|---|---|---|
| 1 | Does the onboarding autonomy-mode gate get enforced server-side? | **Was no** — stored as inert JSON, never read by the real enforcement path. **Fixed**: onboarding completion now writes real `automation_policies` rows via `applyOnboardingAutonomyMode`. |
| 2 | Does a fresh workspace show the checklist/demo-seed path instead of blank? | **Yes.** Verified live against a real empty workspace — checklist, demo-seed CTA, and zeroed stat tiles all render correctly. |
