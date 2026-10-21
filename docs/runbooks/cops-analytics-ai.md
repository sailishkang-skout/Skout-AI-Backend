# Runbook: analytics, role dashboards and AI recommendations (COPS-13)

## How it works

- **Metric catalog** (`packages/shared/src/cops-metrics.ts`): every KPI has an id, a version, a
  plain definition, the RBAC resource it needs and the outbox events it traces to.
  `GET /api/v1/cops/metrics/catalog` returns it.
- **Dashboards**: `GET /api/v1/cops/dashboards/:dashboard` for `leadership`, `sales`, `cs`,
  `engineering` and `finance`, with `from`, `to` (default the last 30 days), `segment`, `owner` and
  `geo`. Every KPI names its `metric_id`, `metric_version` and `window`. A KPI whose resource the
  caller cannot read comes back `restricted: true` with no value.
- **Drill-through**: `GET /api/v1/cops/dashboards/kpis/:metricId/drill` returns the same rows the KPI
  was computed from (paged), each with the outbox events behind it (`source_event_ids`). The
  headline is computed from these rows only, so the two cannot disagree.
- **Funnel**: `GET /api/v1/cops/funnel`: accounts first qualified per month and how many reached
  each stage, from the outbox events.
- **Warehouse feed**: every 10 minutes the onboarding evaluator worker sends published outbox events
  to PostHog's batch capture (`POSTHOG_API_KEY`, `POSTHOG_HOST`). One checkpoint per sink in
  `cops_analytics_feed_checkpoints`. Only ids, enums and numbers are sent; free text never is.
  `GET /api/v1/cops/analytics/feed` (analytics:admin) shows whether it is on and how many of the
  workspace's events are behind.
- **Recommendations**: `POST /api/v1/accounts/:id/recommendations/generate` builds candidates from
  rules over the account's data (each with evidence), asks the model (OpenRouter, `AI_MODEL`) for
  the rationale only, and stores them `pending` in `next_best_action_suggestions`
  (`entity_type = 'account'`). Nothing runs until a person approves; approve runs one allow-listed
  action (a task, or an installed COPS-11 playbook); dismiss needs a reason.

## "A KPI looks wrong"

1. Read the metric's definition in the catalog: it says exactly what is counted and in which window.
   State KPIs (ARR, pipeline, at-risk accounts) are as of now; event KPIs (activation, payments,
   SLA breaches) count events in the window.
2. Open the drill-through with the same filters. Each row names its record and its source events.
   Check the record and the events in `cops_outbox` (`id = any(source_event_ids)`).
3. Money is per currency (`by_currency`); a KPI over several currencies has no single `value`.
   There is no FX conversion.
4. Pipeline amounts come from `deals.amount` (major units) times 100.

## "The feed is not sending"

1. `GET /api/v1/cops/analytics/feed`: `enabled: false` means `POSTHOG_API_KEY` (the project API key,
   `phc_…`) is not set in this environment. It lives in the encrypted environment file only.
2. `last_error` shows PostHog's answer to the last batch. A refused batch is sent again on the next
   tick; the checkpoint only moves when PostHog accepted it.
3. A resend is safe: each event's PostHog `uuid` is its `event_id`, and PostHog drops duplicates.
4. After an outbox replay (`POST /api/v1/cops/events/replay`), replayed events are published again
   and so sent again with the same uuid; PostHog keeps one.

## "A recommendation is missing or wrong"

- Generate needs the account's data the caller can read. Without `commercial:read` no renewal
  recommendation is built; without `tickets:read` no ticket ones.
- A rule fires once per evidence: while a recommendation for the same subscription, ticket or signal
  is pending, generating again adds nothing. Pending ones expire after 14 days.
- `source: rules` means the model's answer was refused (it cited evidence it was not given, or was
  not valid JSON) or no model is configured (`OPENROUTER_API_KEY`). The rationale is then the rule's
  own wording, still with the evidence.
- The prompt is never stored; `input_hash` identifies it. The evidence-ledger row
  (`evidence_id`) holds what was claimed, with the model and prompt version ids.
- Internal ticket notes never enter the context; only customer-visible updates do. If an internal
  note's text ever shows in a recommendation, treat it as a security incident.

## "Approve did nothing"

- A playbook action starts the installed COPS-11 playbook as a manual run with the account as
  subject (`effect.kind = workflow_run`). If the playbook is not installed, approve creates the
  playbook's task instead (`effect.fallback = playbook_not_installed`). Install the success
  playbooks from the Customer Success screen.
- A second approve or dismiss is refused (409): a recommendation is decided once.
- Every decision writes a `recommendation.approved` or `recommendation.dismissed` audit row and a
  timeline entry on the account.
