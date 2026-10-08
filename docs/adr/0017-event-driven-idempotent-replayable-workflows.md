# ADR 0017: Workflow automation is event-driven with idempotency and replay

## Status
Proposed — author Sahil, reviewer Aditya (epic open question 7 answered 2026-10-06).
Transport decided 2026-10-06 by Aditya (epic open question 2): Postgres outbox with a BullMQ relay
on the existing Redis. No new infrastructure.

## Context
Onboarding, follow-up sequences, provisioning and ticket escalation all react to state changes.
Bible v2 Part VIII requires that a DB commit and its event publish cannot diverge, that consumers
are idempotent, and that failures can be replayed. Broker delivery is at-least-once, so exactly-once
business effects must come from idempotent actions.

## Decision
1. Important state changes publish immutable domain events in the same database transaction as the
   state change, via a Postgres outbox table. A relay worker reads unpublished rows and publishes
   them through the existing `skout-dexter-event` BullMQ queue on Redis; it does not create a
   second broker or event queue.
2. Consumers are idempotent: each records processed event IDs and ignores duplicates.
3. Failed deliveries retry with backoff and then move to a dead-letter store.
4. Any event range or single event can be replayed by ID or range, and replay must be safe under
   the idempotency rules above.
5. Event envelope fields follow Bible Appendix A (see `packages/shared/src/copos-events.ts`).

## Consequences
- Killing the process between commit and publish must not lose or duplicate an effect (COPS-01
  acceptance criterion).
- Every consumer needs a processed-event table or equivalent.
- The existing CRM deal service emits `OpportunityQualified` transactionally when a deal enters
  its `Qualified` pipeline stage. Its existing `opportunity.updated` event remains unchanged and
  continues to serve current Dexter consumers.
- No new broker is introduced in Phase 1. Relay throughput and lag are monitored (Bible p.89).
