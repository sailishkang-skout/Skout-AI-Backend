# Runbook: ticket SLA, incidents and release tracking (COPS-12)

Contract: `docs/api/copos-12-ticket-sla.openapi.yaml`. Audit and design:
`docs/tickets/copos-12-audit.md`. Ticket basics: `docs/runbooks/cops-tickets.md`.

## How the SLA works

- **Policy.** The admin config kind `sla_policy` (key `default`) holds the policy. It is
  versioned and audited like every COPS-07 config.
  - Targets per priority: response and resolution minutes, and the calendar (`24x7` or
    `business`). Defaults: P1 15m/4h 24x7, P2 1h/1BD, P3 4h/3BD, P4 1BD/5BD.
  - Optional tier overrides.
  - The business-hours calendar: timezone, days, hours, holidays.
  - Pause statuses (`waiting_on_customer`) and the at-risk ratio (0.75).
- **Clocks.** Every ticket gets two clocks in `sla_clocks` when it is created: `response` and
  `resolution`.
  - **Response** is met by the first move out of new/triage or the first customer-visible
    comment. This also stamps `first_response_at`.
  - **Pause.** A pause status stops both clocks; leaving it resumes them.
  - **Resolution** is met on `resolved`. A reopen resumes it; `closed` stops what is left.
  - **Priority change.** The clocks are re-targeted, and the time already used is kept.
- **Escalation.** The COPS evaluator tick (every 10 minutes) runs `runSlaSweep`.
  - At risk: an in-app notification to the assignee and Engineering, once per clock.
  - Breach: `breached_at` is set, the assignee, Engineering and CS are notified, and
    `TicketSlaBreached` is emitted, once per clock.
  - Open tickets without clocks are backfilled.

The clock math is in `packages/shared/src/cops-sla.ts`, and its tests cover weekends, holidays,
timezones and DST.

## "The SLA due time looks wrong"

1. Read the clocks: `GET /api/v1/tickets/:id/sla`. `used_minutes` is calendar time used. `due_at`
   is null while paused.
2. Check the calendar of the policy version the clock uses (`policy_version`). Business time only
   counts the calendar's working hours in its timezone. A Friday-evening P2 is due Monday.
3. Check the status history: the time spent in a pause status is not counted.
4. Never edit `sla_clocks` by hand. To change targets for future tickets, save a new
   `sla_policy` version. To change one ticket's targets, change its priority.

## "A ticket has no SLA"

The sweep backfills any open ticket without clocks on its next tick. The query below must return
0 for P1/P2 (acceptance: 100% tracked):

```sql
select count(*) from engineering_tickets t
where t.priority in ('p1','p2') and t.status not in ('resolved','verified','closed')
  and not exists (select 1 from sla_clocks c where c.ticket_id = t.id);
```

If it stays above 0, the evaluator worker is not running (it needs Redis). Look for "sla sweep
failed" in the worker logs.

## "Nobody was warned before the breach"

- `at_risk_notified_at` is set once a warning goes out.
- A clock that jumps straight past the target between two ticks (for example a P1 response of 15
  minutes while the worker was down) goes to breach with no warning. That is expected: the breach
  notification still goes out.
- Recipients are the assignee and the members holding the Engineering role (plus CS for
  breaches). A workspace with nobody in those roles gets no notification.

## Verified is refused (422 VERIFICATION_REQUIRED)

A ticket needs QA and customer verification evidence before `verified`. Record them with
`PATCH /api/v1/tickets/:id/release` (`qa_evidence`, `customer_evidence`). The server stamps who
and when. A reopen (`resolved`/`verified` → `in_progress`) needs a reason (422
REASON_REQUIRED). It clears both verifications and counts in `reopen_count`; the status history
keeps the earlier ones.

## Incidents

- **One home per ticket.** A ticket links to one incident. Linking it elsewhere answers 409
  TICKET_ALREADY_LINKED: unlink it first.
- **One investigation owner.** Linking assigns the ticket to the incident owner, and changing the
  owner (`PATCH /incidents/:id`) reassigns every linked ticket.
- **Customer updates.** `POST /incidents/:id/customer-update` needs `tickets:send`. It posts a
  customer-visible comment on every linked ticket that is not closed. Internal investigation
  notes stay on the incident; never paste them into a customer update.

## Metrics

`GET /api/v1/tickets/metrics?days=30` returns each metric with its definition. MTTA and MTTR
are wall-clock means. SLA attainment is the breach rate, which uses business time per the policy.
