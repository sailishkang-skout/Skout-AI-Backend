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
| `apps/api/src/services/enrichment-autofill.service.ts` | contacts, companies | read + write (contact read may use `/internal/v1`) |

## Wave 2 additions (2026-08-26)

| File | Tables touched | Read/write |
|---|---|---|
| `apps/api/src/services/identity-merge-apply.service.ts` | companies, contacts, deals | read + write |
| `apps/api/src/services/crm-hubspot-native-sync.service.ts` | contacts, companies | read + write |
| `apps/api/src/workers/identity-merge-discovery.worker.ts` | companies, contacts | read |

Internal CRM HTTP surface shipped (`docs/api-crm-internal-contract.md`). Enrichment autofill is the proof read path; remaining rows stay documented exceptions until migrated.

## Update (Task 17 — Enterprise Completion Plan "close everything" pass)
All 9 confirmed instances now carry the formal exception comment block at their top (matching
the shape `cro-summary.service.ts` already had), stating tables touched, owning service, reason,
and review trigger.

## Wave 2 status (2026-08-26)
Internal API + one proof read path shipped. Full migration of BullMQ/transactional writers to HTTP
remains deferred (latency/tx risk). Remaining rows keep exception comments.

## Wave 3 additions (2026-09-04)

| File | Tables touched | Read/write |
|---|---|---|
| `apps/api/src/services/forecast.service.ts` | deals, pipelineStages | read |

`forecast.service.ts`'s addition (§8.15 SS-03 forecast uncertainty band + data-gaps) is a
synchronous read on the existing forecast-detail request path — same latency rationale as
`cro-summary.service.ts`, which this file already calls into for its model-forecast figure.

(A pending, not-yet-merged PR for SS-02's `retention-signals-sweep.worker.ts` also adds a Wave 3
row here — expect a small merge-order conflict on this section, resolved by keeping both rows,
whichever PR lands second.)
| `apps/api/src/workers/retention-signals-sweep.worker.ts` | companies, deals, contacts, activities, meetings | read |

Same rationale as `reminder-sweep.worker.ts`/`risk-decay-sweep.worker.ts`: a periodic BullMQ sweep
(§8.12 CRM Intelligence retention signals, SS-02) — HTTP round trips per workspace per sweep tick
would add latency/failure modes for a read-only scan. Carries the formal exception comment block
at its top, matching this ADR's template.
