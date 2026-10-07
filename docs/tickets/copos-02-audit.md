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

## Implementation status (branch feature/copos-02-internal-crm-360, backend and frontend)

Not merged; for review.

### Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| CRM fully works with no external CRM connected | Done | Lists, 360, timeline, stage moves, merge and bulk actions use only Skout tables; verified with no CRM connection. |
| Every Phase 1 event on the timeline; internal items hidden without permission | Done | Projector maps all Phase 1 events plus `TaskCompleted` and `ActivityRecorded`; every activity writer (CRM service, LinkedIn voice, automation writeback) emits through `appendActivityRecorded`. Internal notes need `crm:admin`; verified owner sees them, member does not. |
| 360 header and summaries in one request, query count asserted | Done | `cops-account-360.query-count.test.ts`: same statement count with 1 and 21 contacts. |
| Merge preserves external refs and history; tenant isolation test on every new table | Done | Merge keeps the survivor's link, moves other links, records colliding external ids in `cops_account_merges` and `audit_logs`. `cops-tenant-isolation.test.ts` covers all nine new tables. |
| FE: kanban drag uses the transition service and shows 409 rules inline | Done | Board calls `POST /opportunities/:id/stage`; refused moves roll back and show the allowed next moves. Browser-verified. |

### Not done (depends on other tickets)

- 360 header `commercial_state`, `onboarding_pct`, `plan`, `renewal_at` are null until COPS-03, COPS-04 and COPS-05 provide the data.
- Empty states follow the ticket's examples; the Appendix G wording itself is not in the repo and should be matched in review.

### Decisions for the reviewer

1. Event registry grew from 17 to 20 events: `LifecycleTransitioned` (COPS-01), `TaskCompleted` and `ActivityRecorded` (COPS-02).
2. The existing Skout default pipeline has no Demo stage, so `Proposal` maps to the `demo` lifecycle state; any stage can override with `pipeline_stages.lifecycle_state`. New pipelines use the Bible stages.
3. Tasks linked to an account use `related_entity_type = 'company'` (new value; existing code used contact, sequence_call_step, wrong_person_escalation).
4. Internal notes can be written by any CRM user but read only with `crm:admin`.
5. Two 360 endpoints exist: the page header still reads `/account-360/:companyId`; the new section reads `/accounts/:id/360`. Unifying them means refactoring the existing 697-line page; proposed as a follow-up PR.
6. The idempotency fingerprint now covers method and path as well as the body (also fixed on the COPS-01 branch). Keys stored before the change replay as 422 inside their 24h window.

### Rollout

1. Run migrations 0103 to 0109 (verified on a freshly created empty database: all 111 migrations apply).
2. Run `pnpm --filter @skout/db backfill-rbac` if not already run (COPS routes read `workspace_member_roles`).
3. Run `pnpm --filter @skout/db backfill-deal-closed-status` (dry run), then with `-- --apply`: aligns status and lifecycle for deals already in closed stages.

### Found outside this ticket

- When the session refresh fails (409), the app stays on "Checking workspace setup…" instead of returning to sign-in. Existing auth behaviour; needs its own ticket.
- Local runs with `AUTH_MODE` in `.env` turned stub-auth tests into 401s; the api and crm test setups now ignore an `AUTH_MODE` that only comes from `.env`.
