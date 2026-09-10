# R14.1 — Unified-record lock-in audit

> Per `docs/tickets/phase-1-feature-work-plan.md` R14.1. Written audit, not code — checks
> whether shipped/in-progress features write back to the *same* shared prospect/company
> record (PRD anti-pattern: no parallel "prospect" databases) or fork off a duplicate copy.
>
> Findings below are grounded in the actual schema/routes as of 2026-08-04, updated 2026-08-10
> after the R13.3/R13.4/R16.2/R16.3/R20.3/R15.2/R19.2 gap-closure pass (`packages/db/src/schema/`,
> `apps/crm/src/routes/`, `apps/api/src/routes/`) — not the roadmap docs, which had gone stale:
> native CRM entities (`companies`, `contacts`, `deals`, `pipelines`, `tasks`, `activities`,
> `meetings`) are already live in `apps/crm`, ahead of what `master-prd-implementation.md`
> Phase 2 status table currently shows.

| Feature | Unified? | Evidence | Gap / owner |
|---------|----------|----------|-------------|
| Prospect activation → CRM contact/company | 🟡 Partial | `contacts.sourceProspectId` / `companies.sourceProspectCompanyId` link-back columns; `EnrichmentService.activate` now auto-fills a linked contact/company on every snapshot upsert (R13.3, `apps/api/src/services/enrichment-autofill.service.ts`) | **Gap:** auto-fill only reaches a contact that's already linked — no automated job *creates* a `contacts`/`companies` row from an activation. **Owner:** Sailish (enrichment/AI) + Aditya (CRM) — inferred from git history, confirm. Tracked: [`gaps/activation-to-crm-sync.md`](gaps/activation-to-crm-sync.md). |
| Activity timeline (calls, meetings, stage changes) | ✅ Unified | `activities` table keyed by `(entityType, entityId)`; `deals.routes` logs `stage_change` on `PATCH`, `meetings.routes` logs a `meeting` activity on create, `call.routes.ts` logs a `call` activity per R20.2 | None — this is the reference pattern every new Track B feature (call notes, AI suggestions, meeting notes) writes into, not a new table. |
| Tasks | ✅ Unified | `tasks.relatedEntityType` / `relatedEntityId` link to any CRM entity; full CRUD in `apps/crm`; R20.4 call steps also materialize as `tasks` rows on the same table | None. |
| Sequences / enrollments (Track A) | 🟡 Partial | Sequences reference `prospect_id` (text corpus identity), not `contacts.id` | **Gap:** sequence enrollment and the native `contacts` table use two different identity keys. A reply pausing a sequence and a CRM activity on the same person aren't guaranteed to be the same row. **Owner:** Sahil (Track A / sequences) — inferred from git history, confirm. Tracked: [`gaps/identity-reconciliation-sequences-inbox.md`](gaps/identity-reconciliation-sequences-inbox.md). |
| Inbox (threads, messages) | 🟡 Partial | `inbox_threads.prospectId` is the same text corpus identity as sequences — same gap, same root cause, not a separate parallel store | **Gap:** identical to sequences above — no `contactId` FK, so an inbox thread and a CRM contact for the same person aren't guaranteed linkable. **Owner:** Neeraj (inbox / cross-cutting) — inferred from git history, confirm. Tracked: [`gaps/identity-reconciliation-sequences-inbox.md`](gaps/identity-reconciliation-sequences-inbox.md) (same ticket — one root cause, two symptoms). |
| Signals (R11.2 unified signal store) | ✅ Unified | `signals` table keyed by `(entityType, entityId)`, read via `listSignalsForEntity` — now a real dependency of both R13.4 (auto-activation rules match on active signals) and R20.3 (next-best-action suggestions weigh active signals), not a display-only feature | None — this is a second reference pattern (alongside `activities`) worth pointing new Track B/C tickets at. |
| TAM coverage (R19.1 CRO rollup) | ✅ Unified | `cro-summary.service.ts` computes the TAM funnel (total → activated → enriched → contacted → replied → deal created) by cross-referencing the OpenSearch corpus count against `prospect_activations`, enrichment jobs, sequence sends/replies, and `deals` — all unified tables, no separate TAM store | None. The 200M-prospect corpus itself intentionally lives in OpenSearch, not Postgres (see project architecture notes) — that's a scale decision, not a lock-in anti-pattern, since nothing in the corpus is workspace-owned data until activated. |
| HubSpot export | 🔴 Leaves the platform (by design) | `crm.routes.ts` push path is an explicit, opt-in export, not a silent duplicate | Not a gap — this is the intentional migration/parity path, not an anti-pattern. Tracked instead in R14.3 (switching-cost dashboard) as a metric to watch, not eliminate. |
| CSV export (lists) | 🔴 Leaves the platform (by design) | `list-export.service.ts` | Same as above — legitimate user-facing feature, tracked as a metric in R14.3, not flagged as a bug. |
| AI drafts / scores | ✅ Unified | Persist to `ai_drafts` / `prospect_scores`, keyed by `prospect_id`, surfaced back on the same record | None. |

## Summary

The core of the platform (CRM entities, tasks, activities, meetings, signals, AI outputs) is
genuinely unified around shared identity keys and a single activity timeline — this is in
better shape than the last roadmap update reflected, and the R13.4/R20.3 gap-closure pass added
the unified `signals` store as a second load-bearing reference pattern alongside `activities`.
The one real structural gap, unchanged since the last audit, is the **prospect-corpus identity
(`prospect_id`) vs. native-CRM identity (`contacts.id` / `companies.id`) not yet being
reconciled** — now confirmed to affect sequences *and* inbox identically, not just sequences.
R13.3's auto-fill and R20.3's score/signal grounding both work *only* when
`contacts.sourceProspectId` happens to be set, and silently no-op otherwise — this is no longer a
hypothetical prerequisite, it's an active, shipped-code dependency on an unresolved gap.

**Action items:**
1. [`gaps/activation-to-crm-sync.md`](gaps/activation-to-crm-sync.md) — confirm whether an
   activation → `contacts`/`companies` sync job exists or is planned.
2. [`gaps/identity-reconciliation-sequences-inbox.md`](gaps/identity-reconciliation-sequences-inbox.md)
   — pick a direction (FK on sequences/inbox, or guaranteed contact creation on activation) so
   R13.3/R20.3 stop silently no-op-ing for unlinked prospects.
