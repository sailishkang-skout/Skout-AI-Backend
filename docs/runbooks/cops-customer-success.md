# Runbook: CustomerOps customer success (COPS-11)

Covers the account health score, its signals and the five success playbooks.
Contract: `docs/api/copos-11-customer-success.openapi.yaml`. Audit and design:
`docs/tickets/copos-11-audit.md`. Playbooks run on the workflow engine, so
`docs/runbooks/cops-workflows.md` applies to their runs.

## How a score is made

- `computeHealth` (`apps/api/src/services/cops-health.service.ts`) scores five dimensions. Each
  starts at 100 and loses the points of its factors. The overall score is the weighted mean.
- States: healthy at `thresholds.healthy` or more (default 70), at risk below `thresholds.atRisk`
  (default 40), otherwise watch.
- Every computation is a row in `cops_health_scores` with its factors and the model version used.
  The account's `health_score`, `health_state`, `renewal_risk` and `health_computed_at` mirror the
  latest row.
- The retention signals sweep recomputes every customer account and every account in onboarding
  (`RETENTION_SIGNALS_SWEEP_INTERVAL_HOURS`). Recompute one account with
  `POST /api/v1/accounts/:id/health/recompute`.

## "Why is this account at risk?"

Open Customer 360 → Health "why?" (the drawer) or the Success tab. Every factor with negative
points is a reason. To check from the database:

```sql
select score, state, factors, model_version, computed_at
from cops_health_scores where workspace_id = $1 and account_id = $2
order by computed_at desc limit 1;
```

If a factor looks wrong, check its source: onboarding (`cops_onboarding_instances`), activities on
the account and its contacts, `engineering_tickets`, `subscriptions`, failed or expired
`payment_requests` in 90 days, and credit consumption of the customer's workspace.

## A score never appears / is stale

- `health_computed_at` is null: the account is not a customer and has no onboarding, so the sweep
  skips it. Recompute it by hand, or set `companies.status = 'customer'` through the CRM.
- Stale for every account: the retention sweep worker is not running (it needs Redis). Check the
  `retention-signals-sweep` worker logs for "health sweep failed".
- One account failing is logged as "health computation failed for an account" and never stops the
  others.

## The health state did not move straight from healthy to at risk

By design. The health lifecycle only allows healthy ↔ watch ↔ at risk, so a big drop is recorded
as two `LifecycleTransitioned` events (to watch, then at risk) with `source = health_model`.

## Changing the model

`PUT /api/v1/customer-success/model` (workspace:manage) saves a new version in
`cops_health_models` and audits `health_model.updated`. New scores use it; old scores keep the
version they were computed with. To go back, save the previous values as a new version. Never edit
or delete `cops_health_models` rows.

## A playbook did not run

1. Is it installed and active? `GET /api/v1/customer-success/playbooks`. Install with
   `POST /customer-success/playbooks/install` (workspace:manage). Installing again is a no-op.
2. Was the signal raised? Look for the event:
   ```sql
   select created_at, envelope->'payload' from cops_outbox
   where tenant_id = $1 and event_type = 'HealthSignalDetected' and aggregate_id = $2
   order by created_at desc;
   ```
   Signals are one per account, signal and cycle (the event id is derived from them). The cycle is
   the calendar month, or the renewal date for renewal_approaching. A signal already raised this
   cycle is not raised again, so the playbook does not enroll twice. That is the duplicate-safety
   rule, not a bug.
3. Did the workflow engine pick it up? The run appears in the workflow's run history with trigger
   `event:<event_id>`. If the event is there but no run: see "nothing runs" in
   `cops-workflows.md` (the automation-run sweep dispatches events).
4. The task went to the wrong person: CS playbooks assign to the account's CSM, else the owner.
   Expansion goes to the owner (Sales). Set the CSM with `PUT /api/v1/accounts/:id/csm`.

## Playbook runs on the timeline

A run about an account writes a `workflow` activity when it starts, completes or is cancelled
(`recordPlaybookTimeline`). This is best effort: a missing entry is logged as "playbook timeline
entry failed" and never fails the run. The run history in the workflow builder stays the
authoritative record.

## Alerts

- Workflow failures for playbook runs use the COPS-10 workflow failure alert.
- Watch for repeated "health sweep failed" log lines; a sweep that fails every interval means
  scores go stale.
