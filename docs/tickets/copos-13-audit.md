# COPS-13 audit: analytics, role dashboards, AI recommendations, Phase 2 gates

Bible p.59, 83, 87-88 (with p.7, 61, 86, 90, 98-100, Appendix I); Epic E15/E17. Size XXL, P2. Audit
date 2026-10-21. Branch `feature/copos-13-analytics-ai`, from `feature/copos-12-ticket-sla` with
`feature/copos-11-customer-success` (and so COPS-10) merged in. COPS-13 reads the COPS-11 health
fields and the COPS-12 SLA clocks, so it merges after #204, #209 and #210.

## 1. What the Bible and the ticket ask for

**Analytics model (p.87).**
- Canonical event names with versioned properties.
- The operational DB is separate from the analytics warehouse as scale grows.
- Funnel cohorts: qualified → commercial → provisioned → first login → activated → paid/renewed.
- Metric definitions live in a shared catalog.

**KPI dashboards (p.88, p.7).**

| Dashboard | KPIs |
|---|---|
| Sales | pipeline, follow-up completion, trial conversion |
| CS | activation, health, renewal, risk |
| Engineering | SLA, MTTR, incidents |
| Finance | payment status, subscription revenue, overdue |
| Leadership | ARR/MRR, conversion, activation, retention, critical risk |

**Executive dashboard (p.59).** ARR/MRR, pipeline, active trials, activation, renewal exposure, open
critical escalations, workflow failures. Filters by segment, owner, geography and period.
Drill-through from a KPI to the accounts and events under it.

**AI recommendation engine (p.83, p.61, p.86).**
- Inputs: CRM state, timeline, onboarding progress, product usage, tickets, commercial state,
  playbooks.
- Output: recommendation type, rationale, evidence references, suggested action, confidence.
- No autonomous change to price, contract, payment or customer-facing escalation without human
  approval.
- Prompt, model and version metadata are stored for evaluation, without secrets.
- AI retrieval respects the same tenant and role boundaries as the UI.
- Customer 360 right rail shows AI recommendations.

**Phase 2 gates (p.90, p.98, Appendix I).** Golden paths added: external CRM conflict, e-sign delay,
SLA breach, renewal. Replay tested. Runbooks: repair sync mapping, resolve duplicate merge, recover
expired OAuth connector.

**Acceptance.**
- Every leadership KPI traces to source events; drill-through counts match the headline numbers.
- Red-team tests: cross-tenant and internal-note leakage into AI output fail; every recommendation
  links evidence.

## 2. What exists

| Piece | Where | Use in COPS-13 |
|---|---|---|
| Domain event outbox with the validated envelope (event_id, type, tenant, aggregate, occurred_at, actor, correlation) | `schema/cops-outbox.ts`, `packages/shared/src/copos-events.ts` | **The source of truth for event KPIs and the funnel.** Every funnel stage is an outbox event, so a KPI can list the event ids it counted. |
| Canonical client analytics catalog (`cops.*` names, `schema_version`, ids/enums only) and PostHog provider | FE `src/lib/cops-analytics.ts`, `components/posthog-provider.tsx` | Kept as the UI funnel. COPS-13 adds the server-side catalog and the event → analytics name map next to it. |
| `POSTHOG_API_KEY`, `POSTHOG_HOST`, `POSTHOG_PROJECT_ID` in the API env | `apps/api/src/config/env.ts` | The warehouse feed's first sink: the server sends the outbox events to PostHog's batch capture, so the operational DB is not the analytics store. |
| Workspace dashboards: `/dashboard/summary`, `/dashboard/funnel`, `/analytics/report`, `/cro/summary`, report schedules, forecasts | `routes/dashboard.routes.ts`, `analytics.routes.ts`, `cro.routes.ts`, `report.routes.ts` | These are the GTM (prospecting) dashboards. They stay as they are. CustomerOps dashboards are new routes under `/cops/dashboards`, so the two do not mix. |
| Next-best-action suggestions (contact/deal), prompt, OpenRouter call, `next_best_action_suggestions` with acceptance | `next-best-action.service.ts`, `schema/next-best-action.ts` | **Extended, not replaced.** Account-level recommendations are rows in the same table with new columns (status, type, evidence refs, suggested action, confidence, model/prompt pins, decision). |
| `pinAiClaim`: evidence-ledger write plus the active model and prompt version, fail-closed | `ai-evidence.service.ts`, `model-versions.service.ts`, `schema/model-versions.ts` | Every recommendation is pinned through it; no recommendation is stored without an evidence id. |
| Decision views (approve or dismiss an NBA) | `decision-workflow.service.ts`, `schema/dexter-platform.ts` | Not reused for the rail: decision views are workspace-level decisions without an action payload. The rail's approve executes one allow-listed action. |
| Health score, renewal risk, CSM, playbooks (COPS-11); renewal exposure query | `cops-health.service.ts`, `cops-playbooks.service.ts`, `cops-success-overview.service.ts` | CS dashboard KPIs, and recommendation inputs and actions (start a playbook). |
| SLA clocks, ticket metrics, incidents (COPS-12) | `cops-sla.service.ts`, `cops-ticket-metrics.service.ts` | Engineering dashboard KPIs (reused, not recomputed), open critical escalations. |
| Subscriptions and items (per unit per month, minor units), invoices, finance queue (COPS-08) | `schema/cops-commercial.ts`, `cops-finance.service.ts` | ARR/MRR, subscription revenue, overdue. |
| Workflow runs (COPS-10) | `schema/automations.ts` | Workflow failures KPI. |
| Golden paths for Phase 1 (COPS-07), runbooks folder | `apps/api/src/routes/cops-golden-paths.routes.test.ts`, `docs/runbooks/*` | Phase 2 golden paths go in a sibling test file; the three runbooks are added to the folder. |
| Account segment from employee count (`segmentOf`), `companies.location`, `companies.owner_id` | `cops-onboarding-templates.ts`, `schema/crm.ts` | The dashboard filters: segment, geography (location text) and owner. |
| RBAC verbs and resources incl. `analytics` | `packages/shared/src/cops-rbac.ts`, `packages/db/src/cops-role-grants.ts` | Dashboards need `analytics:read`; each KPI also needs the read permission of its own resource. |

Missing:
- a metric-definition catalog shared by API and FE;
- funnel cohorts;
- a warehouse feed;
- role dashboard APIs with filters and drill-through;
- account-level recommendations with evidence, confidence, approval and execution;
- the Phase 2 golden paths and three runbooks;
- the executive and role dashboard screens and the 360 recommendation rail.

## 3. Design

### 3.1 Metric catalog (`packages/shared/src/cops-metrics.ts`)

One entry per KPI:
- `id` (stable, e.g. `leadership.arr`), `version`, `label`, `definition` (plain sentence), `unit`
  (count, money, percent, minutes);
- `resource` (the RBAC resource whose read permission it needs);
- `source`: `events` (counted from named outbox event types) or `state` (counted from current
  records, each linked to the last outbox event for it);
- `drill`: `accounts` or `events`.

Every dashboard response carries, per KPI, `metric_id`, `metric_version` and the `window`
(`from`, `to`). Changing a definition bumps its version.

### 3.2 Funnel cohorts

A cohort is the accounts whose first `OpportunityQualified` falls in a period (month). For each
cohort the funnel counts the accounts that reached each later stage, using the first event per
account:

| Stage | Outbox event |
|---|---|
| qualified | `OpportunityQualified` |
| commercial | `ProposalSent` or `ContractSent` |
| provisioned | `WorkspaceProvisioned` |
| first login | `FirstLogin` |
| activated | `CustomerActivated` |
| paid | `PaymentSucceeded` |
| renewed | `RenewalOpened` followed by a paid term |

Events that name an opportunity map to the account through the deal's account.

### 3.3 Traceability and drill-through

One query function per KPI returns the rows (account or event). The headline number is
`rows.length` (or the sum of a column) of that same function. The drill-through endpoint pages
through those rows with the same filters. So the headline and the drill-through cannot disagree;
a test asserts this for every leadership KPI.

Each drill row carries `source_event_ids`: the outbox events behind it.

### 3.4 Filters

- `segment`: the account tier (smb / mid_market / enterprise), from the employee count as
  `segmentOf` does.
- `owner`: the account owner.
- `geo`: a case-insensitive match on `companies.location`. There is no structured country field
  today; see question 6.
- `period`: `from`/`to`, defaulting to the last 30 days.

State KPIs are "as of now"; event KPIs count events in the window.

### 3.5 Warehouse feed

A worker reads published outbox events after a checkpoint (`cops_analytics_feed_checkpoints`, one
row per sink) and sends them to the sink in batches.
- The first sink is PostHog batch capture, reusing the existing PostHog project.
- Each event becomes the canonical analytics name (`cops.server.<event>`) with `schema_version`,
  the tenant as a group, and payload ids and enums only. Free text is dropped.
- With no `POSTHOG_API_KEY` the feed is off and the checkpoint does not move.
- The feed is idempotent: PostHog dedupes on `uuid` = `event_id`.

### 3.6 Recommendations

**Candidates.** Rules over structured data produce the candidates, so every recommendation has
evidence by construction. Examples:
- renewal within 90 days and health at risk;
- trial ending, not activated;
- ticket-heavy account;
- SLA breached on an open P1/P2;
- payment past due;
- expansion signal;
- stalled onboarding milestone.

Each candidate carries `evidence_refs`: a list of `{kind, id, label}` pointing at real records
(health score, ticket, subscription, milestone, timeline event).

**Rationale.** The LLM (OpenRouter, `AI_MODEL`, as NBA) writes the rationale from a context built
only from data the caller may see:
- tenant-scoped;
- customer-safe ticket comments only, never internal notes;
- no commercial data unless the caller has `commercial:read`.

The model's answer must cite evidence ids that are in the context. Any other id fails validation
and the candidate is dropped, not shown. With no LLM key, the rationale is the rule's own template
(`source: rules`), still with the evidence.

**Confidence.** The rule's own confidence (e.g. how far health is below the threshold), not the
model's.

**Pinning.** `pinAiClaim` writes the evidence ledger row and the model and prompt version ids.
The table stores `input_hash` (a hash of the context), not the prompt text.

**Approval.**
- A recommendation is `pending` until a person approves or dismisses it.
- Dismiss needs a reason.
- Approve runs one allow-listed action: create a task, start a COPS-11 playbook, or open a
  renewal-prep task for the owner.
- Price, contract, payment and customer emails are never actions; at most they become a task for a
  person.
- Approve needs `crm:write`, and `commercial:write` for commercial types.
- Every decision is audited and timeline-visible.

### 3.7 Phase 2 golden paths

DB-backed tests, like the Phase 1 golden paths:
- external CRM conflict (manual-review policy blocks the overwrite until resolved);
- e-sign delay (out-of-order webhooks converge, the gate fires once);
- SLA breach (the sweep warns, breaches once, the dashboard counts it);
- renewal (one renewal opportunity per term, the renewal KPI drills to it).

Plus a replay test per path: replaying the events changes nothing.

### 3.8 Runbooks

`docs/runbooks/`: repair sync mapping, resolve duplicate merge, recover expired OAuth connector.

## 4. Questions for Aditya

1. **Warehouse.** Is PostHog the warehouse for now (the feed is built behind a sink interface), or
   is a real warehouse such as BigQuery planned? If so, which, and who owns its credentials?
2. **Currency.** Leadership money KPIs are grouped by currency with no FX conversion. Is that
   right, or is there a reporting currency and rate source?
3. **Recommendation actions.** Approve can create a task, start a playbook or open a renewal-prep
   task. Is that the right allowlist? Nothing customer-facing is executed.
4. **LLM use.** The LLM only writes the rationale for rule-based candidates; it does not invent
   recommendations. Is that the intended scope for Phase 2, with free-form recommendations left to
   COPS-14 agents?
5. **Executive access.** The executive dashboard needs `analytics:read`, and the money KPIs also
   need `commercial:read` or `billing:read` (they show as restricted otherwise). Engineering and
   Product have `analytics:read` but not commercial, so they see the executive page with ARR/MRR
   restricted. Is that the intended split?
6. **Geography.** Accounts only have a free-text `location`. The geo filter matches on it for now.
   Should COPS-13 add a structured `country` (ISO code) to accounts, filled from enrichment?
