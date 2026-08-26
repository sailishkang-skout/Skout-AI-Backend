# ADR 0002: Canonical operating model — Wave 1 (Tenancy, RBAC, Evidence Ledger)

## Status

Accepted

## Context

The v2.1 Engineering Vision (§5) calls for a canonical operating model — Tenant, Role,
Permission, Entitlement, Consent, and a shared Evidence Ledger — as the foundation the rest
of the platform reads from and writes to. Today, tenancy is implicit (a Workspace *is* the
tenant boundary), authorization is a flat `workspace_members.role` text column, and evidence
of "why do we believe this fact" is tracked three separate times: `apps/crm`'s `fieldSources`
jsonb column, Skout-Email-Intelligence-Tool's own evidence ledger, and
`next_best_action_suggestions`' acceptance tracking. None of the three share a schema.

Real customer data exists in production. Any schema change here has to be safe to run
against a live database without a rollback plan more complicated than "revert the code" —
dropping or renaming an existing column is off the table for this pass.

## Decision

Ship the canonical model additively, in two waves:

**Wave 1 (this change):**
- `tenants` + `tenant_workspaces` — a tenant is distinct from a workspace, but nothing on the
  `workspaces` table changes. A tenant owns workspaces through `tenant_workspaces`
  (unique on `workspace_id`, so today it's 1:1 by backfill), not a direct FK column. This
  means a tenant owning multiple workspaces later needs no further migration.
- `roles` / `permissions` / `role_permissions` / `workspace_member_roles` — additive
  alongside `workspace_members.role`. `requireRole()` and the existing column are **untouched**
  and remain the enforced path on every existing route. `assertPermission()`
  (`packages/auth/src/require-permission.ts`) is a new, opt-in, finer-grained check new call
  sites can use; migrating existing `requireRole()` call sites onto it is separate, tracked
  follow-up work — not implied as done by this table existing.
- `entitlements` / `consents` — table + read/write shape exist. Migrating the existing
  per-feature workspace flags (credits, LinkedIn send limits, calling) onto `entitlements` is
  Wave 2, not this pass.
- `evidence_ledger` — the shared table, with `evidence.service.ts`'s read/write API.
  `apps/crm`'s company auto-fill path dual-writes into it (Wave 1 proof of the integration
  pattern); migrating Email-Intelligence-Tool's evidence ledger and
  `next_best_action_suggestions` onto it is Wave 2.
- `identity_merge_proposals` / `identity_merge_events` — probabilistic identity matching
  (§5.2), scored by `packages/shared/src/identity-merge.ts`. Deterministic matching
  (`identity.ts`'s hash-based `generateProspectId`/`generateCompanyId`) is untouched and
  remains the default path; this only adds an opt-in, human-reviewed merge-proposal queue for
  candidates that don't share a deterministic key. Nothing auto-merges.
- `packages/shared/src/evidence-contract.ts` — the §6.1 anti-hallucination shared library
  (`UNKNOWN`, `reportOrUnknown`, `assertEvidenced`), mirroring the discipline already proven
  in Skout-Warm-Up-Tool's domain layer.

**Wave 2 (tracked, not started in this pass):**
- Migrate the three existing evidence mechanisms' remaining call sites onto `evidence_ledger`.
- Migrate existing `requireRole()` call sites onto `assertPermission()` where finer-grained
  checks are actually needed.
- Migrate the per-feature workspace flags onto `entitlements`.
- Decide whether `tenant_workspaces` needs to support genuine many-workspaces-per-tenant in
  the product (multi-workspace enterprise customers), or whether 1:1 is permanent.

## Wave 2 progress (Aug 2026)

**Wave 2 evidence authority shipped 2026-08-26:**

- **Evidence Ledger:** dual-write on CRM auto-fill, manual edit, enrichment autofill, deals,
  call-note autofill, Email-Intel ingest/forwarder (SkoutDev), HubSpot inbound.
  **Autofill precedence:** `effectiveSourcesForAutofill` overlays **all** ledger sources
  (ledger is SoT; `fieldSources` is write-through cache only — column not dropped).
  **NBA stats:** prefer ledger attributes `next_best_action` / `next_best_action_accepted`.
- **RBAC:** fail-closed on SkoutDev; `enforcePermission` on CRM + privileged API routes;
  prod backfill when SkoutProd exists.
- **Identity merge:** discovery worker + apply/restore on approve/reverse.
- **Anti-hallucination:** `pinAiClaim` on sequence-generate, drafts fail-closed, NL search
  marks LLM filters `unverified`.
- **HubSpot bi-di:** inbound native-CRM sync + webhooks (§8.12) — see ADR 0009.

## Consequences

- Zero risk to existing behavior: no existing table, column, or route changes. The migration
  is pure `CREATE TABLE`.
- `workspace_member_roles` and `tenant_workspaces` are backfilled by
  `packages/db/src/backfill-rbac.ts` (`pnpm --filter @skout/db backfill-rbac`), which is safe
  to re-run (every insert is existence- or conflict-checked first).
- The Evidence Ledger and RBAC tables exist and are usable (real read/write API, not just
  inert schema) but are not yet the *only* path — Wave 2 is what makes them authoritative.
  Anyone building a new feature on canonical entities should read/write these tables directly
  rather than inventing a fourth parallel mechanism; that's the governance rule this ADR
  exists to set.
