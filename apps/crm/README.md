# Skout CRM Service

Native Revenue Workspace API (companies, contacts, deals, meetings, tasks, activities, dashboard) on the shared PostgreSQL data layer.

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
| GET/POST | `/api/v1/meetings` | Required |
| GET/PATCH | `/api/v1/meetings/:id` | Required |
| DELETE | `/api/v1/meetings/:id` | Required — `owner`/`admin` role only |
| GET | `/api/v1/dashboard/overview` | Required |

Every workspace gets a default "Sales Pipeline" (stages: New → Qualified → Proposal → Negotiation → Closed Won/Lost), auto-created lazily on first `GET /pipelines` or the first `POST /deals` that omits `pipelineId`/`stageId`. Moving a deal to a different `stageId` via `PATCH /deals/:id` automatically logs a `stage_change` entry on `GET /activities?entityType=deal&entityId=...` — this is the "unified activity timeline" for a record. Creating a meeting linked to a contact/company/deal logs a `meeting` activity on that entity's timeline the same way.

**Role-based permissions**: every `DELETE` endpoint (companies, contacts, deals, tasks, meetings) requires the requester's `workspace_members.role` (populated onto `request.role` by the auth plugin) to be `owner` or `admin` — a `member` gets `403 forbidden`. Role values (`owner` | `admin` | `member`) and their assignment are owned by `apps/api`'s team invite flow (`team.routes.ts` / `team.service.ts`, `workspace_invites` table) — that's the only place `workspace_members.role` is ever set to `admin`/`member` today; this service only reads it. There's no invite acceptance path exercised in this repo's e2e tests, so the "role-based permissions" cases in `src/e2e/crm.e2e.test.ts` insert a `workspace_members` row directly to simulate a non-owner.

**Dashboard**: `GET /dashboard/overview` returns company/contact counts, open deal count + pipeline value (same numbers as `/deals/summary`), open/overdue task counts, upcoming meeting count, and the 5 most recent activities workspace-wide.

Stub auth in dev: header `x-stub-user-email: you@example.com`.

## Tests

```bash
pnpm --filter @skout/crm test
pnpm --filter @skout/crm test:e2e
```

## Manual API testing (Postman)

Import `postman/Skout-CRM.postman_collection.json` and `postman/Skout-CRM.postman_environment.json` into Postman (or run headless with `newman run apps/crm/postman/Skout-CRM.postman_collection.json -e apps/crm/postman/Skout-CRM.postman_environment.json`). It exercises the full golden path — health → companies → contacts → pipelines (default auto-seed) → deals → stage change → activities → tasks → meetings → dashboard — plus 404/cross-workspace-isolation checks, chaining IDs between requests automatically. Change the `stubEmail` variable to simulate a different workspace.

## Docker

```bash
docker build -f apps/crm/Dockerfile -t skout-crm:local .
```

Deployed to ECS as `crm` service. ALB routing is two listener rules on the same target group (a single AWS path-pattern condition caps at 5 values), defined in `infra/lib/stacks/compute-stack.ts`:
- Priority 5: `/api/v1/crm/health`, `/api/v1/companies*`, `/api/v1/contacts*`, `/api/v1/deals*`, `/api/v1/pipelines*`
- Priority 6 (overflow): `/api/v1/tasks*`, `/api/v1/activities*`, `/api/v1/meetings*`, `/api/v1/dashboard*`

Both are ahead of the main API's `/api/*` catch-all (priority 10). **Adding a new top-level route prefix to this service requires adding it to one of these two pathPatterns lists (or a third rule, if both are ever full) — otherwise it 404s in every deployed environment despite working locally.**
