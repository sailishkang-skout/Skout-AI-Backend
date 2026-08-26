# apps/api ↔ apps/crm internal contract (§5, §7.1)

Both services share one Postgres today. **Transitional read-model exceptions** are documented in ADR 0003.

## Owned domains

| Domain | Owning service | Primary tables |
|---|---|---|
| CRM entities | `apps/crm` | `contacts`, `companies`, `deals`, `pipelines`, `activities`, `tasks`, `meetings` |
| Sequences / enrichment / AI | `apps/api` | `sequences`, `prospect_*`, `evidence_ledger`, … |

## Allowed cross-service access (Wave 1)
Direct SQL from `apps/api` into CRM tables **only** when:
1. Listed in ADR 0003 audit table, and
2. Comment block cites owning service + review date.

## Wave 2 contract (shipped 2026-08-26)

Internal HTTP API on `apps/crm` (service token auth):

```
GET  /internal/v1/contacts/:id
GET  /internal/v1/contacts/by-prospect/:prospectId
GET  /internal/v1/companies/:id
GET  /internal/v1/deals/:id/summary
```

Auth headers:
- `X-Internal-Service-Token` — must match `INTERNAL_SERVICE_TOKEN` on CRM
- `X-Workspace-Id` — tenant scope

API client: `apps/api/src/services/crm-internal.client.ts`  
Env: `CRM_INTERNAL_BASE_URL` + `INTERNAL_SERVICE_TOKEN`

**Proof migration:** enrichment autofill contact lookup prefers internal HTTP when configured; writes remain direct SQL (ADR 0003 exception).

## Governance
New cross-service table access requires architecture reviewer sign-off (PR template §1 gate).
