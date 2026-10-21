# COPS-12 audit: ticket SLA, incident linking, release tracking

Bible p.52, 54-56, 65; Epic E13. Size XL, P2. Extends COPS-06. Audit date 2026-10-21. Branch
`feature/copos-12-ticket-sla`, from `develop`. COPS-12 does not depend on COPS-10 or COPS-11.

## 1. What the Bible and the ticket ask for

**SLA (p.52).**
- Severity and customer tier decide the SLA policy.
- Pause rules for waiting on customer are explicit.
- SLA risk is escalated before the breach.

Indicative targets:

| Priority | Response | Target |
|---|---|---|
| P1 Critical | 15 min | 4 hours / incident-based |
| P2 High | 1 hour | 1 business day |
| P3 Medium | 4 hours | 3 business days |
| P4 Low | 1 business day | 5+ business days |

**Incidents (p.54).**
- Tickets link to an incident or problem record.
- Customer-safe incident updates propagate to the linked tickets.
- An incident tracks affected customers, severity, start and end, workaround, root cause and
  follow-ups.
- One investigation for all the linked tickets, with each customer's communication kept.

**Release and resolution (p.55).**
- A ticket links to a code or release identifier.
- It records fixed-in version, deployed-at, QA verification and customer verification.
- Reopening needs a reason and keeps the history.

**Engineering dashboard (p.56, p.65).**
- Queue by severity, SLA risk, product area, account tier and assignee.
- Metrics: open, aged, MTTA, MTTR, reopen rate, breach rate, incident-linked tickets.
- Customer context inline.
- An SLA clock and breach-risk highlighting in the queue and in the drawer.

**Acceptance.**
- Clock math is tested across pause and resume, weekends and timezones.
- 100% of P1/P2 tickets have a tracked SLA.
- A ticket cannot reach Verified without verification evidence.
- Linked tickets share one investigation owner.

## 2. What exists

| Piece | Where | Use |
|---|---|---|
| Tickets: priority p1-p4, severity, account_tier (smb / mid_market / enterprise, from employee count), status machine, status history with reason, audit | `packages/db/src/schema/cops-tickets.ts`, `packages/shared/src/cops-tickets.ts`, `cops-tickets.service.ts` | The SLA keys on priority and tier. The clock reacts to status changes in `transitionTicket`. |
| Reopen: resolved/verified → in_progress | `TICKET_TRANSITIONS` | Allowed already, but the reason is optional. COPS-12 makes it required for a reopen. |
| `incidents` table (title, severity, status open/investigating/resolved, source, detected/resolved, notes) and `POST`/`GET /incidents` | `schema/incidents.ts`, `routes/incidents.routes.ts` | Extended as the ticket asks, not replaced. |
| Versioned, audited admin config (COPS-07), kinds such as `approval_policy` and `dunning_policy` | `packages/shared/src/cops-admin-config.ts` | The SLA policy and business-hours calendar become a new kind, `sla_policy`. That is config over code, and editable in the admin screen. |
| In-app notifications with dedupe and role recipients | `crm-alerts.service.ts`, `getCopsNotificationRecipients` | At-risk and breach escalation. |
| Engineering queue, ticket drawer, account Engineering tab | FE `app/(dashboard)/engineering`, `components/crm/tickets/*` | Get the SLA chip, the incident link, the release fields and a dashboard. |

Missing:
- SLA policy, clocks and breach tracking;
- incident links and incident fields;
- release and verification fields, and the verification gate;
- metrics;
- the FE for all of the above.

## 3. Design

**SLA policy (`sla_policy` config kind, versioned).**
- Targets per priority: response minutes and resolution minutes, with the Bible's defaults.
- Optional per-tier overrides, for example enterprise P2 at half the target.
- Calendar per priority: `24x7` or `business`.
  - Default: P1 runs 24x7 (incident-based). P2 to P4 run on business hours.
- A business-hours calendar:
  - timezone (an IANA name, default `UTC`), working days (Mon to Fri), start and end time
    (09:00 to 18:00), and holidays (dates).
- Pause statuses: `waiting_on_customer`. The clock stops there and resumes when the ticket leaves.
- At-risk threshold: 75% of the target used.

**Clocks (`sla_clocks`).**
- Two per ticket: `response` and `resolution`.
- Each clock records:
  - target minutes, calendar and policy version;
  - started_at, due_at, paused_at and business minutes used while running;
  - met_at, breached_at, at_risk_notified_at.
- Started on ticket creation for every priority. So 100% of P1/P2 tickets are tracked, and a test
  asserts it.
- Response is met by the first move out of `new`/`triage` or by the first customer-visible
  comment, whichever is first.
- Resolution is met on `resolved`. It restarts on a reopen; the earlier time stays in history.
- Changing priority or severity recomputes the target from the policy, keeping the time already
  used.

**Clock math, pure, in `packages/shared`.**
- `addBusinessMinutes(start, minutes, calendar)` and `businessMinutesBetween(a, b, calendar)`.
- They walk working intervals in the calendar's timezone, using `Intl` (no new dependency), so DST
  and weekends are handled. Holidays are skipped.
- Tested with:
  - pause and resume;
  - a Friday evening start;
  - weekends and holidays;
  - a DST change (America/New_York, Europe/London);
  - a non-UTC calendar.

**Escalation.** A sweep, joined to the existing COPS sweep worker, runs every few minutes:
- At risk: an in-app notification to the assignee and the engineering leads, once per clock.
- Breach: sets breached_at, notifies, and emits `TicketSlaBreached`, deduped.

**Incidents (extends `incidents`).**
- New columns:
  - started_at and ended_at;
  - workaround and root_cause;
  - follow_ups (a jsonb list of {text, done});
  - owner_id, the investigation owner;
  - customer_update and its timestamp.
- `incident_ticket_links (workspace_id, incident_id, ticket_id)`, with one incident per ticket.
- Linking sets the ticket's assignee to the incident owner, and changing the owner updates every
  linked ticket. That is "one investigation owner".
- Affected customers are derived from the linked tickets' accounts.
- Publishing a customer-safe incident update adds a customer-visible comment to every linked
  ticket. It needs `tickets:send`, as customer comments do today. Internal notes stay on the
  incident.

**Release and verification (ticket columns).**
- release_id, fixed_in_version and deployed_at.
- qa_verified_at/by with qa_evidence.
- customer_verified_at/by with customer_evidence.
- Moving to `verified` needs QA evidence and customer verification. Otherwise the API answers 422
  with the missing fields.
- A reopen (`resolved`/`verified` → `in_progress`) needs a reason, and clears the verification and
  the resolution clock's met_at. The history keeps both.

**Metrics (`GET /tickets/metrics`).**
- Counts: open, and aged (open longer than 7 days).
- MTTA: creation to first response.
- MTTR: creation to resolved.
- Rates: reopen rate, breach rate (clocks breached / clocks finished).
- Incident-linked count.
- Filters: period, tier, team. Each metric names its definition, ready for COPS-13.

## 4. Plan (small commits)

1. OpenAPI contract `docs/api/copos-12-ticket-sla.openapi.yaml`. Contract first, as the DoD asks.
2. Clock math in `packages/shared`, with tests.
3. Migration:
   - `sla_clocks`;
   - `incident_ticket_links`;
   - the incident columns;
   - the ticket release and verification columns;
   - the `sla_policy` config kind and its defaults.
4. SLA service: start, pause and resume, meet, recompute; hooks in create, transition, comment and
   update; Postgres tests.
5. The at-risk and breach sweep with notifications, and the `TicketSlaBreached` event.
6. Incidents: CRUD, link and unlink, owner propagation, customer update propagation.
7. Release and verification fields; the Verified gate; the reopen reason.
8. Metrics API.
9. FE:
   - SLA chip and risk highlight in the queue and drawer;
   - release and verification panel;
   - incident page and link UI;
   - Engineering dashboard.
10. Runbook, analytics events and e2e.

## 5. Questions for Aditya

1. Business hours: Mon to Fri 09:00 to 18:00. In which timezone by default (workspace setting,
   or Asia/Kolkata)? Any holiday calendar?
2. P1 runs 24x7, and P2 to P4 on business hours. OK?
3. Tier overrides: should enterprise get tighter targets than the Bible's table? Proposal: no
   overrides by default; the admin can add them.
4. First response = the first move out of triage, or the first customer-visible comment. OK?
5. "Aged" = open longer than 7 days?

Migration note: COPS-10 and COPS-11 (unmerged) use 0134 to 0138. COPS-12 starts at 0139, and its
journal entries are rebased once those merge.
