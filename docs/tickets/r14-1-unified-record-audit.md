# R14.1 — Unified-record lock-in audit

> Per `docs/tickets/phase-1-feature-work-plan.md` R14.1. Written audit, not code — checks
> whether shipped/in-progress features write back to the *same* shared prospect/company
> record (PRD anti-pattern: no parallel "prospect" databases) or fork off a duplicate copy.
>
> Findings below are grounded in the actual schema/routes as of 2026-08-04 (`packages/db/src/schema/`,
> `apps/crm/src/routes/`, `apps/api/src/routes/`) — not the roadmap docs, which had gone stale:
> native CRM entities (`companies`, `contacts`, `deals`, `pipelines`, `tasks`, `activities`,
> `meetings`) are already live in `apps/crm`, ahead of what `master-prd-implementation.md`
> Phase 2 status table currently shows.

| Feature | Unified? | Evidence | Gap / owner |
|---------|----------|----------|-------------|
| Prospect activation → CRM contact/company | 🟡 Partial | `contacts.sourceProspectId` / `companies.sourceProspectCompanyId` exist as link-back columns | **Gap:** no automated job populates a `contacts`/`companies` row from an `enrichment.prospect_activations` row today — the two live side by side without a confirmed sync path. **Owner:** needs confirmation with whoever owns `apps/crm` + `apps/api` enrichment. |
| Activity timeline (calls, meetings, stage changes) | ✅ Unified | `activities` table keyed by `(entityType, entityId)`; `deals.routes` logs `stage_change` on `PATCH`, `meetings.routes` logs a `meeting` activity on create — confirmed in `apps/crm/README.md` | None — this is the reference pattern every new Track B feature (call notes R20.1, AI suggestions R20.3, meeting notes R16.3) should write into, not a new table. |
| Tasks | ✅ Unified | `tasks.relatedEntityType` / `relatedEntityId` link to any CRM entity; full CRUD in `apps/crm` | None — R21 in the Track B plan doc can be **closed as already-shipped**, not built from scratch. Update the plan doc mapping. |
| Sequences / enrollments (Track A) | 🟡 Partial | Sequences reference `prospect_id` (per `remaining-features-build-order.md`), not `contacts.id` | **Gap:** sequence enrollment and the native `contacts` table use two different identity keys today. A reply pausing a sequence and a CRM activity on the same person aren't guaranteed to be the same row. **Owner:** Track A (R1/R2) + CRM service need a reconciliation pass before R20.4 (call step) or R13.3 (auto-fill into `contacts`) can safely assume one identity. |
| HubSpot export | 🔴 Leaves the platform (by design) | `crm.routes.ts` push path is an explicit, opt-in export, not a silent duplicate | Not a gap — this is the intentional migration/parity path, not an anti-pattern. Tracked instead in R14.3 (switching-cost dashboard) as a metric to watch, not eliminate. |
| CSV export (lists) | 🔴 Leaves the platform (by design) | `list-export.service.ts` | Same as above — legitimate user-facing feature, tracked as a metric in R14.3, not flagged as a bug. |
| AI drafts / scores | ✅ Unified | Persist to `ai_drafts` / `prospect_scores`, keyed by `prospect_id`, surfaced back on the same record | None. |

## Summary

The core of the platform (CRM entities, tasks, activities, meetings, AI outputs) is
genuinely unified around shared identity keys and a single activity timeline — this is in
better shape than the last roadmap update reflected. The one real structural gap is the
**prospect-corpus identity (`prospect_id`) vs. native-CRM identity (`contacts.id` /
`companies.id`) not yet being reconciled**. Every Track B ticket that writes into a CRM
record (R13.3 auto-fill, R20.1 call notes, R20.3 AI suggestions, R20.4 call steps, R16.3
meeting notes) should treat this reconciliation as a blocking prerequisite, or explicitly
document which identity it's writing against and why, rather than silently picking one.

**Action items:**
1. Confirm with the team whether an activation → `contacts`/`companies` sync job exists or
   is planned; if not, open a ticket (this is a real prerequisite for several Track B items,
   not just a documentation gap).
2. Track A owners: confirm whether `sequence_enrollments` will get a `contactId` FK, or
   whether `contacts` will get a `prospectId` FK — pick one direction so downstream Track B
   work doesn't guess.
