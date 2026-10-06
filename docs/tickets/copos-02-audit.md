# COPS-02 audit-and-extend findings

Status: audit only. No schema or route changes in this document. The ticket is XXL and depends on
COPS-01, which is merged to `feature/copos-01-platform-foundation` but not yet closed (see the
COPS-01 ticket doc).

## Existing capabilities reused

| Ticket object | Existing implementation | Decision |
|---|---|---|
| accounts | `companies` (`packages/db/src/schema/crm.ts`) | Extend, do not add `accounts` |
| contacts | `contacts` (crm.ts) | Extend with verified/inferred provenance and suppression/bounce status |
| pipelines | `pipelines` (crm.ts) | Extend with motion key; default stages to Qualified → Discovery → Demo → Commercial → Contracting → Payment/Procurement → Closed |
| stages | `pipelineStages` (crm.ts) | Reuse |
| opportunities | `deals` (crm.ts) | Reuse; COPS-01 lifecycle `opportunity` dimension already drives transitions |
| tasks | `tasks` (crm.ts) | Extend task types (call/email/meeting/review/approval/onboarding check/renewal/ticket follow-up) |
| activities | `activities` (crm.ts) | Reuse as timeline source |
| meetings | `meetings`, `meetingAttendees` (crm.ts) | Reuse |
| external references | `crmNativeLinks`, `crmOutboundWrites` (crm-sync.ts) | Reuse; the external ID is a reference, never the primary key |
| audit | `audit_logs` + `writeCopsAudit` (COPS-01) | Reuse for every transition and merge |
| events | `cops_outbox` + `appendCopsEvent` (COPS-01) | Reuse for timeline projection |
| 360 | `apps/api/src/routes/account-360.routes.ts` | Extend, do not add a parallel 360 |

## Gaps (genuinely missing)

- `account_relationships`
- `contact_channels` (verified vs inferred values, suppression, bounce status)
- `opportunity_contacts` (join)
- `tags`
- `custom_field_definitions` / `custom_field_values`
- `timeline_events` (normalised projection, internal notes gated by permission)
- Field provenance columns on enriched data
- Account merge with conflict review (preserving external IDs and history)
- Saved views and bulk reassignment (permissioned)

## Tenant isolation

Existing CRM tables already carry `workspace_id`. The COPS-02 tables must carry `tenant_id`
(workspace or tenant mapping per the existing `tenants` / `tenant_workspaces` tables), and each
needs a tenant-isolation test.

## Proposed slices (contract first, one PR each)

1. OpenAPI for COPS-02 endpoints (360 header and blocks, timeline, saved views, merge) in `docs/api/`.
2. Migrations for the gap tables above, with tenant isolation tests.
3. `timeline_events` projector off COPS-01 domain events (idempotent via `cops_processed_events`).
4. `GET /accounts/:id/timeline` (cursor, type filter) and `GET /accounts/:id/360` (single query,
   field select).
5. Merge with conflict review.
6. FE: CRM kanban/table, Customer 360 tabs, timeline component, 409 inline messages.

## Open items for the reviewer

- Confirm the mapping: `companies` = Account, `deals` = Opportunity, `pipelineStages` = Stage.
  Renaming to the Bible names is not required and would be a parallel system.
- The Bible's default pipeline has seven stages; the existing seed should be checked against it.
