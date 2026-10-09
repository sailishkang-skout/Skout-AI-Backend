# ADR 0013: Skout Internal CRM is canonical for CustomerOps

## Status
Proposed — pending Aditya review. Author: open (epic open question 7).

## Context
CustomerOps spans sales, onboarding, commercial, CS and engineering. If an external CRM were the
system of record, Skout workflows would stop working whenever that CRM is missing, slow or
misconfigured. Bible v2 Part I and Part III state the internal CRM is canonical.

## Decision
1. Every CustomerOps business object (account, contact, opportunity, task, activity, proposal,
   contract, ticket, timeline event) has an immutable Skout ID and is tenant-scoped.
2. External provider IDs are stored as references (`external_references`), never as primary keys.
3. Skout workflows read and write the internal model only. They never depend on an external CRM
   being connected.
4. External CRM data reaches Skout via sync (see ADR 0014), which writes to Skout first.

## Consequences
- CRM works with no external CRM connected (master acceptance criterion).
- Sync code must map external objects onto Skout IDs; it cannot change the schema for them.
- Merge and conflict handling must preserve external references and history.
