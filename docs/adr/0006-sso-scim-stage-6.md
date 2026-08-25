# ADR 0006: SSO/SAML/OIDC/SCIM — Stage-6 (deferred build)

## Status
Accepted as **Stage-6 / backlog** per Enterprise Completion Plan §11.1. Closing the
"gap" for Wave-1 means documenting the acceptance path, not shipping a custom IdP.

## Context
Skout already authenticates with **Clerk**. Enterprise SSO (SAML/OIDC) and SCIM
user provisioning are Clerk Enterprise features, not greenfield protocol work in
this monorepo.

## Decision
1. Wave-1/2: continue Clerk JWT + workspace membership (status quo).
2. Stage-6 completion criteria:
   - Clerk Organization with Enterprise SSO enabled for the customer IdP
   - SCIM directory sync mapped to `users` / `workspace_members` / `workspace_member_roles`
   - Documented break-glass for SSO outage
   - E2E test: SSO login → provisioned member → RBAC grant present
3. Do **not** build a parallel SAML ACS in apps/api unless Clerk cannot meet a
   named customer requirement (escalate as a new ADR).

## Checklist (ops / platform)
- [x] Clerk production instance on plan that includes SSO + SCIM — confirmed 2026-08-25
- [ ] Customer IdP metadata exchanged
- [ ] Map IdP groups → Skout system roles (`owner`/`admin`/`member`)
- [ ] Run `backfill-rbac` after first SCIM sync
- [ ] Set `RBAC_ENFORCEMENT_ENABLED=true` only after grants verified

## Consequences
§11.1 SSO remains open on the Neeraj task list until Stage-6 checklist is signed.
Engineering must not claim "SSO done" when only Clerk password/social login works.
