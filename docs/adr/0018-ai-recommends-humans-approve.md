# ADR 0018: AI outputs that change commercial terms, tickets or external communication require permissioned review

## Status
Proposed — pending Aditya review. Author: open (epic open question 7).

## Context
AI recommendations (next best action, health explanations, ticket summaries) can be useful but are
not reliable enough to act on commercial terms, payments, customer-facing escalations or outbound
messages. Bible v2 Part I ("AI recommends, humans approve") and Part VIII state this explicitly.

## Decision
1. AI produces recommendations with type, rationale, evidence references, suggested action and
   confidence. It does not execute actions by itself.
2. Any AI output that would change price, contract terms, payment state, a customer-facing ticket
   update, or outbound communication requires a permissioned human approval before it takes effect.
3. AI retrieval uses the same tenant and role boundaries as the primary UI. Internal-only content is
   excluded from AI inputs for customer-safe outputs (COPS-06 acceptance criterion).
4. Model, prompt and version metadata are stored for evaluation, without secrets.

## Consequences
- The approval flow is a shared capability used by COPS-08 (approvals), COPS-06 (customer updates)
  and COPS-13 (AI recommendations).
- No AI feature ships in Phase 1 without this gate.
- Audit covers every approval decision (actor, time, comment).
