# ADR 0003: Documented read-model exceptions (§5, §7.1)

## Status
Accepted — Wave 1 of the Enterprise Completion Plan's "next 10" batch.

## Context
§7.1 (Recommended domain boundaries) prohibits shared-database access across domain ownership
except for "documented transitional read models," and requires cross-domain changes to travel
through versioned events/APIs otherwise. §5 (Canonical operating model) restates the same
requirement specifically for apps/api reading apps/crm-owned tables, and offers the same two
completion paths: (a) a documented, versioned read-model exception, or (b) a real internal API
call through apps/crm.

The vision doc names one confirmed instance: `apps/api/src/services/cro-summary.service.ts`
directly querying `companies`/`contacts`/`deals`/`activities`/`tasks`, with its own code comment
already acknowledging this as a deliberate Phase-1 shortcut. Both §5 and §7.1 also ask for an
audit of the rest of the codebase for the same pattern.

## Decision
Option (a) — documented exception — for all confirmed instances in this pass, not option (b).
Rewriting nine call sites to go through a real internal HTTP API into apps/crm is a materially
larger, higher-risk change (added latency on synchronous paths, new failure modes, a new internal
auth story between services) than is appropriate to take on inside this batch, and several of
these call sites (BullMQ workers, the CRO Copilot chat tool) are latency- or transaction-sensitive
in ways an HTTP round-trip would directly hurt. Formalizing the exception is the honest, low-risk
completion path the doc itself allows, and satisfies its own stated criterion: "One known,
self-documented violation; formalizing or fixing it closes this section's gap almost entirely."

`cro-summary.service.ts` received the full formal exception comment block (owning service, tables
named, reason, review trigger) since the vision doc names it explicitly.

## Audit: confirmed instances (beyond the one the vision doc names)
Found via `grep` for direct `.from()`/`.insert()`/`.update()` calls against apps/crm-owned tables
(`companies`, `contacts`, `deals`, `activities`, `tasks`, `pipelines`, `pipelineStages`,
`meetings`) inside `apps/api/src`, filtered to real query-level usage (not incidental word
matches). All read AND write directly against these tables from apps/api — a wider blast radius
than the read-only `cro-summary.service.ts` case.

| File | Tables touched | Read/write |
|---|---|---|
| `apps/api/src/services/cro-summary.service.ts` | companies, contacts, deals, activities, tasks | read |
| `apps/api/src/workers/sequence-enrollment.worker.ts` | tasks, contacts | read + write |
| `apps/api/src/workers/reminder-sweep.worker.ts` | tasks | read |
| `apps/api/src/routes/ai.routes.ts` | tasks, contacts | read + write |
| `apps/api/src/routes/call.routes.ts` | contacts, companies, activities, tasks | read + write |
| `apps/api/src/services/tam.service.ts` | deals | read |
| `apps/api/src/services/next-best-action.service.ts` | contacts, deals, companies, activities, tasks | read |
| `apps/api/src/services/reply-tag-actions.service.ts` | tasks | write |
| `apps/api/src/services/enrichment-autofill.service.ts` | contacts, companies | read + write |

## Consequences
- None of these 9 files were modified in this pass beyond this audit — no behavior change, no
  risk to the working paths above.
- This table is now the canonical list for the next architecture review: each row is a candidate
  either for its own formal exception comment (cheap, safe) or for migration onto a real internal
  API once one exists (Wave 2, larger effort, tracked in ADR 0002's Wave 2 list alongside the
  apps/crm dual-write item).
- Recommended next step (not done here): a lightweight PR-template checklist item — matching §1's
  own proposed check — flagging any new direct query against an apps/crm-owned table from
  apps/api, so this list doesn't grow silently.

## Wave 2 (explicitly deferred, not implied done)
Replacing any of the 9 audited call sites with a real internal API call through apps/crm, and
adding the same formal exception comment block to each in the meantime if they're not migrated
first.
