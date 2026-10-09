# ADR 0014: External CRM sync is opt-in per workspace/account

## Status
Proposed — pending Aditya review. Author: open (epic open question 7).

## Context
Customers run different CRMs (Salesforce, HubSpot, Pipedrive, Zoho, Dynamics). Syncing everything
by default would change customer data without consent and would make sync failures visible to users
who never asked for sync. Bible v2 Part III requires sync to be per-connector, configurable and
observable.

## Decision
1. Sync is off by default. A workspace or account must explicitly connect and enable a connector.
2. Each connector defines object mappings, field mappings, ownership direction, transforms and scope
   (ADR 0013 applies: Skout wins the internal record).
3. Conflicts follow a field-level policy: Skout wins, external wins, most-recent wins, or manual
   review. Manual-review conflicts block overwrite until resolved.
4. Connector health (auth status, last sync, backlog, failed records, rate-limit state) is observable.

## Consequences
- Connect and disconnect must never corrupt internal records.
- Opt-in means the connector framework (COPS-09) is not a dependency for COPS-01 through COPS-07.
- Phase 1 has no sync; this ADR constrains the design only.
