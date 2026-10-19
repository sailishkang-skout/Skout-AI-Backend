# COPS-10 audit: workflow engine and admin workflow builder

Bible p.68, 74, Appendix H; Epic E10. Size XXL, P1. Audit date 2026-10-19.

The ticket asks for a versioned workflow engine (triggers, conditions, delays, actions), run
records, durable delays, exactly-once effects, cancellation, replay, builder APIs with
simulation and rollback, and a Workflow Builder UI.

**Finding: the engine already exists.** Workflow Studio (§8.14) has a graph engine with versions,
runs, steps, a worker, simulation and a canvas UI. COPS-10 should extend it, not build a second
engine. This audit lists what is there and what is missing.

## 1. What exists

Backend:
- Tables (`packages/db/src/schema/automations.ts`):
  - `automations`;
  - `automation_versions`: immutable published snapshots plus one draft, version 0;
  - `automation_runs`: trigger type, idempotency key, simulation flag, status;
  - `automation_run_steps`: one row per node execution, with input, output, error, attempt
    count and lease;
  - `automation_secrets`: encrypted, used by the HTTP node.
- Graph: nodes plus edges (`automation-graph.ts`). Condition edges carry a `true` or `false`
  branch.
- Node types (`automation-nodes/registry.ts`): trigger, condition, delay, HTTP, notification,
  CRM writeback, sequence enroll, AI, enrichment, CRM sync, approval (via the Policy Gateway).
- Worker (`automation-run.worker.ts`):
  - claims one step at a time through the shared execution-intent library (lease, heartbeat,
    reclaim sweep every 30s);
  - each step has a unique idempotency key, so a successor step is never created twice;
  - an ambiguous provider result goes to `outcome_unknown`, not a blind retry.
- Simulation: `POST /automations/:id/run` with `isSimulation` runs the draft. Every action node
  checks the flag and skips its side effect.
- In-flight runs keep the version they started on (`automation_version_id`).
- Retry: `POST /automations/runs/:runId/retry` resets failed steps; `outcome_unknown` steps are
  left for a human.
- Step input and output are masked for secrets before they are returned.

Frontend:
- `/workflows` list.
- `/workflows/[id]`: canvas, node config panel, save draft, simulate, publish, versions, runs,
  retry.

Related engines, not to be duplicated:
- activation rules (R13.4: score threshold to activate, list or enroll; max 5 per workspace);
- alert rules;
- the Policy Gateway;
- COPS-05 onboarding playbooks (`cops-onboarding-signals.service.ts`: the evaluator creates one
  task per trigger per instance);
- the COPS-01 transactional outbox (`cops_outbox`), which is the event source for triggers.

## 2. Gaps against the ticket

| # | Ticket asks for | Today | Gap |
|---|---|---|---|
| 1 | Durable delays across deploys; "restart mid-delay resumes and fires once" | The delay node returns at once and records the seconds | No real wait. Needs a wake-up time on the step, a step state that waits, a delayed job, and a sweep that resumes due steps after a restart. |
| 2 | Triggers: event, schedule, field/state change | Manual run and a public webhook only. The webhook is not signature-checked. | No event, schedule or field-change trigger. Events should come from `cops_outbox`. |
| 3 | Conditions: AND/OR groups, typed operands | One field, `equals`/`not_equals`, compared as strings, against an earlier step's output only | Needs condition groups, typed operators (number, date, boolean, contains, in, exists) and the trigger payload as an operand. Old configs must keep working. |
| 4 | Actions: create task, enroll sequence, notify, call integration, update allowed fields, create ticket, request approval | Enroll, notify, HTTP, CRM writeback and approval exist | Missing: create task, create ticket (COPS-06), update allowed fields with an allowlist. |
| 5 | Safe-action allowlist, no arbitrary code | `type` is any string at save time; config is not checked until the run | Validate every node type and its config when saving and publishing. The HTTP node calls any URL, so it needs a host allowlist or must be limited to admins. |
| 6 | Rollback without affecting in-flight runs | None | Add rollback that republishes version N as a new version. In-flight runs are already pinned to their version. |
| 7 | Permissions | Routes only check that the user is logged in. Any member can create, publish or run. | Add a permission check (see the open questions). |
| 8 | Run records: trigger, matched conditions, action states, retries, outputs | Steps hold input, output, attempts and error; conditions record `matches` | Store the trigger payload and the subject (account) on the run. |
| 9 | Run history per workflow, version or account | List per automation only | Add filters for version and account, plus paging. |
| 10 | Cancellation on stop conditions | None | Add a cancel route and stop conditions that end waiting runs, for example "account churned". |
| 11 | Replay tooling | Retry of failed steps only | Add replay of a whole run (a new run with the same trigger payload) and a way to resolve `outcome_unknown`. |
| 12 | Exactly-once effects | Steps are deduped; each action's idempotency is not checked | Check each action node; pass the step idempotency key to the side effect. |
| 13 | Approval | The run moves to `awaiting_approval` | Nothing resumes it after the approval is granted or denied. |
| 14 | Evaluate moving COPS-05 sequence logic onto the engine, no behaviour change | — | Evaluation only (section 4). |

Frontend gaps:
- a trigger selector for event, schedule and field change;
- AND/OR condition groups with typed operands;
- the new action steps;
- version history with rollback;
- run history filters;
- per-step status and replay;
- a forced simulate before activate.

## 3. Plan (small commits, one PR per repo)

1. Permissions and validation on save and publish: node-type allowlist, per-node config schema,
   HTTP host rule.
2. Durable delay: wake-up time on the step, a waiting state, a delayed job and a due-step sweep.
   Postgres test: restart mid-delay resumes and fires once.
3. Conditions v2: groups and typed operands, with the trigger payload in context. Old configs keep
   working.
4. Run records: trigger payload and subject on the run; history filters for version and account.
5. Rollback; cancel and stop conditions; approval resume; whole-run replay.
6. Triggers: schedule sweep, outbox event trigger, field and state change. Each delivery runs once
   (run idempotency key from the event id).
7. Actions: create task, create ticket, update allowed fields.
8. Frontend builder changes.
9. COPS-05 evaluation doc.

## 4. COPS-05 on the engine (to be evaluated in step 9)

Today, COPS-05 playbooks are code paths with their own dedupe: a unique signal row per instance
and trigger. Moving them onto the engine would make them editable, but every playbook would have
to produce the same tasks at the same times. The proposal is to evaluate this after steps 2 to 6
land, and to change nothing in this ticket unless the playbooks behave identically.

## 5. Open questions for Aditya

1. Phase rule: COPS-10 is Phase 2. Is it OK to start while the Phase 1 sign-off is open?
2. Permission: a new `automation:manage` key, or reuse `workspace:manage` (Owner, Admin)?
3. HTTP node: keep it with a per-workspace host allowlist, or limit it to Owner and Admin?
4. Event triggers: subscribe to `cops_outbox` events only, or to the Dexter spine events as well?
5. COPS-05: migrate the playbooks in this ticket, or only write the evaluation?
