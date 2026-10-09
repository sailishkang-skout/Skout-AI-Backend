# COPS-06 audit: engineering tickets (basic) and customer-safe visibility

Ticket: COPS-06, depends on COPS-01 and COPS-02. Bible p.51-53, 56-57, 65; Epic E13.
Branch: `feature/copos-06-eng-tickets` (from `develop`). Owner: SahilPreet. Reviewer: Aditya.

## What already exists

| Ticket need | Existing code | Use |
|---|---|---|
| Ticket events | `packages/shared/src/copos-events.ts`: `TicketCreated`, `TicketEscalated` (`ticket_id, account_id, severity`), `TicketResolved` | Reuse; emitted through the COPS-01 outbox. |
| Timeline | `services/cops-timeline.service.ts` projector; `cops-timeline.ts` already maps the three Ticket events to type `ticket` | Reuse; no new timeline code. |
| CRM summary state | Lifecycle `support` dimension (`no_issue`, `open_ticket`, `incident_impacted`), `runLifecycleTransition` | Reuse; ticket changes move `no_issue` and `open_ticket`. `incident_impacted` is left to COPS-12. |
| Permissions | `tickets:read/write/admin` keys and role grants (CS, Engineering, Product) | Reuse. One new grant: CS gets `tickets:send`. |
| Audit, idempotency, errors | `writeCopsAudit`, `withCopsIdempotentReply`, `copsErrorBody` | Reuse. |
| Account tier | `segmentOf(employee_count)` (COPS-05) | Reuse for the queue's tier filter. |
| Safe diagnostics source | COPS-05 onboarding instance and `loadIntegrations` | Reuse for the prefill. |
| Escalation consumer | COPS-05 `handleTicketEscalated` (stops the follow-up on a critical escalation when configured) | Now receives real events. |
| Incidents | `schema/incidents.ts`, `routes/incidents.routes.ts` | Not reused: operational incidents, no account, comments or visibility. COPS-12 extends it. |

## Gaps (new in this ticket)

1. Tables `engineering_tickets`, `ticket_comments` (visibility column with a CHECK), `ticket_status_history`, `ticket_account_summaries` (migration 0114).
2. State machine and visibility rules in `packages/shared/src/cops-tickets.ts`.
3. `services/cops-tickets.service.ts` and `routes/cops-tickets.routes.ts`.

## Rules

- **Visibility.** A comment is internal unless published. The customer-safe read paths
  (`customerSafeTicket`, `ticketSummaryInputs(..., "customer")`) select customer comments only and
  return no internal fields (repro steps, log refs, diagnostics, assignee, team).
- **Publishing.** A customer-visible comment, or a change from internal to customer, needs
  `tickets:send`. Every visibility change is audited with a reason.
- **AI summaries.** A summary records its source comments and takes their visibility: one internal
  source keeps it internal and it can never be published. This ticket builds the rule and the input
  path, not the model call.
- **Commercial and legal data.** The ticket's customer context returns account, contact,
  opportunity and milestone names only. No amount, stage, proposal, contract or payment.
- **Safe diagnostics.** Only allowlisted keys are stored; secret-like keys and values are dropped.
- **CRM summary.** Open count and max severity are rewritten in the ticket's transaction under the
  account lock.

## Open questions for Aditya

1. Who may publish customer updates? Built as `tickets:send`, granted to CS only. Engineering
   (`tickets:admin`) cannot publish. Existing workspaces get the grant from `backfill-rbac`.
2. Sales hold no ticket keys, so creating a ticket also accepts `crm:write`. Sales cannot open the
   engineering queue. Should they see the account Engineering tab (built: yes, through `crm:read`)?
3. Severity uses `low/medium/high/critical` (same as `incidents`). Priority is `p1` to `p4`.
4. The customer-safe view is an internal endpoint for now. The customer portal is not in this ticket.
5. Team is free text. Is there a fixed team list?
