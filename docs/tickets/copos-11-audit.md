# COPS-11 audit: customer success health model and playbooks

Bible p.46, 49-50, 66; Epic E12. Size XL, P2. Audit date 2026-10-20. Branch
`feature/copos-11-customer-success`, from the COPS-10 branch: the playbooks run on the COPS-10
workflow engine, which is not merged yet.

## 1. What the Bible asks for

**Health model (p.49).** "Health combines product adoption, relationship, support, commercial,
and payment signals."
- Dimensions are transparent and configurable.
- No opaque AI-only score; show the contributing factors.
- Tell lagging outcomes apart from actionable leading signals.
- Keep score history for trend.

**Health states (lifecycle table).** Healthy, Watch, At risk. The account carries `health_score`,
`csm_id` and `renewal_risk`.

**Success playbooks (p.50).** Playbooks turn health signals into accountable action:

| Playbook | What it does |
|---|---|
| Newly activated | Value confirmation and an adoption plan |
| Low adoption | Use-case review and education |
| Ticket-heavy account | Technical success review |
| Renewal approaching | Outcomes review, stakeholders, commercial prep |
| Expansion signal | Routed to the sales owner, with evidence |

**Customer Success screen (p.66).**
- Health distribution, renewal exposure, adoption milestones, at-risk list and expansion signals.
- Each account row shows the reason for the risk and the next action.
- Playbook enrollment is visible and auditable.

**Handoff (p.47).** CS becomes the primary owner on a rule (activation, payment, tier); Sales
keeps visibility for expansion and renewal.

## 2. What exists

| Piece | Where | Use in COPS-11 |
|---|---|---|
| Health lifecycle: healthy → watch → at_risk (stepwise; healthy cannot jump to at_risk) | `packages/shared/src/cops-lifecycle.ts`, `runLifecycleTransition` | The health state. Each transition emits `LifecycleTransitioned` (dimension `health`). |
| Retention signals: disengagement (no activity in N days), renewal risk (won deal ending in N days with no recent positive signal), expansion (customer account with a new hiring or funding signal) | `workers/retention-signals-sweep.worker.ts` | Reused as factors (relationship, commercial) and as the expansion playbook's evidence. No second detector. |
| Activation model and milestones (COPS-05) | `cops-activation.service.ts` | Adoption factors: activation %, first login, first value. |
| Engineering tickets (COPS-06) | `engineering_tickets` | Support factors: open tickets, highest severity, tickets in 90 days. |
| Payment requests (COPS-03) and subscription status (COPS-08) | `payment_requests`, subscriptions | Payment factors: overdue or failed requests, past due or restricted. |
| Credits ledger (COPS-04) | `credit_transactions` | Adoption factor: usage trend (30 days against the previous 30). |
| Activities and the COPS-02 timeline contract | `activities` + `ActivityRecorded` (`cops-follow-up-timeline.ts`) | How playbook runs reach the account timeline. |
| Workflow engine (COPS-10) | `automations`, `automation-triggers.service.ts` | Playbooks are workflows: event triggers, one run per event, stop events, create-task action, run history. |
| Customer 360 "Success" tab placeholder | `cops-customer-360.tsx` | Gets the health score and factor breakdown. |

Missing:
- any health score, its factors or history;
- `health_score`, `renewal_risk` and `csm_id` on the account;
- a CS screen;
- the five playbooks;
- a way for a playbook run to show on the timeline.

## 3. Design

**Model, configurable per workspace.** Defaults ship in code, like the COPS-05 activation model;
a workspace can change weights, thresholds and which factors count. Each change is a new version,
and is audited.

Default factors (L = leading, actionable; G = lagging, outcome):

| Dimension | Factors |
|---|---|
| Adoption | activation % (G); days since last login (L); credits used, last 30 days against the 30 before (L) |
| Relationship | days since last activity (L); meetings in 30 days (L); contacts engaged (G) |
| Support | open tickets (L); highest open severity (L); tickets in 90 days (G) |
| Commercial | days to renewal (L); renewal at risk, from the retention rule (L) |
| Payment | overdue or failed payment requests (L); subscription past due or restricted (G) |

**Score.**
- Each factor gives points with a stated reason, e.g. "2 open tickets, one high: −15".
- Each dimension scores 0 to 100; the overall score is the weighted mean.
- State: healthy ≥ 70, watch 40 to 69, at risk < 40. All configurable.

**Storage.**
- `cops_health_scores` keeps one row per computation (account, score, state, per-dimension scores,
  the factor list with value, points, leading or lagging, and reason, plus the model version and
  time), so trend and explanation come from the same row.
- The account gets `health_score`, `health_state`, `renewal_risk` and `csm_id` columns, as the
  Bible's field list asks (an ADR 0003 row, since `companies` is CRM-owned).

**State changes.** These go through `runLifecycleTransition`, so they are audited and emit
`LifecycleTransitioned` (dimension `health`). A move from healthy to at risk passes through watch,
as the lifecycle requires.

**When it runs.**
- A daily sweep of the workspace's customer accounts.
- On demand, from Customer 360.
- After the events that matter: TicketCreated, TicketEscalated, PaymentSucceeded,
  CustomerActivated.

**Playbooks on the engine.**
- Each playbook is a workflow, seeded per workspace from a template and editable in the builder.
- The health sweep emits a new COPS event, `HealthSignalDetected { account_id, signal, cycle,
  evidence }`, for low_adoption, ticket_heavy, renewal_approaching and expansion_signal.
  "Newly activated" listens to the existing `CustomerActivated`.
- Duplicate-safe per cycle:
  - the event id is deterministic from (account, signal, cycle), so the outbox primary key drops
    a repeat;
  - the engine's run key is `event:<event_id>`, so a repeat also never starts a second run;
  - cycles: renewal_approaching = the renewal date; others = the calendar month.
- Assignment:
  - CS playbooks assign their task to the account's CSM;
  - expansion assigns to the account owner (Sales) and carries the evidence (the signals) in the
    task and the run's trigger payload.
- Timeline: a playbook run about an account writes an activity ("Playbook <name> started",
  "… completed") with its `ActivityRecorded` event, through the COPS-02 timeline contract.
- Enrollment is auditable: the run history shows the trigger, conditions and each step.

## 4. Plan (small commits)

1. Migration: `cops_health_scores`, `cops_health_models`, and the account columns; the
   `HealthSignalDetected` event in the shared registry.
2. Scoring service: the factors from the existing sources, the explainable breakdown, the state
   via the lifecycle. Postgres tests: every score explains itself; history.
3. Sweep worker and the recompute route; signal events, once per cycle.
4. Playbook templates on the engine, the create-task assignee options (CSM, account owner), and
   timeline entries for playbook runs.
5. APIs:
   - `GET /accounts/:id/health`;
   - `GET /accounts/:id/health/history`;
   - `GET /customer-success/overview`;
   - `PUT /customer-success/model`;
   - `PUT /accounts/:id/csm`.
6. Frontend:
   - the Customer Success screen;
   - a health factor drawer on Customer 360's Success tab;
   - playbook enrollment lists.

## 5. Questions for Aditya

1. Default weights and thresholds: equal weights (20 each), healthy ≥ 70, at risk < 40. OK?
2. CSM: who sets `csm_id`? Proposal: the COPS-05 handoff task's assignee on activation, and
   editable on the account.
3. Expansion signal: the existing retention rule (a customer with a new hiring or funding signal)
   plus credit usage above 80% of the balance. Anything else?
4. Cycle for low adoption and ticket-heavy: once per calendar month per account. OK?
