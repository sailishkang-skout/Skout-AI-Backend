# Runbook: CustomerOps engineering tickets (COPS-06)

Covers engineering tickets, their comments and visibility, escalation and the CRM ticket summary.
Contract: `docs/api/copos-06-tickets.openapi.yaml`. Audit and decisions: `docs/tickets/copos-06-audit.md`.

Permissions: `tickets:read` sees the queue and a ticket, `tickets:write` works it, `tickets:send`
publishes a customer-facing update. A rep with `crm:write` can raise a ticket from an account.

## A ticket will not move to the status I want (409 BUSINESS_STATE_CONFLICT)

Tickets follow one state machine (`TICKET_TRANSITIONS` in `packages/shared/src/cops-tickets.ts`):

```
new -> triage -> assigned -> in_progress -> testing -> waiting_on_customer -> resolved -> verified -> closed
```

with these ways back: triage from assigned or waiting on customer; assigned from in progress;
in progress from testing, waiting on customer, resolved (the customer rejected the fix) or
verified. `new` and `triage` can be closed directly.

- The API answers 409 with `details.from` and `details.to` for any other move. Move through the
  steps in between instead; each step is recorded in `ticket_status_history` with actor and reason.
- **Closed is final.** A closed ticket cannot be reopened. Raise a new ticket from the account and
  mention the old ticket id in the description.
- Never update `engineering_tickets.status` by hand: the history, the CRM summary and the
  `TicketResolved` event are only written by the transition service.

## The account's open ticket count or severity looks wrong

The account summary (`ticket_account_summaries`: open count, highest severity) is recomputed
inside the same transaction as every create, transition and escalation. A wrong value means a
ticket was changed outside the service.

- Check, for one account:

  ```sql
  select count(*) as open_now, s.open_count as summary
  from engineering_tickets t
  join ticket_account_summaries s on s.workspace_id = t.workspace_id and s.account_id = t.account_id
  where t.workspace_id = '<workspace>' and t.account_id = '<account>'
    and t.status in ('new','triage','assigned','in_progress','testing','waiting_on_customer')
  group by s.open_count;
  ```

- Fix: make any audited change through the API on one of the account's open tickets (for example
  `PATCH /tickets/{id}` with the same assignee). The service recomputes the summary from the
  tickets. Do not edit `ticket_account_summaries` by hand.

## A customer update went out that should have been internal

Customer-facing comments are visible in the customer-safe view
(`GET /tickets/{id}/customer-view`), which feeds AI summaries for customers too.

1. Change the comment's visibility to internal:
   `PATCH /tickets/{id}/comments/{commentId}/visibility { "visibility": "internal", "reason": "..." }`.
   It needs `tickets:write` and a reason, and it is audited (making a comment customer-facing
   needs `tickets:send` too).
2. The comment disappears from the customer-safe view and from AI summary inputs at once.
3. If the customer already read it (for example in an email they got), tell the account owner;
   the visibility change does not recall anything already sent.

Internal comments are never part of the customer-safe view or its AI inputs. If one ever shows
there, treat it as a security incident (tenant or visibility leak), not a ticket fix.

## Escalating a ticket

`POST /tickets/{id}/escalate { "severity": "high" | "critical", "reason": "..." }`.

- Escalation only raises the severity, never lowers it, needs a reason, and only works on an open
  ticket (409 otherwise).
- It emits `TicketEscalated`. If the workspace turned on "stop on critical escalation"
  (`PUT /onboarding/settings`), a `critical` escalation stops the account's onboarding follow-up
  (see `cops-onboarding.md`).
- To lower a severity that was raised by mistake, there is no API: note it on the ticket and
  ask an admin. Severity drives the account summary and SLA work later (COPS-12).

## A ticket was raised on the wrong account

Tickets cannot be moved between accounts (the summary, the timeline and the account link were
written for the original account). Close the wrong ticket with a reason (`triage` or `new` can be
closed directly; later statuses go through `resolved` and `verified`), and raise a new one on the
right account.

## Events and the timeline

Ticket changes write `TicketCreated`, `TicketEscalated` and `TicketResolved` to the outbox in the
same transaction. If the account timeline is missing a ticket event, follow
"1. Outbox lag or stuck relay" in `cops-platform.md`; the relay retries and the timeline
projector is idempotent.
