# Skout CRM Service

Native Revenue Workspace API (companies, contacts, deals, activities) on the shared PostgreSQL data layer.

## Stack

- **Runtime:** Node 20 + TypeScript (Fastify 5)
- **Auth:** Clerk JWT (same as `@skout/api`) via `@skout/auth`
- **Database:** `@skout/db` (Drizzle + shared RDS)

## Local development

```bash
# From repo root (Postgres on :5434 via docker-compose)
pnpm --filter @skout/crm dev
```

Service listens on **http://localhost:3002**.

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/v1/crm/health` | Public |
| GET/POST | `/api/v1/companies` | Required |
| GET/PATCH/DELETE | `/api/v1/companies/:id` | Required |
| GET/POST | `/api/v1/contacts` | Required |
| GET/PATCH/DELETE | `/api/v1/contacts/:id` | Required |
| GET/POST | `/api/v1/pipelines` | Required |
| POST | `/api/v1/pipelines/:id/stages` | Required |
| GET/POST | `/api/v1/deals` | Required |
| GET | `/api/v1/deals/summary` | Required |
| GET/PATCH/DELETE | `/api/v1/deals/:id` | Required |
| GET/POST | `/api/v1/tasks` | Required |
| PATCH/DELETE | `/api/v1/tasks/:id` | Required |
| POST | `/api/v1/tasks/:id/complete` | Required |
| GET/POST | `/api/v1/activities` | Required |

Every workspace gets a default "Sales Pipeline" (stages: New → Qualified → Proposal → Negotiation → Closed Won/Lost), auto-created lazily on first `GET /pipelines` or the first `POST /deals` that omits `pipelineId`/`stageId`. Moving a deal to a different `stageId` via `PATCH /deals/:id` automatically logs a `stage_change` entry on `GET /activities?entityType=deal&entityId=...` — this is the "unified activity timeline" for a record.

Stub auth in dev: header `x-stub-user-email: you@example.com`.

## Tests

```bash
pnpm --filter @skout/crm test
pnpm --filter @skout/crm test:e2e
```

## Manual API testing (Postman)

Import `postman/Skout-CRM.postman_collection.json` and `postman/Skout-CRM.postman_environment.json` into Postman (or run headless with `newman run apps/crm/postman/Skout-CRM.postman_collection.json -e apps/crm/postman/Skout-CRM.postman_environment.json`). It exercises the full golden path — health → companies → contacts → pipelines (default auto-seed) → deals → stage change → activities → tasks — plus 404/cross-workspace-isolation checks, chaining IDs between requests automatically. Change the `stubEmail` variable to simulate a different workspace.

## Docker

```bash
docker build -f apps/crm/Dockerfile -t skout-crm:local .
```

Deployed to ECS as `crm` service with ALB paths `/api/v1/companies*`, `/api/v1/contacts*`, `/api/v1/deals*`, `/api/v1/crm/health`.
