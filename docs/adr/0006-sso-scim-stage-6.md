# ADR 0006: SSO/SAML/OIDC/SCIM — Stage-6

## Status
**Accepted / eng-complete (2026-08-26)** — platform + per-workspace IdP binding APIs shipped.
Customer IdP metadata exchange remains a Clerk Dashboard step at deal time (no custom SAML ACS).

## Context
Skout authenticates with **Clerk**. Enterprise SSO (SAML/OIDC) and SCIM are Clerk Enterprise
features. §11.1 required a durable Skout-side record of each customer's bind, not a parallel IdP.

## Decision
1. Continue Clerk JWT + workspace membership.
2. Store per-workspace SSO binding in `workspace_sso_configs` (`PUT/GET /api/v1/sso/workspaces/current`,
   `POST …/activate`).
3. SCIM membership sync API: `POST /api/v1/sso/scim/sync-members` (+ dry-run).
4. Status: `GET /api/v1/sso/stage6/status`.
5. Do **not** build a custom SAML ACS unless Clerk cannot meet a named requirement (new ADR).

## Checklist
- [x] Clerk plan includes Org SSO + SCIM
- [x] Group → role map published (`docs/ops/sso-stage6-checklist.md`)
- [x] Per-workspace bind + activate APIs
- [x] SCIM sync dry-run / accept API
- [x] Production host = **SkoutDev** (only cluster) — platform endpoints live
- [ ] Customer IdP metadata exchanged **at deal time** (ops/Clerk — process, not a code gap)
- [ ] `backfill-rbac` after first SCIM sync on that org

## Consequences
§11.1 SSO is **complete** for the Neeraj task list on production. Per-customer Clerk IdP exchange is a deal-time ops checklist item, not an open platform gap.
