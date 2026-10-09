# CustomerOps platform runbooks (COPS-01)

Written for: on-call engineers and Sales/CS pilot leads. Covers the outbox relay, idempotency
store, audit log and notification delivery. Source of truth for behaviour: ADR 0017 and
`packages/shared/src/cops-*.ts`.

## Alert thresholds (to wire into the alerting system)

| Signal | Source | Page when | Ticket when |
|---|---|---|---|
| Outbox lag | `cops_outbox` rows with `published_at is null` and `dead_lettered_at is null`, oldest `created_at` | oldest pending > 5 min | oldest pending > 1 min for 15 min |
| Dead-lettered events | `cops_outbox.dead_lettered_at is not null` | any new row in 10 min | any row older than 1 h unreplayed |
| Relay pass failures | log line `cops-outbox relay pass failed` | 3 consecutive | any |
| Notification delivery failures | Existing notification-service delivery logs/metrics | > 10% of deliveries in 15 min | any sustained |
| Webhook latency | span `cops.notify.webhook` | p95 > 5 s | p95 > 2 s |

Alerts fire on customer-impacting patterns, not on single transient retries (Bible p.89).

## 1. Outbox lag or stuck relay

1. Check the relay worker is running: `cops-outbox relay pass` log lines appear every second when
   rows are due. It publishes into the existing `skout-dexter-event` queue; there is no separate
   COPS event queue.
2. Check Redis: the worker is disabled (with a warning log) if Redis is not configured.
3. Check `cops_outbox` for the oldest unpublished row and its `last_error`.
4. If the error is a transient Redis or BullMQ error, the row retries with backoff up to 8
   attempts. Do nothing else.
5. If the relay is down, restart the API service. Pending rows are picked up on the next pass;
   nothing is lost because the row is written in the same transaction as the state change.

## 2. Replay dead-lettered events

Dead-lettered rows stay in `cops_outbox` with `dead_lettered_at` set. Use the audited replay endpoint
(requires `admin:admin`, a valid `Idempotency-Key`, and a reason of at least eight characters):

1. Find the event id and fix the underlying cause (usually a consumer bug or an invalid downstream payload).
2. `POST /api/v1/cops/events/replay` with `{ "event_ids": ["<event_id>"], "reason": "..." }`.
   To replay by time range, provide `from`, `to`, and `reason` instead.
3. The endpoint resets relay state and writes an audit row in the same transaction. The relay
   publishes it with `jobId = event_id`. If the consumer already processed it, the
   idempotent consumer (`cops_processed_events`) skips it. Replays never create a duplicate effect.
   The current CRM integration writes `OpportunityQualified` when a deal enters the Qualified
   pipeline stage; the existing `opportunity.updated` event and its consumers are unchanged.

Lifecycle changes use `POST /api/v1/cops/lifecycle/{dimension}/{entityId}/transitions` with an
`Idempotency-Key`, target state, source, and reason. The state row, existing `audit_logs` row, and
`LifecycleTransitioned` outbox envelope commit together. Disallowed transitions return 409.

## 3. Re-send a notification safely

Notifications are not replayed from the outbox. To re-send:

1. Confirm the original delivery failed (failed list in the delivery log).
2. Re-run the delivery for that channel and user only. Do not re-run the whole rule set, or
   other recipients get a duplicate.
3. Record a manual audit row with `override = true` and a reason. The audit validator rejects an
   override without a reason.

## 4. Correct a state change

State transitions are never edited in place. Record a new transition with a reason, for example
`onboarding: blocked -> in_progress` with `reason = "integration fixed by CS"`. The transition
table rejects illegal moves with `BUSINESS_STATE_CONFLICT` (409).

## 5. Idempotency key problems

- `VALIDATION_FAILED` on `Idempotency-Key`: key is missing or not 8 to 128 characters.
- `IDEMPOTENCY_KEY_REUSED` (422): the same key was sent with a different body. Ask the client to
  generate a new key for a new request. Do not clear the stored row.
- Stored outcomes expire after 24 hours. After that the same key is treated as new.

## 6. Audit log access

`GET /api/v1/cops/audit` requires `admin:read`. It reads from the existing `audit_logs` table,
scoped to the authenticated workspace. Audit rows are append-only by convention; never run
UPDATE or DELETE on audit rows from application code. A correction is a new row that references
the original in its `reason`.

## Open items

- Dashboards and alert wiring are described above but are not yet connected to the alerting system.
