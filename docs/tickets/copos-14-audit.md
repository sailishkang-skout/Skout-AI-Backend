# COPS-14 audit and scope proposal: enterprise controls, intelligence and extensibility

Bible p.94 (with p.84, p.86, p.83); epic doc COPS-14 (XXL, P3, placeholder). Audit date 2026-10-22.
Branch `docs/cops-14-audit`, from `develop`. **No code in this PR.**

The ticket says: "Scope in detail only after Phase 2 ships", and "Acceptance: defined at kickoff".
This document is input for that kickoff, not a start of the build. It records what already exists
for each COPS-14 part, proposes the smallest first version of each, and lists the decisions needed.

## 1. What the Bible and the ticket ask for

Bible p.94 (Phase 3) and the ticket list six parts:

| # | Part | Ticket text | Builds on |
|---|---|---|---|
| A | Governed AI agents | per-role tool permissions, approval gates, stored traces | COPS-10, COPS-13 |
| B | Forecasting and predictive risk | renewal/churn risk with explanations | model-versions infra |
| C | Enterprise identity | SSO/SAML/OIDC + SCIM, granular custom roles over COPS-01 verbs, data-scope restrictions | `sso-scim.routes.ts` |
| D | Marketplace / integration framework | scoped API credentials, webhooks, app registry | COPS-09 |
| E | Advanced billing | metered usage, tiered/overage pricing, entitlement enforcement | COPS-08 |
| F | Cross-account intelligence | configurable warehouse exports with strict tenant privacy | COPS-13 feed |

FE: custom-role builder, SSO/SCIM setup, agent permission and approval UI, forecast views,
marketplace/app management, usage-billing views, export configuration.

## 2. What already exists (reconcile, do not rebuild)

### A. Governed AI agents
- **Dexter platform** (`schema/dexter-platform.ts`, `routes/dexter-platform.routes.ts`):
  - `automation_policies`: per workspace and per action key, with modes `ask | auto | draft | approve`.
  - `policy_decisions`: every gated action with outcome (`allowed | denied | staged | proposed`),
    actor, entity and detail. This is already a stored decision trace.
  - `dexter_plans`: a plan moves `proposed → approved → invoked → learned`, with approver, rejecter
    and outcome.
  - `dexter_triggers`, the command center, and the evaluation loop.
- **COPS-10 workflow engine**: safe-action allowlist, simulation mode, run history.
- **COPS-13 recommendations**: evidence-pinned AI output (`pinAiClaim`), human approve/dismiss,
  model and prompt version pins.
- **Gap**: the policy is per workspace and per action, **not per role**. Nothing maps a role to the
  tools an agent may call. Traces exist for decisions, not for each tool call an agent makes.

### B. Forecasting and predictive risk
- `model_versions` / `prompt_versions` with active pins, and `routes/model-versions.routes.ts` (read
  only).
- `model_decision_events` (`model-performance.service.ts`) for outcome tracking.
- `revenue_forecasts` (`schema/reporting.ts`) and `forecast.service.ts`, with an uncertainty band
  and data gaps, served by `report.routes.ts`. This is pipeline forecasting, not renewal/churn.
- COPS-11 health model: explainable factors, leading vs lagging, history for trend.
- **Gap**: there is no renewal/churn risk *prediction*. Health and renewal risk today are rules
  over current state, not a model scored against outcomes.

### C. Enterprise identity
- `workspace_sso_configs` (IdP provider, metadata URL, SCIM flag, group-to-role map, status) and
  `routes/sso-scim.routes.ts` (config, activate, SCIM member sync, which is additive only).
- RBAC (`schema/tenancy.ts`): `roles` has a nullable `workspace_id` and `is_system`, so the schema
  already allows **workspace-defined custom roles**; `permissions`, `role_permissions` and
  `workspace_member_roles` hold the COPS-01 verbs.
- **Gaps**:
  - No API to create or edit a custom role; roles come from the seed/backfill only.
  - No data-scope restrictions; a permission is all-or-nothing per resource, not "own accounts" or
    "region X".
  - **Security finding**: the SCIM bearer token is stored in plain text
    (`workspace_sso_configs.scim_api_token`) and compared with `!==`
    (`services/scim.service.ts:54`), which is not constant-time. It should be hashed at rest and
    compared with `timingSafeEqual`. This is worth fixing before COPS-14, as its own small PR.

### D. Marketplace / integration framework
- Outbound webhooks: `webhook_endpoints`, `webhook_deliveries` and `routes/webhooks.routes.ts`
  (CRUD, event types, delivery log, secret rotation).
- COPS-09 connector framework: `crm-connector.interface.ts`, a registry, sync state and history.
- `workspace_integrations` and `routes/integration.routes.ts` for provider credentials.
- **Gaps**:
  - No scoped API credentials for third parties. The only API key path in `plugins/auth.ts` is one
    platform-wide key for the email-intel integration.
  - No app registry: no "app" object with requested scopes, install/uninstall or per-workspace
    grant.

### E. Advanced billing
- COPS-08 subscriptions: `subscriptions`, `subscription_items`, `subscription_invoices`,
  `subscription_amendments`, renewals and grace/suspension.
- COPS-04 credit ledger: append-only `credit_transactions` with `consume` entries per action. This
  is already a usage record.
- `entitlements` table (key/value per workspace) and `routes/entitlements.routes.ts` (read, plus
  owner/admin write).
- **Gaps**:
  - No metered price model: no tiers, included quantity or overage rate on a plan.
  - **No central entitlement check.** Entitlements are read as per-workspace settings in a few
    places through `entitlements.service.ts` `getValueOr()`: the search credit cost
    (`search.routes.ts`), the default daily send limit (`inbox.service.ts`) and LinkedIn account
    limits (`linkedin-account.service.ts`). There is no single "is this workspace allowed this
    much" check on use, and no plan-level quota. (COPS-08 restricts spending for unpaid bills,
    which is a billing-status check, not a plan-limit check.)

### F. Cross-account intelligence and warehouse exports
- COPS-13 analytics feed: published outbox events go to PostHog with canonical names, safe
  properties only, checkpoint per sink, and lag/failure alerts.
- `tenants` and `tenant_workspaces` exist, but only `number-request.service.ts` uses them, so
  cross-workspace roll-up has a model but almost no use yet.
- **Gaps**: the sink is fixed (PostHog). There is no per-workspace export configuration
  (destination, event set, schedule), and no cross-account benchmark with privacy rules (minimum
  group size, no raw rows).

## 3. Proposed first version of each part (smallest demonstrable slice)

| # | First slice | Reuses | New |
|---|---|---|---|
| A | Per-role tool permissions for Dexter and the workflow engine: an agent action runs only if the acting user's role has the tool, otherwise it is staged for approval. Each tool call gets a trace row (input hash, decision, outcome). | `automation_policies`, `policy_decisions`, COPS-10 allowlist, `pinAiClaim` | role → tool map; tool-call trace |
| B | Renewal-risk score: rules plus features from health history, tickets, usage and payments, with factor explanations, versioned in `model_versions` and scored against real renewals in `model_decision_events`. | COPS-11 factors, COPS-13 context builder | score table and evaluation report |
| C | Custom-role builder over existing verbs (create, clone, edit, assign, audited), plus one data scope: "own accounts only". | `roles.workspace_id`, `role_permissions` | role CRUD API and UI; scope filter in list/360 reads |
| D | Scoped API keys: per workspace, hashed at rest, named scopes from existing permission keys, expiry, last-used, revoke, audited. App registry comes later. | permission keys, audit helper, webhooks | `api_keys` table and auth path |
| E | Central `assertEntitlement(workspace, key, amount)` next to the existing `getValueOr()`, on the paths that use credits and seats, then usage-billing views from the credit ledger. Tiered/overage pricing comes after Finance decides the price model. | `entitlements.service.ts`, `credit_transactions`, COPS-08 | enforcement helper; usage summary |
| F | Per-workspace export configuration (on/off, event set, destination type) on top of the COPS-13 feed. Cross-account benchmarks come later, behind a privacy rule. | COPS-13 feed, checkpoints, alerts | export config table and admin page |

**Suggested order:** first the SCIM token fix (small, security), then C (custom roles and scope),
D (API keys), E (entitlement enforcement), A (governed agents), B (renewal risk), F (exports).
C and D close enterprise-review blockers, and E turns plan limits into one enforced check. A needs
the role model from C. B needs renewal outcomes to score against.

## 4. Decisions needed at kickoff (Aditya / Product)

1. Does Phase 3 stay in this plan, or move to a separate roadmap doc? (Open question 8 in the epic doc.)
2. Which parts are in COPS-14 now, and in what order? Is the order above acceptable?
3. **A**: which agent actions may ever run without approval? Is the per-role tool map admin-configured or fixed?
4. **B**: is a rules-plus-features score acceptable for v1, or is an ML model expected? Which renewal outcomes count as churn?
5. **C**: which data scopes beyond "own accounts" (region, segment, team)? Should SCIM sync also remove members (today it is additive only)?
6. **D**: are API keys per workspace or per user? Is a third-party app registry in scope for v1?
7. **E**: the price model for metered usage (included quantity, tiers, overage rate, billing period), and which entitlements are enforced hard vs warned.
8. **F**: allowed export destinations (S3/GCS, BigQuery, webhook), and the privacy rule for cross-account benchmarks (minimum group size, opt-in).
9. Acceptance criteria for the first part chosen.
10. Capacity: COPS-14 is XXL with six parts, so should it be split into separate tickets per part?

## 5. Risks

- **Scope**: six independent capabilities in one placeholder ticket. Building without a kickoff
  risks parallel systems, which the epic doc forbids.
- **Data scopes (C)** touch every list and 360 read path; they need a tenant-isolation-style test
  suite so no path leaks.
- **Entitlement enforcement (E)** can block paying customers if limits are wrong; ship it in
  warn-only mode first, behind a feature flag.
- **Agents (A)**: per the Bible, nothing that changes price, contract, payment or customer-facing
  communication runs without approval. This must stay a hard rule, not a policy setting.
